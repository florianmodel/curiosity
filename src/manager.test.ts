import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CURIOSITY_CONFIG } from "./config.js";
import { CuriosityManager, isWithinActiveWindow } from "./manager.js";
import type { CuriosityConfig, GoalSourcesConfig } from "./types.js";

const managers: CuriosityManager[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (managers.length > 0) {
    const manager = managers.pop();
    if (manager) {
      await manager.close();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

const NO_GOAL_SOURCES: GoalSourcesConfig = {
  bootstrapExploration: false,
  unresolvedUserAsks: false,
  staleOpenQuestions: false,
  failedToolAttempts: false,
  newlyDiscoveredEntities: false,
  lowCoverageSurfaces: false,
  skillOpportunities: false,
  externalFollowUps: false,
};

type CuriosityConfigOverrides = Partial<
  Omit<
    CuriosityConfig,
    | "budgets"
    | "goalSources"
    | "ensembleWeights"
    | "thresholds"
    | "boredom"
    | "logging"
    | "actionPolicy"
    | "notifications"
  >
> & {
  budgets?: Partial<CuriosityConfig["budgets"]>;
  goalSources?: Partial<CuriosityConfig["goalSources"]>;
  ensembleWeights?: Partial<CuriosityConfig["ensembleWeights"]>;
  thresholds?: Partial<CuriosityConfig["thresholds"]>;
  boredom?: Partial<CuriosityConfig["boredom"]>;
  logging?: Partial<CuriosityConfig["logging"]>;
  actionPolicy?: Partial<CuriosityConfig["actionPolicy"]>;
  notifications?: {
    autonomousStart?: Partial<CuriosityConfig["notifications"]["autonomousStart"]>;
  };
};

function mergeConfig(overrides: CuriosityConfigOverrides = {}): CuriosityConfig {
  return {
    ...DEFAULT_CURIOSITY_CONFIG,
    ...overrides,
    budgets: {
      ...DEFAULT_CURIOSITY_CONFIG.budgets,
      autonomousRunsPerDay: 1,
      ...overrides.budgets,
    },
    goalSources: {
      ...DEFAULT_CURIOSITY_CONFIG.goalSources,
      ...overrides.goalSources,
    },
    ensembleWeights: {
      ...DEFAULT_CURIOSITY_CONFIG.ensembleWeights,
      ...overrides.ensembleWeights,
    },
    thresholds: {
      ...DEFAULT_CURIOSITY_CONFIG.thresholds,
      act: 0.3,
      ...overrides.thresholds,
    },
    boredom: {
      ...DEFAULT_CURIOSITY_CONFIG.boredom,
      ...overrides.boredom,
    },
    logging: {
      ...DEFAULT_CURIOSITY_CONFIG.logging,
      ...overrides.logging,
    },
    actionPolicy: {
      ...DEFAULT_CURIOSITY_CONFIG.actionPolicy,
      ...overrides.actionPolicy,
    },
    notifications: {
      autonomousStart: {
        ...DEFAULT_CURIOSITY_CONFIG.notifications.autonomousStart,
        ...overrides.notifications?.autonomousStart,
      },
    },
  };
}

async function createManager(configOverrides: CuriosityConfigOverrides = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-plugin-"));
  const manager = new CuriosityManager({
    workspaceDir,
    config: mergeConfig(configOverrides),
    configuredSurfaces: ["workspace", "telegram"],
    logger: {},
  });
  managers.push(manager);
  tempDirs.push(workspaceDir);
  return manager;
}

describe("CuriosityManager", () => {
  it("selects a self-authored goal from an empty state after boredom matures", async () => {
    const manager = await createManager({
      thresholds: { act: 0.6 },
      boredom: {
        idleStartMinutes: 1,
        saturationMinutes: 2,
        wakeLevel: 0.6,
      },
    });
    await manager.getBoredomState(Date.now() - 3 * 60 * 1000);

    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-bootstrap",
      trigger: "heartbeat",
    });

    expect(decision.selected).toBe(true);
    if (decision.selected) {
      expect(decision.goal.source).toBe("self_authored_intention");
      expect(decision.goal.targetSurface).toBe("workspace");
      expect(decision.goal.risk).toBeLessThan(0.1);
    }
  });

  it("does not create bootstrap goals after curiosity has prior outcomes", async () => {
    const manager = await createManager({
      budgets: { autonomousRunsPerDay: 3 },
      goalSources: { ...NO_GOAL_SOURCES, bootstrapExploration: true },
      thresholds: { act: 0.6 },
      boredom: {
        idleStartMinutes: 1,
        saturationMinutes: 2,
        wakeLevel: 0.6,
      },
    });
    await manager.getBoredomState(Date.now() - 3 * 60 * 1000);
    const first = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-bootstrap",
      trigger: "heartbeat",
    });
    expect(first.selected).toBe(true);
    if (!first.selected) {
      return;
    }
    await manager.canUseTool("run-bootstrap", "read");
    await manager.finalizeAutonomousRun({
      runId: "run-bootstrap",
      goalId: first.goal.goalId,
      agentId: "main",
      trigger: "heartbeat",
      success: true,
    });

    const second = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-after-bootstrap",
      trigger: "heartbeat",
    });

    expect(second.selected).toBe(false);
    if (!second.selected) {
      expect(second.reason).toBe("no_candidates");
    }
  });

  it("selects a goal from a recent unresolved user ask", async () => {
    const manager = await createManager();
    await manager.recordObservation({
      kind: "message_received",
      channelId: "telegram",
      content: "Can you resolve the pending uncertainty?",
    });

    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-1",
      trigger: "heartbeat",
    });

    expect(decision.selected).toBe(true);
    if (decision.selected) {
      expect(decision.goal.source).toBe("unresolved_user_ask");
      expect(decision.goal.goalId).toBeTruthy();
    }
  });

  it("writes a concrete title for underexplored surface autonomy", async () => {
    const manager = await createManager({
      goalSources: { ...NO_GOAL_SOURCES, lowCoverageSurfaces: true },
      thresholds: { act: 0.2 },
      boredom: {
        enabled: false,
        idleStartMinutes: 1,
        saturationMinutes: 2,
        wakeLevel: 0,
      },
    });
    await manager.recordObservation({
      kind: "message_received",
      channelId: "telegram",
      createdAt: Date.now() - 3 * 60 * 1000,
      content: "Just a tiny signal here.",
    });

    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-low-coverage",
      trigger: "heartbeat",
    });

    expect(decision.selected).toBe(true);
    if (decision.selected) {
      expect(decision.goal.title).toMatch(/Self-author on underexplored surface:/);
      expect(decision.goal.targetSurface).toBe("workspace");
    }
  });

  it("enforces the autonomous run budget", async () => {
    const manager = await createManager();
    await manager.recordObservation({
      kind: "message_received",
      content: "Can you resolve the pending uncertainty?",
    });

    const first = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-1",
      trigger: "heartbeat",
    });
    expect(first.selected).toBe(true);

    const second = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-2",
      trigger: "heartbeat",
    });
    expect(second.selected).toBe(false);
    if (!second.selected) {
      expect(second.reason).toBe("budget_exhausted");
    }
  });

  it("selects a low-risk boredom goal after prolonged inactivity", async () => {
    const manager = await createManager({
      goalSources: NO_GOAL_SOURCES,
      thresholds: { act: 0.6 },
      boredom: {
        enabled: true,
        idleStartMinutes: 1,
        saturationMinutes: 2,
        maxScoreBonus: 0.35,
        wakeLevel: 0.6,
      },
    });
    await manager.recordObservation({
      kind: "assistant_output",
      createdAt: Date.now() - 3 * 60 * 1000,
      content: "Routine heartbeat completed.",
    });

    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-idle",
      trigger: "heartbeat",
    });

    expect(decision.selected).toBe(true);
    if (decision.selected) {
      expect(decision.goal.source).toBe("self_authored_intention");
      expect(decision.goal.targetSurface).toBe("workspace");
      expect(decision.goal.scoresByModel.boredom_drive).toBeGreaterThan(0.9);
    }
  });

  it("does not invent a boredom goal before the idle start point", async () => {
    const manager = await createManager({
      goalSources: NO_GOAL_SOURCES,
      thresholds: { act: 0.6 },
      boredom: {
        enabled: true,
        idleStartMinutes: 5,
        saturationMinutes: 10,
        maxScoreBonus: 0.35,
      },
    });
    await manager.recordObservation({
      kind: "assistant_output",
      content: "Routine heartbeat completed.",
    });

    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-not-idle",
      trigger: "heartbeat",
    });
    const snapshot = await manager.queueSnapshot();

    expect(decision.selected).toBe(false);
    if (!decision.selected) {
      expect(decision.reason).toBe("no_candidates");
      expect(decision.candidateCount).toBe(0);
    }
    expect(snapshot.boredom.level).toBe(0);
  });

  it("does not let heartbeat acknowledgements reset boredom", async () => {
    const manager = await createManager({
      goalSources: NO_GOAL_SOURCES,
      boredom: {
        enabled: true,
        idleStartMinutes: 1,
        saturationMinutes: 2,
        wakeLevel: 0.6,
      },
    });
    await manager.recordObservation({
      kind: "assistant_output",
      createdAt: Date.now() - 3 * 60 * 1000,
      content: "External activity anchor.",
    });
    expect((await manager.getBoredomState()).level).toBeGreaterThan(0.9);

    await manager.recordObservation({
      kind: "assistant_output",
      content: "HEARTBEAT_OK",
      metadata: { trigger: "heartbeat" },
    });

    expect((await manager.getBoredomState()).level).toBeGreaterThan(0.9);
  });

  it("requests boredom wake only after the drive crosses threshold and interval", async () => {
    const manager = await createManager({
      budgets: { autonomousRunsPerDay: 3 },
      goalSources: NO_GOAL_SOURCES,
      boredom: {
        enabled: true,
        idleStartMinutes: 1,
        saturationMinutes: 2,
        wakeLevel: 0.6,
        wakeMinIntervalMinutes: 10,
      },
    });
    await manager.recordObservation({
      kind: "assistant_output",
      createdAt: Date.now() - 3 * 60 * 1000,
      content: "External activity anchor.",
    });

    const ready = await manager.shouldRequestBoredomWake();
    expect(ready.shouldWake).toBe(true);
    await manager.markBoredomWakeRequested({
      runReason: "curiosity-boredom",
      agentId: "main",
      boredom: ready.boredom,
    });

    const throttled = await manager.shouldRequestBoredomWake();
    expect(throttled.shouldWake).toBe(false);
    expect(throttled.reason).toBe("wake_interval_active");
  });

  it("does not select self-maintenance goals before boredom reaches the drive gate", async () => {
    const manager = await createManager({
      goalSources: { ...NO_GOAL_SOURCES, failedToolAttempts: true },
      boredom: {
        enabled: true,
        idleStartMinutes: 10,
        saturationMinutes: 20,
        wakeLevel: 0.5,
      },
    });
    await manager.recordObservation({
      kind: "tool_failure",
      toolName: "read",
      content: "Could not inspect the selected file.",
    });

    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-drive-gated",
      trigger: "heartbeat",
    });

    expect(decision.selected).toBe(false);
    if (!decision.selected) {
      expect(decision.reason).toBe("no_candidates");
    }
  });

  it("ignores infrastructure failures as curiosity fuel", async () => {
    const manager = await createManager({
      goalSources: { ...NO_GOAL_SOURCES, failedToolAttempts: true },
      boredom: {
        enabled: false,
        wakeLevel: 0,
      },
    });
    await manager.recordObservation({
      kind: "tool_failure",
      toolName: "tool",
      content: 'invalid agent params: unknown agent id "default"',
    });

    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-infra-failure",
      trigger: "heartbeat",
    });

    expect(decision.selected).toBe(false);
    if (!decision.selected) {
      expect(decision.reason).toBe("no_candidates");
    }
  });

  it("stops retrying the same autonomous fingerprint after the attempt cap", async () => {
    const manager = await createManager({
      budgets: { autonomousRunsPerDay: 3 },
      goalSources: NO_GOAL_SOURCES,
      actionPolicy: {
        minimumSensingSteps: 2,
        maxAttemptsPerGoal: 1,
        retryCooldownMinutes: 0,
      },
      boredom: {
        enabled: true,
        idleStartMinutes: 1,
        saturationMinutes: 2,
        wakeLevel: 0.6,
        satiationMinutes: 0,
      },
    });
    await manager.recordObservation({
      kind: "assistant_output",
      createdAt: Date.now() - 3 * 60 * 1000,
      content: "External activity anchor.",
    });
    const first = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-attempt-cap-1",
      trigger: "heartbeat",
    });
    expect(first.selected).toBe(true);
    if (!first.selected) {
      return;
    }
    await manager.canUseTool("run-attempt-cap-1", "read");
    await manager.canUseTool("run-attempt-cap-1", "process");
    await manager.finalizeAutonomousRun({
      runId: "run-attempt-cap-1",
      goalId: first.goal.goalId,
      agentId: "main",
      trigger: "heartbeat",
      success: true,
    });

    const second = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-attempt-cap-2",
      trigger: "heartbeat",
    });

    expect(second.selected).toBe(false);
  });

  it("reports retry-blocked selections and allows manual force selection", async () => {
    const manager = await createManager({
      budgets: { autonomousRunsPerDay: 3 },
      goalSources: NO_GOAL_SOURCES,
      actionPolicy: {
        minimumSensingSteps: 2,
        maxAttemptsPerGoal: 2,
        retryCooldownMinutes: 120,
      },
      boredom: {
        enabled: true,
        idleStartMinutes: 1,
        saturationMinutes: 2,
        wakeLevel: 0.6,
        satiationMinutes: 0,
      },
    });
    await manager.recordObservation({
      kind: "assistant_output",
      createdAt: Date.now() - 3 * 60 * 1000,
      content: "External activity anchor.",
    });
    const first = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-retry-block-1",
      trigger: "heartbeat",
    });
    expect(first.selected).toBe(true);
    if (!first.selected) {
      return;
    }
    await manager.finalizeAutonomousRun({
      runId: "run-retry-block-1",
      goalId: first.goal.goalId,
      agentId: "main",
      trigger: "heartbeat",
      success: false,
      error: "model auth failed",
    });

    const blocked = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-retry-block-2",
      trigger: "heartbeat",
    });
    expect(blocked.selected).toBe(false);
    if (!blocked.selected) {
      expect(blocked.reason).toBe("retry_blocked");
    }

    const forced = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-retry-force",
      trigger: "curiosity-cli",
      ignoreRetryBlocks: true,
    });
    expect(forced.selected).toBe(true);
  });

  it("marks autonomous runs failed when they end without a tool-backed action", async () => {
    const manager = await createManager({
      budgets: { autonomousRunsPerDay: 3 },
    });
    await manager.recordObservation({
      kind: "message_received",
      content: "Can you resolve the pending uncertainty?",
    });
    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-without-sensing",
      trigger: "heartbeat",
    });
    expect(decision.selected).toBe(true);
    if (!decision.selected) {
      return;
    }

    await manager.finalizeAutonomousRun({
      runId: "run-without-sensing",
      goalId: decision.goal.goalId,
      agentId: "main",
      trigger: "heartbeat",
      success: true,
      error: "model auth failed",
    });
    const inspected = await manager.inspectIdentifier(decision.goal.goalId);
    const goal = inspected.goal as { status?: string; outcome?: Record<string, unknown> };

    expect(goal.status).toBe("failed");
    expect(goal.outcome?.minimumActionSatisfied).toBe(false);
    expect(String(goal.outcome?.error)).toContain("model auth failed");
  });

  it("requires the configured number of sensing steps", async () => {
    const manager = await createManager({
      budgets: { autonomousRunsPerDay: 3 },
      actionPolicy: { minimumSensingSteps: 2 },
    });
    await manager.recordObservation({
      kind: "message_received",
      content: "Can you resolve the pending uncertainty?",
    });
    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-one-step",
      trigger: "heartbeat",
    });
    expect(decision.selected).toBe(true);
    if (!decision.selected) {
      return;
    }

    await manager.canUseTool("run-one-step", "read");
    await manager.finalizeAutonomousRun({
      runId: "run-one-step",
      goalId: decision.goal.goalId,
      agentId: "main",
      trigger: "heartbeat",
      success: true,
    });
    const inspected = await manager.inspectIdentifier(decision.goal.goalId);
    const goal = inspected.goal as { status?: string; outcome?: Record<string, unknown> };

    expect(goal.status).toBe("failed");
    expect(goal.outcome?.sensingSteps).toBe(1);
    expect(goal.outcome?.requiredSensingSteps).toBe(2);
  });

  it("does not count curiosity_inspect as a qualifying sensing step", async () => {
    const manager = await createManager({
      budgets: { autonomousRunsPerDay: 3 },
      actionPolicy: { minimumSensingSteps: 1 },
    });
    await manager.recordObservation({
      kind: "message_received",
      content: "Can you resolve the pending uncertainty?",
    });
    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-self-inspect-only",
      trigger: "heartbeat",
    });
    expect(decision.selected).toBe(true);
    if (!decision.selected) {
      return;
    }

    await manager.canUseTool("run-self-inspect-only", "curiosity_inspect");
    await manager.finalizeAutonomousRun({
      runId: "run-self-inspect-only",
      goalId: decision.goal.goalId,
      agentId: "main",
      trigger: "heartbeat",
      success: true,
    });
    const inspected = await manager.inspectIdentifier(decision.goal.goalId);
    const goal = inspected.goal as { status?: string; outcome?: Record<string, unknown> };

    expect(goal.status).toBe("failed");
    expect(goal.outcome?.sensingSteps).toBe(0);
    expect(goal.outcome?.minimumActionSatisfied).toBe(false);
  });

  it("can pause and resume selection", async () => {
    const manager = await createManager();
    await manager.setPaused(true);
    expect(await manager.isPaused()).toBe(true);
    await manager.setPaused(false);
    expect(await manager.isPaused()).toBe(false);
  });

  it("treats safe local tool names case-insensitively", async () => {
    const manager = await createManager();
    await manager.recordObservation({
      kind: "message_received",
      content: "Can you resolve the pending uncertainty?",
    });

    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-1",
      trigger: "heartbeat",
    });
    expect(decision.selected).toBe(true);

    const allowed = await manager.canUseTool("run-1", "Read");

    expect(allowed.allowed).toBe(true);
  });

  it("evaluates configured active windows in the configured time zone", () => {
    const config = {
      ...DEFAULT_CURIOSITY_CONFIG,
      actionPolicy: {
        ...DEFAULT_CURIOSITY_CONFIG.actionPolicy,
        activeHours: "configured-window" as const,
        activeWindow: {
          start: "09:00",
          end: "17:00",
          timeZone: "UTC",
        },
      },
    };

    expect(isWithinActiveWindow(config, Date.UTC(2026, 0, 1, 10, 0))).toBe(true);
    expect(isWithinActiveWindow(config, Date.UTC(2026, 0, 1, 18, 0))).toBe(false);
  });

  it("supports overnight active windows", () => {
    const config = {
      ...DEFAULT_CURIOSITY_CONFIG,
      actionPolicy: {
        ...DEFAULT_CURIOSITY_CONFIG.actionPolicy,
        activeHours: "configured-window" as const,
        activeWindow: {
          start: "22:00",
          end: "06:00",
          timeZone: "UTC",
        },
      },
    };

    expect(isWithinActiveWindow(config, Date.UTC(2026, 0, 1, 23, 0))).toBe(true);
    expect(isWithinActiveWindow(config, Date.UTC(2026, 0, 2, 1, 0))).toBe(true);
    expect(isWithinActiveWindow(config, Date.UTC(2026, 0, 1, 12, 0))).toBe(false);
  });

  it("sends an autonomous-start notification when configured", async () => {
    const manager = await createManager({
      notifications: {
        autonomousStart: {
          enabled: true,
          provider: "telegram",
          telegram: {
            botToken: "bot-token",
            chatId: "12345",
            apiBaseUrl: "https://telegram.example",
          },
        },
      },
    });
    await manager.recordObservation({
      kind: "message_received",
      channelId: "telegram",
      content: "Can you resolve the pending uncertainty?",
    });
    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-notify",
      trigger: "heartbeat",
    });
    expect(decision.selected).toBe(true);
    if (!decision.selected) {
      return;
    }
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://telegram.example/botbot-token/sendMessage");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.chat_id).toBe("12345");
      expect(String(body.text)).toContain("Curiosity is starting a run");
      expect(String(body.text)).toContain("act first with allowed tools");
      expect(String(body.text)).not.toContain("stop after one pass");
      expect(String(body.text)).toContain("pending uncertainty");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await expect(
      manager.notifyAutonomousStart({
        runId: "run-notify",
        agentId: "main",
        goal: decision.goal,
        fetchFn,
      }),
    ).resolves.toEqual({ sent: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("sends an autonomous-result notification when configured", async () => {
    const manager = await createManager({
      notifications: {
        autonomousStart: {
          enabled: true,
          provider: "telegram",
          telegram: {
            botToken: "bot-token",
            chatId: "12345",
            apiBaseUrl: "https://telegram.example",
          },
        },
      },
    });
    await manager.recordObservation({
      kind: "message_received",
      channelId: "telegram",
      content: "Can you resolve the pending uncertainty?",
    });
    const decision = await manager.selectGoalForRun({
      agentId: "main",
      runId: "run-result-notify",
      trigger: "heartbeat",
    });
    expect(decision.selected).toBe(true);
    if (!decision.selected) {
      return;
    }
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(String(body.text)).toContain("Curiosity run needs attention");
      expect(String(body.text)).toContain("model auth failed");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await expect(
      manager.notifyAutonomousFinish({
        runId: "run-result-notify",
        agentId: "main",
        goal: decision.goal,
        success: false,
        error: "model auth failed",
        fetchFn,
      }),
    ).resolves.toEqual({ sent: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
