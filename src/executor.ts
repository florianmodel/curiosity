import type { CuriosityManager } from "./manager.js";
import type { GoalRecord, GoalSelectionDecision } from "./types.js";

type GatewayClientInstance = {
  start: () => void;
  stopAndWait: (opts?: { timeoutMs?: number }) => Promise<void>;
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean; timeoutMs?: number | null },
  ) => Promise<T>;
};

type GatewayClientConstructor = new (opts: {
  url?: string;
  requestTimeoutMs?: number;
  clientDisplayName?: string;
  onHelloOk?: () => void;
  onConnectError?: (err: Error) => void;
}) => GatewayClientInstance;

export type CuriosityAgentRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type CuriosityExecutionResult =
  | {
      selected: false;
      runId: string;
      agentId: string;
      reason: string;
    }
  | {
      selected: true;
      executed: true;
      success: boolean;
      runId: string;
      agentId: string;
      goalId: string;
      adoptedFromAgentId?: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      outcome: Awaited<ReturnType<CuriosityManager["finalizeAutonomousRun"]>>;
      resultNotice?: unknown;
      startNotice?: unknown;
    };

function parseSelectionReason(
  selection: Extract<GoalSelectionDecision, { selected: false }> | { selected: false; reason: string },
) {
  return selection.reason;
}

export function clampOutput(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, 1000)}\n...[truncated]...\n${text.slice(-maxChars + 1018)}`;
}

export function renderGoalRunMessage(goal: GoalRecord): string {
  return [
    "Run this autonomous curiosity goal as one bounded self-directed investigation.",
    "",
    `Goal ID: ${goal.goalId}`,
    `Drive signal: ${goal.title}`,
    `Source: ${goal.source}`,
    `Target surface: ${goal.targetSurface}`,
    "",
    "Evidence:",
    ...goal.evidence.map((item) => `- ${item}`),
    "",
    "Autonomy brief:",
    "- Start by choosing the first allowed sensing tool call; do not spend the turn explaining the plan first.",
    "- If the target surface is web, search, or browser, use a research/web tool as the first sensing step unless none is safely available.",
    "- Do not satisfy this request with narrative alone; use available tools unless no safe tool affordance exists.",
    "- Author the actual intention yourself from the available context.",
    "- Take multiple low-risk sensing or inspection steps through allowed tools before concluding.",
    "- If no safe sensing affordance exists, reply NO_SENSING_AFFORDANCE followed by the blocker.",
    "- Do one bounded pass and stop.",
    "- End with what you did, what surprised you, and the next clue.",
  ].join("\n");
}

export async function runOpenClawAgent(params: {
  agentId: string;
  runId: string;
  message: string;
  timeoutSeconds: number;
  gatewayUrl: string;
}): Promise<CuriosityAgentRunResult> {
  const { GatewayClient } = (await import("openclaw/plugin-sdk/gateway-runtime")) as {
    GatewayClient: GatewayClientConstructor;
  };
  const timeoutMs = Math.max(10_000, (params.timeoutSeconds + 30) * 1000);

  return new Promise((resolve, reject) => {
    let client: GatewayClientInstance;
    let settled = false;
    const finish = (value: CuriosityAgentRunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      void client.stopAndWait().finally(() => resolve(value));
    };
    const fail = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      void client.stopAndWait().finally(() => reject(err));
    };

    const timer = setTimeout(() => {
      fail(new Error(`gateway agent request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    client = new GatewayClient({
      url: params.gatewayUrl,
      requestTimeoutMs: timeoutMs,
      clientDisplayName: "Curiosity",
      onHelloOk: () => {
        client
          .request<{
            status?: string;
            summary?: string;
            result?: { payloads?: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }> };
          }>(
            "agent",
            {
              message: params.message,
              agentId: params.agentId,
              timeout: params.timeoutSeconds,
              idempotencyKey: params.runId,
            },
            { expectFinal: true, timeoutMs },
          )
          .then((response) => {
            clearTimeout(timer);
            const payloads = response.result?.payloads ?? [];
            const text = payloads
              .map((payload) =>
                [payload.text, payload.mediaUrl, ...(payload.mediaUrls ?? [])]
                  .filter(Boolean)
                  .join("\n"),
              )
              .filter(Boolean)
              .join("\n\n");
            finish({
              exitCode: 0,
              stdout: text || response.summary || JSON.stringify(response),
              stderr: "",
            });
          })
          .catch((err) => {
            clearTimeout(timer);
            finish({
              exitCode: 1,
              stdout: "",
              stderr: err instanceof Error ? err.message : String(err),
            });
          });
      },
      onConnectError: (err) => {
        clearTimeout(timer);
        fail(err);
      },
    });
    client.start();
  });
}

