import { describe, expect, it } from "vitest";
import { DEFAULT_CURIOSITY_CONFIG } from "./config.js";
import { scoreCandidate } from "./scoring.js";
import type { CandidateGoal } from "./types.js";

const observations = [
  {
    id: 1,
    kind: "message_received",
    createdAt: Date.now(),
    content: "Can you investigate the flaky deploy pipeline?",
    metadata: { keywords: ["investigate", "flaky", "deploy", "pipeline"] },
  },
] as const;

const baseCandidate: CandidateGoal = {
  source: "unresolved_user_ask",
  title: "Resolve user ask: investigate flaky deploy pipeline",
  evidence: ["Can you investigate the flaky deploy pipeline?"],
  proposedAction: "Investigate the ask and prepare a concrete follow-up.",
  targetSurface: "workspace",
  estimatedCost: 300,
  risk: 0.1,
  keywords: ["flaky", "deploy", "pipeline"],
  metadata: {},
};

describe("scoreCandidate", () => {
  it("assigns a high ensemble score to unresolved asks", () => {
    const score = scoreCandidate(
      baseCandidate,
      {
        observations: [...observations],
        openGoals: [],
        recentToolNames: [],
      },
      DEFAULT_CURIOSITY_CONFIG,
    );

    expect(score.active_ensemble).toBeGreaterThan(0.6);
    expect(score.plan2explore_uncertainty).toBeGreaterThan(0.5);
  });
});
