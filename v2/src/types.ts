export type Mode = "wander" | "follow" | "make" | "participate" | "reflect" | "self_modify";
export type InterestState = "forming" | "active" | "dormant" | "abandoned";
export type ProjectState = "imagined" | "active" | "paused" | "completed" | "abandoned";

export type V2Config = {
  enabled: boolean;
  stage: 0;
  wakeIntervalMinutes: number;
  maxAutonomousRunsPerDay: number;
  maxAutonomousTokensPerDay: number;
  allowPublicParticipation: boolean;
  allowDirectConversations: boolean;
  allowSelfModification: boolean;
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

export type Snapshot = {
  self?: SelfRevision;
  interests: Interest[];
  projects: Project[];
  recentExperiences: Experience[];
  relationships: Relationship[];
  artifacts: Artifact[];
  resourceRequests: ResourceRequest[];
  selfModifications: SelfModification[];
};