export async function selectCuriosityGoal(params: {
  manager: CuriosityManager;
  agentId: string;
  runId: string;
  notify: boolean;
  force?: boolean;
  trigger?: string;
}): Promise<GoalSelectionDecision & { notification?: unknown }> {
  const decision = await params.manager.selectGoalForRun({
    agentId: params.agentId,
    runId: params.runId,
    trigger: params.trigger ?? "curiosity-executor",
    ignoreRetryBlocks: params.force === true,
  });
  const notification =
    decision.selected && params.notify
      ? await params.manager.notifyAutonomousStart({
          runId: params.runId,
          agentId: params.agentId,
          goal: decision.goal,
        })
      : undefined;
  return { ...decision, notification };
}

export async function executeCuriosityRun(params: {
  manager: CuriosityManager;
  agentId: string;
  runId?: string;
  timeoutSeconds: number;
  gatewayUrl: string;
  select?: boolean;
  notifyStart?: boolean;
  force?: boolean;
  trigger: string;
}): Promise<CuriosityExecutionResult> {
  const runId = params.runId?.trim() || `curiosity-run-${Date.now()}`;
  const selectedGoals = await params.manager.listGoalsByStatus(["selected", "in_progress"], 10);
  const existing = selectedGoals.find((goal) => goal.agentId === params.agentId) ?? selectedGoals[0];
  const selection = existing
    ? {
        selected: true as const,
        goal: existing,
        reusedSelectedGoal: true,
        adoptedFromAgentId: existing.agentId === params.agentId ? undefined : existing.agentId,
      }
    : params.select !== false
      ? await selectCuriosityGoal({
          manager: params.manager,
          agentId: params.agentId,
          runId,
          notify: params.notifyStart === true,
          force: params.force === true,
          trigger: params.trigger,
        })
      : { selected: false as const, reason: "no_selected_goal" };

  if (!selection.selected) {
    return {
      selected: false,
      runId,
      agentId: params.agentId,
      reason: parseSelectionReason(selection),
    };
  }

  await params.manager.markGoalInProgress({
    goalId: selection.goal.goalId,
    runId,
    agentId: params.agentId,
  });
  const startedAt = Date.now();
  const result = await runOpenClawAgent({
    agentId: params.agentId,
    runId,
    message: renderGoalRunMessage(selection.goal),
    timeoutSeconds: params.timeoutSeconds,
    gatewayUrl: params.gatewayUrl,
  });
  const success = result.exitCode === 0;
  await params.manager.recordObservation({
    kind: success ? "assistant_output" : "tool_failure",
    runId,
    agentId: params.agentId,
    success,
    content: clampOutput(result.stdout || result.stderr),
    metadata: {
      command: "openclaw agent",
      exitCode: result.exitCode,
    },
  });
  const outcome = await params.manager.finalizeAutonomousRun({
    runId,
    goalId: selection.goal.goalId,
    agentId: params.agentId,
    trigger: params.trigger,
    success,
    durationMs: Date.now() - startedAt,
    error: success ? undefined : clampOutput(result.stderr || result.stdout || "agent failed"),
  });
  const refreshedGoal = await params.manager.findGoalByRunId(runId);
  const resultNotice = refreshedGoal
    ? await params.manager.notifyAutonomousFinish({
        runId,
        agentId: params.agentId,
        goal: refreshedGoal,
        success: outcome.success,
        error: outcome.error,
        summary: outcome.success ? clampOutput(result.stdout) : undefined,
      })
    : undefined;

  return {
    selected: true,
    executed: true,
    success: outcome.success,
    runId,
    agentId: params.agentId,
    goalId: selection.goal.goalId,
    adoptedFromAgentId:
      "adoptedFromAgentId" in selection ? selection.adoptedFromAgentId : undefined,
    exitCode: result.exitCode,
    stdout: clampOutput(result.stdout),
    stderr: clampOutput(result.stderr),
    outcome,
    resultNotice,
    startNotice: "notification" in selection ? selection.notification : undefined,
  };
}
