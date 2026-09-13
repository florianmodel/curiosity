import fs from "node:fs/promises";
import path from "node:path";
import { resolvePlaygroundDir } from "./config.js";
import { centroid } from "./embeddings.js";
import { generateCandidates } from "./generator.js";
import { extractAgentToolSummary, runOpenClawAgent } from "./gateway.js";
import type { WanderManager } from "./manager.js";
import {
  parseRunReport,
  renderRunPrompt,
  reportedNoSensingAffordance,
} from "./prompts.js";
import { candidateText, rankByCuriosity, scoreCandidate } from "./scoring.js";
import type {
  Candidate,
  CycleResult,
  GoalRecord,
  ObservationRecord,
  ScoreCard,
  TerritoryRecord,
} from "./types.js";

function clampOutput(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, 1000)}\n...[truncated]...\n${text.slice(-maxChars + 1018)}`;
}

function playgroundSlug(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "untitled";
}

/**
 * The self-context bundle is purely data-driven: recent meaningful activity
 * plus recently visited territory. The system's own operation shows up here
 * naturally through its observations, so self-reference pressure emerges from
 * data rather than from a hardcoded forbidden-topic list.
 */
async function buildSelfContext(params: {
  manager: WanderManager;
  observations: ObservationRecord[];
  territory: TerritoryRecord[];
}): Promise<{ vector: number[] | null; text: string }> {
  const { manager } = params;
  const recentTerritoryCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const texts = [
    ...params.observations.slice(0, 24).map((observation) => observation.content.slice(0, 500)),
    ...params.territory
      .filter((region) => region.lastVisitedAt >= recentTerritoryCutoff)
      .slice(0, 12)
      .map((region) => `${region.topic}. ${region.summary}`.slice(0, 500)),
  ].filter((text) => text.trim().length > 0);
  const combinedText = texts.join("\n");
  if (texts.length === 0) {
    return { vector: null, text: "" };
  }
  const embedder = await manager.embedder();
  const vectors = (await embedder.embed(texts)).filter(
    (vector): vector is number[] => vector !== null,
  );
  return { vector: centroid(vectors), text: combinedText };
}

export type ScoredCandidate = {
  candidate: Candidate;
  scores: ScoreCard;
};

export async function scoreCandidates(params: {
  manager: WanderManager;
  candidates: Candidate[];
  boredomLevel: number;
  observations: ObservationRecord[];
  territory: TerritoryRecord[];
}): Promise<ScoredCandidate[]> {
  const { manager } = params;
  const config = manager.getConfig();
  const selfContext = await buildSelfContext({
    manager,
    observations: params.observations,
    territory: params.territory,
  });
  const embedder = await manager.embedder();
  const vectors = await embedder.embed(params.candidates.map((candidate) => candidateText(candidate)));
  const recentGoalTopics = await manager.listRecentGoalTopics(20);
  return params.candidates.map((candidate, index) => ({
    candidate,
    scores: scoreCandidate(
      candidate,
      vectors[index],
      {
        boredomLevel: params.boredomLevel,
        selfContextVector: selfContext.vector,
        selfContextText: selfContext.text,
        territory: params.territory,
        recentGoalTopics,
      },
      config,
    ),
  }));
}

/**
 * One full wander cycle: check drive gates, generate candidates, score them,
 * pick one, run it, and fold the outcome back into the exploration map.
 */
export async function runWanderCycle(params: {
  manager: WanderManager;
  agentId: string;
  gatewayUrl: string;
  trigger: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<CycleResult> {
  const { manager, agentId } = params;
  const config = manager.getConfig();
  const now = Date.now();
  await manager.pruneRetention(now);

  const wake = await manager.shouldWake(now);
  if (!wake.shouldWake && params.force !== true) {
    await manager.appendAuditEvent({
      eventType: "cycle_skipped",
      payload: { reason: wake.reason, boredom: wake.boredom, budgetUsage: wake.budgetUsage },
    });
    return { ran: false, reason: wake.reason };
  }
  if (params.force === true && (await manager.isPaused())) {
    return { ran: false, reason: "paused" };
  }
  if (manager.isAutonomousWindow(agentId)) {
    return { ran: false, reason: "run_in_flight" };
  }
  await manager.markWakeRequested(now);

  const boredom = wake.boredom;
  const observations = await manager.listRecentMeaningfulObservations(60);
  const territory = await manager.listTerritory(200);

  // 1. Generate: the model authors candidates; grounded heuristics add real needs.
  const generation = await generateCandidates({
    manager,
    agentId,
    gatewayUrl: params.gatewayUrl,
    boredom,
    observations,
    territory,
  });
  if (generation.candidates.length === 0) {
    await manager.appendAuditEvent({
      eventType: "cycle_skipped",
      runId: generation.generationRunId ?? undefined,
      payload: { reason: "no_candidates", generationError: generation.error },
    });
    return { ran: false, reason: generation.error ? "generation_failed" : "no_candidates" };
  }

  // 2. Score and rank.
  const scored = await scoreCandidates({
    manager,
    candidates: generation.candidates,
    boredomLevel: boredom.level,
    observations,
    territory,
  });
  const ranked = rankByCuriosity(scored);

  // 3. Persist every candidate and log the negative space.
  const goals: Array<{ goal: GoalRecord; scores: ScoreCard }> = [];
  for (const entry of ranked) {
    const goal = await manager.upsertGoal({
      candidate: entry.candidate,
      scores: entry.scores,
      agentId,
      status: "queued",
      now,
    });
    goals.push({ goal, scores: entry.scores });
    await manager.appendAuditEvent({
      eventType: "candidate_scored",
      goalId: goal.goalId,
      runId: generation.generationRunId ?? undefined,
      payload: {
        topic: goal.topic,
        origin: goal.origin,
        domain: goal.domain,
        scores: entry.scores,
        boredom: boredom.level,
      },
    });
  }

  // 4. Select the best eligible candidate.
  let selected: { goal: GoalRecord; scores: ScoreCard } | null = null;
  const rejections: Array<{ goalId: string; topic: string; reason: string }> = [];
  for (const entry of goals) {
    if (entry.goal.status === "completed" || entry.goal.status === "failed") {
      rejections.push({
        goalId: entry.goal.goalId,
        topic: entry.goal.topic,
        reason: "already_terminal",
      });
      continue;
    }
    const retryBlock = manager.goalRetryBlocked(entry.goal, now);
    if (retryBlock) {
      rejections.push({ goalId: entry.goal.goalId, topic: entry.goal.topic, reason: retryBlock });
      continue;
    }
    if (entry.scores.curiosity_value < config.thresholds.act && params.force !== true) {
      rejections.push({
        goalId: entry.goal.goalId,
        topic: entry.goal.topic,
        reason: "below_threshold",
      });
      continue;
    }
    if (!selected) {
      selected = entry;
    } else {
      rejections.push({
        goalId: entry.goal.goalId,
        topic: entry.goal.topic,
        reason: "ranked_below_selected",
      });
    }
  }
  for (const rejection of rejections) {
    await manager.appendAuditEvent({
      eventType: "candidate_rejected",
      goalId: rejection.goalId,
      runId: generation.generationRunId ?? undefined,
      payload: { topic: rejection.topic, reason: rejection.reason },
    });
    await manager.markGoalRejected(rejection.goalId, now);
  }
  if (!selected) {
    await manager.appendAuditEvent({
      eventType: "cycle_skipped",
      runId: generation.generationRunId ?? undefined,
      payload: { reason: "no_candidate_above_threshold", candidateCount: goals.length },
    });
    return { ran: false, reason: "no_candidate_above_threshold" };
  }

  if (params.dryRun === true) {
    await manager.appendAuditEvent({
      eventType: "cycle_dry_run",
      goalId: selected.goal.goalId,
      payload: { topic: selected.goal.topic, scores: selected.scores },
    });
    return {
      ran: true,
      runId: "dry-run",
      goalId: selected.goal.goalId,
      topic: selected.goal.topic,
      success: true,
      sensingSteps: 0,
      report: null,
      candidateCount: goals.length,
    };
  }

  // 5. Execute the selected curiosity.
  const runId = `wander-run-${Date.now()}`;
  const playgroundRoot = resolvePlaygroundDir(manager.workspaceDir, config);
  const playgroundDir = path.join(
    playgroundRoot,
    `${new Date(now).toISOString().slice(0, 10)}-${playgroundSlug(selected.goal.topic)}`,
  );
  await fs.mkdir(playgroundDir, { recursive: true });
  await manager.markGoalSelected({ goalId: selected.goal.goalId, runId, agentId, now });
  manager.registerActiveRun({ runId, goalId: selected.goal.goalId, agentId, startedAt: now });
  await manager.recordRunUsage({
    runId,
    agentId,
    trigger: params.trigger,
    kind: "exploration",
    startedAt: now,
  });
  await manager.appendAuditEvent({
    eventType: "goal_selected",
    goalId: selected.goal.goalId,
    runId,
    payload: {
      topic: selected.goal.topic,
      origin: selected.goal.origin,
      scores: selected.scores,
      threshold: config.thresholds.act,
      candidateCount: goals.length,
      playgroundDir,
    },
  });

  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let runError: string | undefined;
  try {
    const goal = (await manager.getGoal(selected.goal.goalId)) ?? selected.goal;
    const result = await runOpenClawAgent({
      agentId,
      runId,
      message: renderRunPrompt({
        goal,
        playgroundDir,
        minimumSensingSteps: config.actionPolicy.minimumSensingSteps,
        allowExternalActions: config.actionPolicy.allowExternalActions,
      }),
      timeoutSeconds: config.actionPolicy.runTimeoutSeconds,
      gatewayUrl: params.gatewayUrl,
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
    await manager.recordObservation({
      kind: result.exitCode === 0 ? "assistant_output" : "tool_failure",
      runId,
      agentId,
      success: result.exitCode === 0,
      content: stdout || stderr,
      metadata: { wanderRunFinal: true, exitCode: result.exitCode },
    });
    // Backfill sensing steps from agent meta when hooks could not observe them.
    const activeRun = manager.getActiveRun(agentId);
    const toolSummary = extractAgentToolSummary(result.meta);
    if (toolSummary && activeRun && activeRun.sensingSteps === 0) {
      manager.addSensingSteps(agentId, toolSummary.callCount);
      await manager.appendAuditEvent({
        eventType: "sensing_backfilled",
        goalId: selected.goal.goalId,
        runId,
        payload: { toolNames: toolSummary.toolNames, callCount: toolSummary.callCount },
      });
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }

  // 6. Finalize: parse the structured report, judge the run, never leave it stuck.
  const activeRun = manager.getActiveRun(agentId);
  const sensingSteps = activeRun?.sensingSteps ?? 0;
  manager.clearActiveRun(agentId);
  const text = stdout || stderr;
  const report = exitCode === 0 ? parseRunReport(text) : null;
  const noAffordance = reportedNoSensingAffordance(text);
  const metMinimumAction =
    sensingSteps >= config.actionPolicy.minimumSensingSteps || noAffordance;
  const success = exitCode === 0 && !runError && metMinimumAction;
  const failureReason = runError
    ? runError
    : exitCode !== 0
      ? clampOutput(stderr || stdout || "agent run failed")
      : !metMinimumAction
        ? `run ended after ${sensingSteps} tool-backed step(s); ${config.actionPolicy.minimumSensingSteps} required and no NO_SENSING_AFFORDANCE declared`
        : undefined;

  const finalized = await manager.finalizeGoal({
    goalId: selected.goal.goalId,
    runId,
    success,
    sensingSteps,
    durationMs: Date.now() - startedAt,
    error: failureReason,
    report,
    playgroundDir,
  });
  await manager.recordRunUsage({
    runId,
    agentId,
    trigger: params.trigger,
    kind: "exploration",
    endedAt: Date.now(),
    success,
    durationMs: Date.now() - startedAt,
  });
  await manager.markSatiated();

  // 7. Fold the visit into the exploration map (even failed runs teach the map,
  // as long as the agent reported where it actually went).
  if (report && report.topic) {
    const embedder = await manager.embedder();
    const [vector] = await embedder.embed([`${report.topic}. ${report.summary}`]);
    const region = await manager.recordTerritoryVisit({ runId, report, vector });
    await manager.appendAuditEvent({
      eventType: "territory_updated",
      goalId: selected.goal.goalId,
      runId,
      payload: {
        territoryId: region.territoryId,
        topic: region.topic,
        visits: region.visits,
        learningProgress: region.learningProgress,
        saturation: region.saturation,
      },
    });
  }

  await manager.appendAuditEvent({
    eventType: "run_finished",
    goalId: selected.goal.goalId,
    runId,
    payload: {
      success,
      sensingSteps,
      status: finalized.status,
      reportPresent: report !== null,
      error: failureReason,
      stdoutPreview: clampOutput(stdout, 1200),
    },
  });

  return {
    ran: true,
    runId,
    goalId: selected.goal.goalId,
    topic: selected.goal.topic,
    success,
    sensingSteps,
    report,
    candidateCount: goals.length,
    ...(failureReason ? { error: failureReason } : {}),
  };
}
