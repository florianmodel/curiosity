import path from "node:path";
import type { WanderConfig } from "./types.js";

export const WANDER_DIR_NAME = "wander";

export function resolveWanderWorkspaceDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".openclaw", WANDER_DIR_NAME);
}

export function resolvePlaygroundDir(workspaceDir: string, config: WanderConfig): string {
  return path.join(workspaceDir, config.playground.dirName);
}

export const DEFAULT_WANDER_CONFIG: WanderConfig = {
  boredom: {
    enabled: true,
    idleStartMinutes: 30,
    saturationMinutes: 180,
    wakeLevel: 0.5,
    wakeCheckMinutes: 5,
    wakeMinIntervalMinutes: 45,
    satiationMinutes: 90,
  },
  budgets: {
    autonomousRunsPerDay: 8,
    autonomousTokensPerDay: 800_000,
  },
  thresholds: {
    act: 0.45,
    recentObservationWindowHours: 48,
  },
  generation: {
    candidateCount: 7,
    timeoutSeconds: 240,
    maxContextObservations: 24,
    maxTerritorySummaryItems: 16,
  },
  grounded: {
    unresolvedUserAsks: true,
    failedToolAttempts: true,
  },
  embeddings: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
  },
  frontier: {
    minRadius: 0.25,
    maxRadius: 0.9,
    fitWidth: 0.35,
  },
  weights: {
    learningProgress: 0.2,
    predictionError: 0.2,
    actionAffordance: 0.25,
    frontierFit: 0.25,
    novelty: 0.15,
    selfSimilarityPenalty: 0.3,
    recursionPenalty: 0.3,
    noisePenalty: 0.25,
  },
  actionPolicy: {
    allowExternalActions: true,
    minimumSensingSteps: 3,
    maxAttemptsPerGoal: 2,
    retryCooldownMinutes: 240,
    runTimeoutSeconds: 900,
    activeHours: "always-on",
  },
  playground: {
    dirName: "wander-playground",
  },
  logging: {
    retentionDays: 100,
    maxStorageBytes: 10 * 1024 * 1024 * 1024,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function readString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  return isRecord(value) ? value : {};
}

