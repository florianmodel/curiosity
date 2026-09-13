export type Mode = "wander" | "follow" | "make" | "participate" | "reflect" | "self_modify";
export type InterestState = "forming" | "active" | "dormant" | "abandoned";
export type ProjectState = "imagined" | "active" | "paused" | "completed" | "abandoned";

export type V2Config = {
  enabled: boolean;
  agentId: string;
  sessionMinutes: number;
  maxSocialActionsPerDay: number;
  maxDirectConversationsPerDay: number;
  mastodon?: { baseUrl: string; accessTokenEnv: string };
  stage: 0;
  wakeIntervalMinutes: number;
  maxAutonomousRunsPerDay: number;
  maxAutonomousTokensPerDay: number;
  allowPublicParticipation: boolean;
  allowDirectConversations: boolean;
  allowSelfModification: boolean;
  allowWebFetch: boolean;
  allowNotes: boolean;
  allowSearch: boolean;
  allowProjects: boolean;
};

export type SelfRevision = {
  revisionId: string;
  createdAt: number;
  narrative: string;
  traits: string[];
  tastes: string[];
  tensions: string[];
  evidence: string[];
};

export type Interest = {
  interestId: string;
  createdAt: number;
  updatedAt: number;
  state: InterestState;
  name: string;
  attraction: string;
  origin: string;
  currentUnderstanding: string;
  openQuestions: string[];
  predictions: string[];
  surprises: string[];
  connections: string[];
  returnCount: number;
  lastEngagedAt?: number;
  nextReturnAt?: number;
};

export type Project = {
  projectId: string;
  interestId?: string;
  createdAt: number;
  updatedAt: number;
  state: ProjectState;
  name: string;
  intention: string;
  nextMove: string;
  artifactIds: string[];
  nextReturnAt?: number;
};

export type Experience = {
  experienceId: string;
  runId: string;
  createdAt: number;
  mode: Mode;
  summary: string;
  evidence: string[];
  surprise?: string;
  consequence?: string;
  interestId?: string;
  projectId?: string;
};

export type Relationship = {
  relationshipId: string; createdAt: number; updatedAt: number;
  subject: string; context: string; history: string[]; commitments: string[];
  boundaries: string[]; lastContactAt?: number;
};

export type Artifact = {
  artifactId: string; createdAt: number; updatedAt: number;
  name: string; kind: string; location: string; description: string;
  interestId?: string; projectId?: string; public: boolean;
};

export type ResourceRequest = {
  requestId: string;
  createdAt: number;
  status: "recorded" | "dismissed" | "approved_later";
  resource: string;
  reason: string;
  expectedBenefit: string;
  estimatedPrice: string;
  freeAlternatives: string[];
};

export type SelfModification = {
  modificationId: string;
  createdAt: number;
  status: "proposed" | "tested" | "adopted" | "reverted" | "rejected";
  motivation: string;
  summary: string;
  files: string[];
  testEvidence: string[];
  rollback: string;
};

export type TurnAction = {
  kind: string;
  target?: string;
  outcome: string;
  evidence?: string[];
};

export type Turn = {
  turnId: string;
  runId?: string;
  createdAt: number;
  mode: Mode;
  action?: TurnAction;
  artifactIds?: string[];
  surprise?: string;
  nextHook?: { note: string; dueAt?: number; interestId?: string; projectId?: string };
  blockedReason?: string;
  quietReason?: string;
  quiet?: boolean;
};

export type Visit = {
  visitId: string;
  createdAt: number;
  kind: "web" | "file" | "other";
  location: string;
  note?: string;
};

export type DueHook = {
  refId: string;
  kind: "interest" | "project" | "followup";
  name: string;
  dueAt: number;
  hint?: string;
};

export type TimelineEvent = {
  eventId: string;
  runId?: string;
  createdAt: number;
  kind: string;
  toolName?: string;
  target?: string;
  outcome?: string;
  data?: unknown;
  success?: boolean;
};

export type Snapshot = {
  self?: SelfRevision;
  interests: Interest[];
  projects: Project[];
  recentExperiences: Experience[];
  relationships: Relationship[];
  artifacts: Artifact[];
  resourceRequests: ResourceRequest[];
  selfModifications: SelfModification[];
  turns: Turn[];
  visits: Visit[];
  dueHooks: DueHook[];
  events?: TimelineEvent[];
  followUps?: FollowUp[];
};

export type FollowUp = {
  followUpId: string; createdAt: number; updatedAt: number; note: string; dueAt: number;
  state: "pending" | "snoozed" | "completed" | "abandoned";
  interestId?: string; projectId?: string; target?: string; evidence?: string[];
};
