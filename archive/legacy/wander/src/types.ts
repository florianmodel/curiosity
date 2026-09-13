export type WanderConfig = {
  boredom: {
    enabled: boolean;
    idleStartMinutes: number;
    saturationMinutes: number;
    wakeLevel: number;
    wakeCheckMinutes: number;
    wakeMinIntervalMinutes: number;
    satiationMinutes: number;
  };
  budgets: {
    autonomousRunsPerDay: number;
    autonomousTokensPerDay: number;
  };
  thresholds: {
    act: number;
    recentObservationWindowHours: number;
  };
  generation: {
    candidateCount: number;
    timeoutSeconds: number;
    maxContextObservations: number;
    maxTerritorySummaryItems: number;
  };
  grounded: {
    unresolvedUserAsks: boolean;
    failedToolAttempts: boolean;
  };
  embeddings: {
    provider: "openai";
    model: string;
    apiKeyEnv: string;
    baseUrl: string;
  };
  frontier: {
    minRadius: number;
    maxRadius: number;
    fitWidth: number;
  };
  weights: {
    learningProgress: number;
    predictionError: number;
    actionAffordance: number;
    frontierFit: number;
    novelty: number;
    selfSimilarityPenalty: number;
    recursionPenalty: number;
    noisePenalty: number;
  };
  actionPolicy: {
    allowExternalActions: boolean;
    minimumSensingSteps: number;
    maxAttemptsPerGoal: number;
    retryCooldownMinutes: number;
    runTimeoutSeconds: number;
    activeHours: "always-on" | "configured-window";
    activeWindow?: {
      start: string;
      end: string;
      timeZone?: string;
    };
  };
  playground: {
    dirName: string;
  };
  logging: {
    retentionDays: number;
    maxStorageBytes: number;
  };
};

export type CandidateOrigin = "llm_generated" | "unresolved_user_ask" | "failed_tool_attempt" | "manual";

/**
 * A candidate curiosity: a concrete topic plus a concrete way to start acting on it.
 * LLM-generated candidates carry real topical content; grounded candidates are
 * derived from observed user asks and failed tool attempts.
 */
export type Candidate = {
  origin: CandidateOrigin;
  topic: string;
  whyInteresting: string;
  firstAction: string;
  expectedArtifact: string;
  expectedSurprise: number;
  domain: string;
  evidence: string[];
  estimatedCost: number;
  risk: number;
};

export type ScoreCard = {
  semantic_distance: number;
  frontier_radius: number;
  frontier_fit: number;
  self_similarity: number;
  territory_novelty: number;
  learning_progress_prior: number;
  prediction_error_proxy: number;
  action_affordance: number;
  recursion_penalty: number;
  noise_penalty: number;
  saturation_penalty: number;
  cost_penalty: number;
  risk_penalty: number;
  curiosity_value: number;
  degraded_distance: boolean;
};

export type GoalStatus = "queued" | "selected" | "in_progress" | "completed" | "failed" | "rejected";

export type GoalRecord = {
  goalId: string;
  fingerprint: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  origin: CandidateOrigin;
  topic: string;
  whyInteresting: string;
  firstAction: string;
  expectedArtifact: string;
  expectedSurprise: number;
  domain: string;
  evidence: string[];
  estimatedCost: number;
  risk: number;
  scores: ScoreCard;
  status: GoalStatus;
  attempts: number;
  lastRunId?: string;
  outcome: Record<string, unknown>;
};

/** Structured self-report the agent is asked to end every wander run with. */
export type RunReport = {
  topic: string;
  summary: string;
  surprise: number;
  learningProgress: number;
  artifacts: string[];
  nextClue?: string;
  worthContinuing: boolean;
};

/** A region of explored territory in the persistent exploration map. */
export type TerritoryRecord = {
  territoryId: string;
  topic: string;
  summary: string;
  domain: string;
  vector: number[] | null;
  visits: number;
  firstVisitedAt: number;
  lastVisitedAt: number;
  learningProgress: number;
  saturation: number;
  artifacts: string[];
  runIds: string[];
};

export type ObservationKind =
  | "message_received"
  | "message_sent"
  | "assistant_output"
  | "tool_success"
  | "tool_failure";

export type ObservationRecord = {
  id: number;
  kind: ObservationKind;
  createdAt: number;
  runId?: string;
  agentId?: string;
  channelId?: string;
  toolName?: string;
  success?: boolean;
  content: string;
  metadata: Record<string, unknown>;
};

export type RunUsageRecord = {
  runId: string;
  agentId: string;
  trigger: string;
  kind: "generation" | "exploration" | "other";
  startedAt: number;
  endedAt?: number;
  success?: boolean;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type AuditEventRecord = {
  id?: number;
  ts: number;
  eventType: string;
  goalId?: string;
  runId?: string;
  payload: Record<string, unknown>;
};

export type BoredomState = {
  enabled: boolean;
  idleSince: number;
  idleMs: number;
  idleMinutes: number;
  rawLevel: number;
  level: number;
  startsAfterMs: number;
  saturatesAfterMs: number;
  satiatedUntil?: number;
};

export type BudgetUsage = {
  autonomousRuns24h: number;
  autonomousTokens24h: number;
};

export type WakeDecision = {
  shouldWake: boolean;
  reason: string;
  boredom: BoredomState;
  budgetUsage: BudgetUsage;
};

export type ActiveRun = {
  runId: string;
  goalId: string;
  agentId: string;
  startedAt: number;
  sensingSteps: number;
};

export type CycleResult =
  | { ran: false; reason: string }
  | {
      ran: true;
      runId: string;
      goalId: string;
      topic: string;
      success: boolean;
      sensingSteps: number;
      report: RunReport | null;
      candidateCount: number;
      error?: string;
    };