export function resolveWanderConfig(pluginConfig: unknown): WanderConfig {
  const raw = isRecord(pluginConfig) ? pluginConfig : {};
  const d = DEFAULT_WANDER_CONFIG;

  const boredom = section(raw, "boredom");
  const budgets = section(raw, "budgets");
  const thresholds = section(raw, "thresholds");
  const generation = section(raw, "generation");
  const grounded = section(raw, "grounded");
  const embeddings = section(raw, "embeddings");
  const frontier = section(raw, "frontier");
  const weights = section(raw, "weights");
  const actionPolicy = section(raw, "actionPolicy");
  const playground = section(raw, "playground");
  const logging = section(raw, "logging");
  const activeWindowRaw = section(actionPolicy, "activeWindow");
  const activeWindow =
    typeof activeWindowRaw.start === "string" && typeof activeWindowRaw.end === "string"
      ? {
          start: activeWindowRaw.start,
          end: activeWindowRaw.end,
          ...(typeof activeWindowRaw.timeZone === "string"
            ? { timeZone: activeWindowRaw.timeZone }
            : {}),
        }
      : undefined;

  return {
    boredom: {
      enabled: readBoolean(boredom, "enabled", d.boredom.enabled),
      idleStartMinutes: readNumber(boredom, "idleStartMinutes", d.boredom.idleStartMinutes),
      saturationMinutes: readNumber(boredom, "saturationMinutes", d.boredom.saturationMinutes),
      wakeLevel: readNumber(boredom, "wakeLevel", d.boredom.wakeLevel),
      wakeCheckMinutes: readNumber(boredom, "wakeCheckMinutes", d.boredom.wakeCheckMinutes),
      wakeMinIntervalMinutes: readNumber(
        boredom,
        "wakeMinIntervalMinutes",
        d.boredom.wakeMinIntervalMinutes,
      ),
      satiationMinutes: readNumber(boredom, "satiationMinutes", d.boredom.satiationMinutes),
    },
    budgets: {
      autonomousRunsPerDay: readNumber(budgets, "autonomousRunsPerDay", d.budgets.autonomousRunsPerDay),
      autonomousTokensPerDay: readNumber(
        budgets,
        "autonomousTokensPerDay",
        d.budgets.autonomousTokensPerDay,
      ),
    },
    thresholds: {
      act: readNumber(thresholds, "act", d.thresholds.act),
      recentObservationWindowHours: readNumber(
        thresholds,
        "recentObservationWindowHours",
        d.thresholds.recentObservationWindowHours,
      ),
    },
    generation: {
      candidateCount: Math.max(
        2,
        Math.trunc(readNumber(generation, "candidateCount", d.generation.candidateCount)),
      ),
      timeoutSeconds: readNumber(generation, "timeoutSeconds", d.generation.timeoutSeconds),
      maxContextObservations: readNumber(
        generation,
        "maxContextObservations",
        d.generation.maxContextObservations,
      ),
      maxTerritorySummaryItems: readNumber(
        generation,
        "maxTerritorySummaryItems",
        d.generation.maxTerritorySummaryItems,
      ),
    },
    grounded: {
      unresolvedUserAsks: readBoolean(grounded, "unresolvedUserAsks", d.grounded.unresolvedUserAsks),
      failedToolAttempts: readBoolean(grounded, "failedToolAttempts", d.grounded.failedToolAttempts),
    },
    embeddings: {
      provider: "openai",
      model: readString(embeddings, "model", d.embeddings.model),
      apiKeyEnv: readString(embeddings, "apiKeyEnv", d.embeddings.apiKeyEnv),
      baseUrl: readString(embeddings, "baseUrl", d.embeddings.baseUrl),
    },
    frontier: {
      minRadius: readNumber(frontier, "minRadius", d.frontier.minRadius),
      maxRadius: readNumber(frontier, "maxRadius", d.frontier.maxRadius),
      fitWidth: Math.max(0.05, readNumber(frontier, "fitWidth", d.frontier.fitWidth)),
    },
    weights: {
      learningProgress: readNumber(weights, "learningProgress", d.weights.learningProgress),
      predictionError: readNumber(weights, "predictionError", d.weights.predictionError),
      actionAffordance: readNumber(weights, "actionAffordance", d.weights.actionAffordance),
      frontierFit: readNumber(weights, "frontierFit", d.weights.frontierFit),
      novelty: readNumber(weights, "novelty", d.weights.novelty),
      selfSimilarityPenalty: readNumber(
        weights,
        "selfSimilarityPenalty",
        d.weights.selfSimilarityPenalty,
      ),
      recursionPenalty: readNumber(weights, "recursionPenalty", d.weights.recursionPenalty),
      noisePenalty: readNumber(weights, "noisePenalty", d.weights.noisePenalty),
    },
    actionPolicy: {
      allowExternalActions: readBoolean(
        actionPolicy,
        "allowExternalActions",
        d.actionPolicy.allowExternalActions,
      ),
      minimumSensingSteps: Math.max(
        1,
        Math.trunc(
          readNumber(actionPolicy, "minimumSensingSteps", d.actionPolicy.minimumSensingSteps),
        ),
      ),
      maxAttemptsPerGoal: Math.max(
        1,
        Math.trunc(readNumber(actionPolicy, "maxAttemptsPerGoal", d.actionPolicy.maxAttemptsPerGoal)),
      ),
      retryCooldownMinutes: readNumber(
        actionPolicy,
        "retryCooldownMinutes",
        d.actionPolicy.retryCooldownMinutes,
      ),
      runTimeoutSeconds: readNumber(actionPolicy, "runTimeoutSeconds", d.actionPolicy.runTimeoutSeconds),
      activeHours:
        actionPolicy.activeHours === "configured-window" ? "configured-window" : "always-on",
      ...(activeWindow ? { activeWindow } : {}),
    },
    playground: {
      dirName: readString(playground, "dirName", d.playground.dirName),
    },
    logging: {
      retentionDays: readNumber(logging, "retentionDays", d.logging.retentionDays),
      maxStorageBytes: readNumber(logging, "maxStorageBytes", d.logging.maxStorageBytes),
    },
  };
}

function parseClockMinutes(value: string): number | null {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function getClockMinutes(now: number, timeZone: string | undefined): number {
  const date = new Date(now);
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date);
      const hour = Number(parts.find((part) => part.type === "hour")?.value);
      const minute = Number(parts.find((part) => part.type === "minute")?.value);
      if (Number.isFinite(hour) && Number.isFinite(minute)) {
        return hour * 60 + minute;
      }
    } catch {
      // Fall through to local time if the configured time zone is not supported.
    }
  }
  return date.getHours() * 60 + date.getMinutes();
}

export function isWithinActiveWindow(config: WanderConfig, now = Date.now()): boolean {
  if (config.actionPolicy.activeHours !== "configured-window") {
    return true;
  }
  const window = config.actionPolicy.activeWindow;
  if (!window) {
    return true;
  }
  const start = parseClockMinutes(window.start);
  const end = parseClockMinutes(window.end);
  if (start === null || end === null || start === end) {
    return true;
  }
  const current = getClockMinutes(now, window.timeZone);
  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}
