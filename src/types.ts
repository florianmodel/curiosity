export type GoalSource =
  | "self_authored_intention"
  | "bootstrap_exploration"
  | "unresolved_user_ask"
  | "stale_open_question"
  | "failed_tool_attempt"
  | "new_entity"
  | "low_coverage_surface"
  | "skill_opportunity"
  | "external_follow_up"
  | "idle_boredom";

export type GoalStatus =
  | "queued"
  | "selected"
  | "in_progress"
  | "completed"
  | "failed"
  | "paused";

export type ObservationKind =
  | "message_received"
  | "assistant_output"
  | "tool_success"
  | "tool_failure"
  | "message_sending"
  | "message_sent";

export type ExternalTargetPolicy =
  | "any-configured-surface"
  | "explicit-allowlist"
  | "research-web-only";

export type DisagreementFallback = "explore-anyway" | "defer" | "ask";

export type AutonomousStartNotificationConfig = {
  enabled: boolean;
  provider: "telegram";
  telegram?: {
    botToken?: string;
    chatId?: string;
    apiBaseUrl?: string;
    disableNotification?: boolean;
  };
  minIntervalMinutes: number;
  includeEvidence: boolean;
  observatoryBaseUrl?: string;
};

export type ActiveWindowConfig = {
  start: string;
  end: string;
  timeZone?: string;
};

export type GoalSourcesConfig = {
  bootstrapExploration: boolean;
  unresolvedUserAsks: boolean;
  staleOpenQuestions: boolean;
  failedToolAttempts: boolean;
  newlyDiscoveredEntities: boolean;
  lowCoverageSurfaces: boolean;
  skillOpportunities: boolean;
  externalFollowUps: boolean;
};

export type CuriosityConfig = {
  budgets: {
    autonomousRunsPerDay: number;
    autonomousTokensPerDay: number;
    externalActionsPerDay: number;
    externalActionsPerHour: number;
  };
  goalSources: GoalSourcesConfig;
  ensembleWeights: {
    novelty: number;
    uncertainty: number;
    progress: number;
    curriculum: number;
  };
  thresholds: {
    act: number;
    staleGoalHours: number;
    recentObservationWindowHours: number;
  };
  boredom: {
    enabled: boolean;
    idleStartMinutes: number;
    saturationMinutes: number;
    maxScoreBonus: number;
    wakeLevel: number;
    wakeCheckMinutes: number;
    wakeMinIntervalMinutes: number;
    satiationMinutes: number;
  };
  shadowModels: string[];
  logging: {
    retentionDays: number;
    maxStorageBytes: number;
    verbose: boolean;
  };
  actionPolicy: {
    allowExternalActions: boolean;
    externalTargetPolicy: ExternalTargetPolicy;
    disagreementFallback: DisagreementFallback;
    activeHours: "always-on" | "configured-window";
    activeWindow?: ActiveWindowConfig;
    minimumSensingSteps: number;
    maxAttemptsPerGoal: number;
    retryCooldownMinutes: number;
  };
  notifications: {
    autonomousStart: AutonomousStartNotificationConfig;
  };
};

export type ObservationRecord = {
  id: number;
  kind: ObservationKind;
  createdAt: number;
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  channelId?: string;
  toolName?: string;
  success?: boolean;
  content: string;
  metadata: Record<string, unknown>;
};

export type CandidateGoal = {
  source: GoalSource;
  title: string;
  evidence: string[];
  proposedAction: string;
  targetSurface: string;
  estimatedCost: number;
  risk: number;
  keywords: string[];
  metadata: Record<string, unknown>;
};

export type ScoreCard = {
  rnd_novelty: number;
  episodic_reachability: number;
  plan2explore_uncertainty: number;
  impact_progress: number;
  llm_curriculum_reflection: number;
  boredom_drive: number;
  novelty_composite: number;
  cost_penalty: number;
  risk_penalty: number;
  active_ensemble: number;
  shadow_rankings: Record<string, number>;
};

export type GoalRecord = {
  goalId: string;
  fingerprint: string;
  agentId: string;
  createdAt: number;
  source: GoalSource;
  title: string;
  evidence: string[];
  proposedAction: string;
  targetSurface: string;
  scoresByModel: ScoreCard;
  selectedByPolicy: string;
  estimatedCost: number;
  risk: number;
  status: GoalStatus;
  attempts: number;
  lastRunId?: string;
  outcome?: Record<string, unknown>;
  updatedAt: number;
};

export type BudgetUsage = {
  autonomousRuns24h: number;
  autonomousTokens24h: number;
  externalActions24h: number;
  externalActions1h: number;
};

export type BoredomState = {
  enabled: boolean;
  idleSince: number;
  idleMs: number;
  idleMinutes: number;
  rawLevel: number;
  level: number;
  scoreBonus: number;
  startsAfterMs: number;
  saturatesAfterMs: number;
  satiatedUntil?: number;
};

export type GoalSelectionDecision =
  | {
      selected: true;
      goal: GoalRecord;
      budgetUsage: BudgetUsage;
      candidateCount: number;
    }
  | {
      selected: false;
      reason:
        | "paused"
        | "budget_exhausted"
        | "no_candidates"
        | "below_threshold"
        | "retry_blocked"
        | "outside_active_hours";
      budgetUsage: BudgetUsage;
      candidateCount: number;
    };

export type QueueSnapshot = {
  paused: boolean;
  budgetUsage: BudgetUsage;
  boredom: BoredomState;
  goals: GoalRecord[];
};

export type RunUsageRecord = {
  runId: string;
  agentId: string;
  trigger: string;
  autonomous: boolean;
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

export type ObservatorySnapshot = QueueSnapshot & {
  generatedAt: number;
  workspaceDir: string;
  curiosityDir: string;
  retention: {
    retentionDays: number;
    maxStorageBytes: number;
  };
  recentRuns: RunUsageRecord[];
  recentEvents: AuditEventRecord[];
  recentObservations: ObservationRecord[];
};

export type ObservatoryRunDetail = {
  generatedAt: number;
  goal: GoalRecord | null;
  runUsage: RunUsageRecord | null;
  events: AuditEventRecord[];
  observations: ObservationRecord[];
};

export type CompareSnapshot = {
  windowMs: number;
  candidateCount: number;
  selectedCount: number;
  completedCount: number;
  failedCount: number;
  selectionRate: number;
  realizedNovelty: number;
  uncertaintyReduced: number;
  progressRealized: number;
  externalActionSuccess: number;
  reversalsFailures: number;
  humanInterventionRate: number;
  totalTokens: number;
  averageScores: Partial<Record<keyof ScoreCard, number>>;
};

export type ActiveAutonomousRun = {
  runId: string;
  goalId: string;
  agentId: string;
  selectedAt: number;
};
