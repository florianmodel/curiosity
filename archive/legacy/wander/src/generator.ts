import { runOpenClawAgent } from "./gateway.js";
import type { WanderManager } from "./manager.js";
import { parseGeneratedCandidates, renderGenerationPrompt, renderTerritorySummary } from "./prompts.js";
import { frontierRadius } from "./scoring.js";
import type { BoredomState, Candidate, ObservationRecord, TerritoryRecord } from "./types.js";

function summarizeObservation(observation: ObservationRecord): string {
  const label =
    observation.kind === "message_received"
      ? "user"
      : observation.kind === "tool_success" || observation.kind === "tool_failure"
        ? `tool:${observation.toolName ?? "unknown"}`
        : observation.kind;
  return `- [${label}] ${observation.content.slice(0, 160)}`;
}

export function buildActivitySummary(
  observations: ObservationRecord[],
  maxItems: number,
): string[] {
  return observations.slice(0, maxItems).map((observation) => summarizeObservation(observation));
}

/**
 * Grounded candidates derived from real observed needs: questions the user
 * asked that may still be open, and tool failures worth understanding. These
 * compete in the same scoring pass as LLM-generated candidates.
 */
export function buildGroundedCandidates(params: {
  observations: ObservationRecord[];
  unresolvedUserAsks: boolean;
  failedToolAttempts: boolean;
}): Candidate[] {
  const candidates: Candidate[] = [];
  if (params.unresolvedUserAsks) {
    for (const observation of params.observations
      .filter((item) => item.kind === "message_received")
      .slice(0, 8)) {
      const content = observation.content.trim();
      if (
        !/[?]/.test(content) &&
        !/^(please|can you|could you|check|look|find|review|investigate)/i.test(content)
      ) {
        continue;
      }
      candidates.push({
        origin: "unresolved_user_ask",
        topic: `Open user ask: ${content.slice(0, 90)}`,
        domain: "user-request",
        whyInteresting: "The user asked this and it may still be unresolved.",
        firstAction: "Check whether this ask was already answered; if not, investigate it with tools.",
        expectedArtifact: "A concrete answer, fix, or evidenced blocker for the user's ask.",
        expectedSurprise: 0.3,
        evidence: [content],
        estimatedCost: 350,
        risk: 0.15,
      });
    }
  }
  if (params.failedToolAttempts) {
    for (const observation of params.observations
      .filter((item) => item.kind === "tool_failure")
      .slice(0, 4)) {
      const toolName = observation.toolName ?? "tool";
      candidates.push({
        origin: "failed_tool_attempt",
        topic: `Recover from failed ${toolName} attempt`,
        domain: "tooling",
        whyInteresting: `A recent ${toolName} call failed; the cause is unknown.`,
        firstAction: `Reproduce the failing ${toolName} call in a minimal, low-risk way and read the error closely.`,
        expectedArtifact: "A diagnosis with evidence, and a fix or documented workaround if safe.",
        expectedSurprise: 0.45,
        evidence: [observation.content.slice(0, 300)],
        estimatedCost: 400,
        risk: 0.25,
      });
    }
  }
  return candidates;
}

export type GenerationResult = {
  candidates: Candidate[];
  llmCandidateCount: number;
  groundedCandidateCount: number;
  generationRunId: string | null;
  rawOutput?: string;
  error?: string;
};

/**
 * Ask the agent's own model to author candidate curiosities. What a model
 * chooses to be curious about is the research subject, so generation goes
 * through the same gateway agent rather than a fixed side model.
 */
export async function generateCandidates(params: {
  manager: WanderManager;
  agentId: string;
  gatewayUrl: string;
  boredom: BoredomState;
  observations: ObservationRecord[];
  territory: TerritoryRecord[];
}): Promise<GenerationResult> {
  const { manager, agentId } = params;
  const config = manager.getConfig();
  const grounded = buildGroundedCandidates({
    observations: params.observations,
    unresolvedUserAsks: config.grounded.unresolvedUserAsks,
    failedToolAttempts: config.grounded.failedToolAttempts,
  });

  const radius = frontierRadius(params.boredom.level, config);
  const prompt = renderGenerationPrompt({
    candidateCount: config.generation.candidateCount,
    boredomLevel: params.boredom.level,
    radius,
    activitySummary: buildActivitySummary(
      params.observations,
      config.generation.maxContextObservations,
    ),
    territorySummary: renderTerritorySummary(
      params.territory,
      config.generation.maxTerritorySummaryItems,
    ),
    allowExternalActions: config.actionPolicy.allowExternalActions,
  });

  const generationRunId = `wander-gen-${Date.now()}`;
  manager.markGenerationInFlight(agentId, generationRunId);
  const startedAt = Date.now();
  await manager.recordRunUsage({
    runId: generationRunId,
    agentId,
    trigger: "candidate-generation",
    kind: "generation",
    startedAt,
  });
  try {
    const result = await runOpenClawAgent({
      agentId,
      runId: generationRunId,
      message: prompt,
      timeoutSeconds: config.generation.timeoutSeconds,
      gatewayUrl: params.gatewayUrl,
    });
    const text = result.stdout || result.stderr;
    await manager.recordObservation({
      kind: "assistant_output",
      runId: generationRunId,
      agentId,
      success: result.exitCode === 0,
      content: text,
      metadata: { wanderGeneration: true },
    });
    const llmCandidates = result.exitCode === 0 ? parseGeneratedCandidates(text) : [];
    if (result.exitCode === 0 && llmCandidates.length === 0) {
      await manager.appendAuditEvent({
        eventType: "generation_parse_failed",
        runId: generationRunId,
        payload: { outputPreview: text.slice(0, 500) },
      });
    }
    return {
      candidates: [...llmCandidates, ...grounded],
      llmCandidateCount: llmCandidates.length,
      groundedCandidateCount: grounded.length,
      generationRunId,
      rawOutput: text,
      ...(result.exitCode !== 0 ? { error: result.stderr || "generation agent run failed" } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await manager.appendAuditEvent({
      eventType: "generation_failed",
      runId: generationRunId,
      payload: { error: message },
    });
    return {
      candidates: grounded,
      llmCandidateCount: 0,
      groundedCandidateCount: grounded.length,
      generationRunId,
      error: message,
    };
  } finally {
    manager.markGenerationInFlight(agentId, null);
    await manager.recordRunUsage({
      runId: generationRunId,
      agentId,
      trigger: "candidate-generation",
      kind: "generation",
      endedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    });
  }
}
