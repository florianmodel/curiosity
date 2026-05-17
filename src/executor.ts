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

const NO_SENSING_AFFORDANCE_TOKEN = "NO_SENSING_AFFORDANCE";
const WEB_TARGET_SURFACES = new Set(["web", "search", "browser"]);
const DEFAULT_WEB_TOOLS = ["web_search", "web_fetch", "browser"];

export type CuriosityAgentRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  meta?: Record<string, unknown>;
};

export type AgentToolSummary = {
  toolNames: string[];
  callCount: number;
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
      executed: false;
      success: false;
      blocked: true;
      runId: string;
      agentId: string;
      goalId: string;
      adoptedFromAgentId?: string;
      blocker: string;
      outcome: Awaited<ReturnType<CuriosityManager["finalizeAutonomousRun"]>>;
      resultNotice?: unknown;
      startNotice?: unknown;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getPath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function mergeAllowPolicy(allow: unknown, alsoAllow: unknown): string[] | null {
  const allowList = readStringArray(allow);
  if (!allowList) {
    return null;
  }
  return [...allowList, ...(readStringArray(alsoAllow) ?? [])];
}

function findAgentConfig(runtimeConfig: unknown, agentId?: string): Record<string, unknown> | null {
  const normalizedAgentId = agentId?.trim();
  if (!normalizedAgentId) {
    return null;
  }
  const list = getPath(runtimeConfig, ["agents", "list"]);
  if (!Array.isArray(list)) {
    return null;
  }
  const entry = list.find((candidate) => {
    const record = asRecord(candidate);
    return typeof record?.id === "string" && record.id.trim() === normalizedAgentId;
  });
  return asRecord(entry);
}

function matchesToolPattern(toolName: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern || normalizedPattern === "*") {
    return true;
  }
  if (normalizedPattern === "group:web") {
    return (
      DEFAULT_WEB_TOOLS.includes(toolName) ||
      /(?:web|search|fetch|browser|crawl|scrape)/i.test(toolName)
    );
  }
  if (!normalizedPattern.includes("*")) {
    return normalizedPattern === toolName;
  }
  const escaped = normalizedPattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

function isToolBlockedByList(toolName: string, patterns: string[] | null): boolean {
  return Boolean(patterns?.some((pattern) => matchesToolPattern(toolName, pattern)));
}

function isToolAllowedByList(toolName: string, patterns: string[] | null): boolean {
  return !patterns || patterns.some((pattern) => matchesToolPattern(toolName, pattern));
}

function webToolEnabledBySpecificConfig(runtimeConfig: unknown, toolName: string): boolean {
  if (toolName === "browser" && getPath(runtimeConfig, ["browser", "enabled"]) === false) {
    return false;
  }
  if (toolName === "web_search") {
    return getPath(runtimeConfig, ["tools", "web", "search", "enabled"]) !== false;
  }
  if (toolName === "web_fetch") {
    return getPath(runtimeConfig, ["tools", "web", "fetch", "enabled"]) !== false;
  }
  return true;
}

export function availableWebSensingTools(runtimeConfig?: unknown, agentId?: string): string[] {
  const agentConfig = findAgentConfig(runtimeConfig, agentId);
  const allowLists = [
    mergeAllowPolicy(
      getPath(runtimeConfig, ["tools", "allow"]),
      getPath(runtimeConfig, ["tools", "alsoAllow"]),
    ),
    readStringArray(getPath(runtimeConfig, ["gateway", "tools", "allow"])),
    mergeAllowPolicy(
      getPath(runtimeConfig, ["agents", "defaults", "tools", "allow"]),
      getPath(runtimeConfig, ["agents", "defaults", "tools", "alsoAllow"]),
    ),
    mergeAllowPolicy(
      getPath(agentConfig, ["tools", "allow"]),
      getPath(agentConfig, ["tools", "alsoAllow"]),
    ),
  ].filter((value): value is string[] => value !== null);
  const denyLists = [
    readStringArray(getPath(runtimeConfig, ["tools", "deny"])),
    readStringArray(getPath(runtimeConfig, ["gateway", "tools", "deny"])),
    readStringArray(getPath(runtimeConfig, ["agents", "defaults", "tools", "deny"])),
    readStringArray(getPath(agentConfig, ["tools", "deny"])),
  ].filter((value): value is string[] => value !== null);

  return DEFAULT_WEB_TOOLS.filter((toolName) => {
    if (!webToolEnabledBySpecificConfig(runtimeConfig, toolName)) {
      return false;
    }
    if (denyLists.some((patterns) => isToolBlockedByList(toolName, patterns))) {
      return false;
    }
    return allowLists.every((patterns) => isToolAllowedByList(toolName, patterns));
  });
}

function isWebTargetSurface(surface: string): boolean {
  return WEB_TARGET_SURFACES.has(surface.trim().toLowerCase());
}

export function extractAgentToolSummary(meta: unknown): AgentToolSummary | null {
  const toolSummary = asRecord(getPath(meta, ["toolSummary"]));
  if (!toolSummary) {
    return null;
  }
  const tools = readStringArray(toolSummary.tools) ?? [];
  const calls = typeof toolSummary.calls === "number" ? Math.trunc(toolSummary.calls) : tools.length;
  if (tools.length === 0 || calls <= 0) {
    return null;
  }
  return {
    toolNames: tools,
    callCount: Math.max(calls, tools.length),
  };
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
            result?: {
              payloads?: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }>;
              meta?: unknown;
            };
            meta?: unknown;
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
              meta: asRecord(response.result?.meta) ?? asRecord(response.meta) ?? undefined,
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
  forcedSurface?: string;
  trigger?: string;
}): Promise<GoalSelectionDecision & { notification?: unknown }> {
  const decision = await params.manager.selectGoalForRun({
    agentId: params.agentId,
    runId: params.runId,
    trigger: params.trigger ?? "curiosity-executor",
    ignoreRetryBlocks: params.force === true,
    forceSelect: params.force === true,
    forcedSurface: params.forcedSurface,
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
  runtimeConfig?: unknown;
  select?: boolean;
  notifyStart?: boolean;
  force?: boolean;
  forcedSurface?: string;
  trigger: string;
}): Promise<CuriosityExecutionResult> {
  const runId = params.runId?.trim() || `curiosity-run-${Date.now()}`;
  const selectedGoals = await params.manager.listGoalsByStatus(["selected", "in_progress"], 10);
  const existing =
    params.force === true
      ? undefined
      : selectedGoals.find((goal) => goal.agentId === params.agentId) ?? selectedGoals[0];
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
          forcedSurface: params.forcedSurface,
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
  const webTools = availableWebSensingTools(params.runtimeConfig, params.agentId);
  if (isWebTargetSurface(selection.goal.targetSurface) && webTools.length === 0) {
    const blocker =
      `${NO_SENSING_AFFORDANCE_TOKEN} Web exploration cannot run because no web/search/browser sensing tool is available in the current OpenClaw runtime configuration.`;
    await params.manager.recordObservation({
      kind: "assistant_output",
      runId,
      agentId: params.agentId,
      success: false,
      content: blocker,
      metadata: {
        trigger: params.trigger,
        preflight: "web_affordance",
      },
    });
    const outcome = await params.manager.finalizeAutonomousRun({
      runId,
      goalId: selection.goal.goalId,
      agentId: params.agentId,
      trigger: params.trigger,
      success: false,
      durationMs: Date.now() - startedAt,
      error: blocker,
    });
    const refreshedGoal = await params.manager.findGoalByRunId(runId);
    const resultNotice = refreshedGoal
      ? await params.manager.notifyAutonomousFinish({
          runId,
          agentId: params.agentId,
          goal: refreshedGoal,
          success: false,
          error: outcome.error,
        })
      : undefined;
    return {
      selected: true,
      executed: false,
      success: false,
      blocked: true,
      runId,
      agentId: params.agentId,
      goalId: selection.goal.goalId,
      adoptedFromAgentId:
        "adoptedFromAgentId" in selection ? selection.adoptedFromAgentId : undefined,
      blocker,
      outcome,
      resultNotice,
      startNotice: "notification" in selection ? selection.notification : undefined,
    };
  }

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
      toolSummary: extractAgentToolSummary(result.meta),
    },
  });
  const toolSummary = extractAgentToolSummary(result.meta);
  if (toolSummary && (await params.manager.countSensingStepsForRun(runId)) === 0) {
    await params.manager.recordObservedToolCalls({
      runId,
      agentId: params.agentId,
      toolNames: toolSummary.toolNames,
      callCount: toolSummary.callCount,
      source: "agent_meta_tool_summary",
    });
  }
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
