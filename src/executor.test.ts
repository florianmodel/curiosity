import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CURIOSITY_CONFIG } from "./config.js";
import {
  availableWebSensingTools,
  executeCuriosityRun,
  extractAgentToolSummary,
} from "./executor.js";
import { CuriosityManager } from "./manager.js";
import type { CuriosityConfig, GoalSourcesConfig } from "./types.js";

const managers: CuriosityManager[] = [];
const tempDirs: string[] = [];

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
      autonomousRunsPerDay: 5,
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
      act: 0.2,
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
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-executor-"));
  const manager = new CuriosityManager({
    workspaceDir,
    config: mergeConfig(configOverrides),
    configuredSurfaces: ["workspace", "web"],
    logger: {},
  });
  managers.push(manager);
  tempDirs.push(workspaceDir);
  return manager;
}

describe("curiosity executor", () => {
  it("detects when web sensing tools are disabled by runtime policy", () => {
    expect(availableWebSensingTools()).toEqual(["web_search", "web_fetch", "browser"]);
    expect(
      availableWebSensingTools({
        tools: { allow: ["read", "process"] },
      }),
    ).toEqual([]);
    expect(
      availableWebSensingTools({
        tools: { deny: ["group:web", "browser"] },
      }),
    ).toEqual([]);
    expect(
      availableWebSensingTools(
        {
          agents: {
            list: [{ id: "main", tools: { allow: ["read"], alsoAllow: ["web_search"] } }],
          },
        },
        "main",
      ),
    ).toEqual(["web_search"]);
  });

  it("extracts gateway tool summaries for sensing-step backfill", () => {
    expect(
      extractAgentToolSummary({
        toolSummary: {
          calls: 3,
          tools: ["web_search", "web_fetch"],
        },
      }),
    ).toEqual({
      callCount: 3,
      toolNames: ["web_search", "web_fetch"],
    });
    expect(extractAgentToolSummary({ toolSummary: { calls: 0, tools: [] } })).toBeNull();
  });

  it("records a web-affordance blocker instead of launching a narrative-only web run", async () => {
    const manager = await createManager({
      goalSources: NO_GOAL_SOURCES,
      boredom: {
        enabled: true,
        idleStartMinutes: 1,
        saturationMinutes: 2,
        wakeLevel: 0.6,
        satiationMinutes: 0,
      },
      actionPolicy: {
        allowExternalActions: true,
        externalTargetPolicy: "research-web-only",
        minimumSensingSteps: 2,
      },
    });
    await manager.getBoredomState(Date.now() - 3 * 60 * 1000);

    const result = await executeCuriosityRun({
      manager,
      agentId: "main",
      runId: "curiosity-run-no-web-tools",
      timeoutSeconds: 1,
      gatewayUrl: "ws://127.0.0.1:1",
      runtimeConfig: {
        tools: { allow: ["read", "process"] },
      },
      select: true,
      notifyStart: false,
      trigger: "curiosity-executor-test",
    });

    expect(result.selected).toBe(true);
    if (!result.selected) {
      return;
    }
    expect(result.executed).toBe(false);
    expect(result.success).toBe(false);
    expect(result.outcome.minimumActionSatisfied).toBe(true);
    expect(result.outcome.error).toContain("NO_SENSING_AFFORDANCE");
    const inspected = await manager.inspectIdentifier("curiosity-run-no-web-tools");
    const goal = inspected.goal as { status?: string; outcome?: Record<string, unknown> };
    expect(goal.status).toBe("failed");
    expect(goal.outcome?.error).toContain("web/search/browser sensing tool");
  });
});
