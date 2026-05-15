import { describe, expect, it } from "vitest";
import { DEFAULT_CURIOSITY_CONFIG } from "./config.js";
import { scoreCandidate } from "./scoring.js";
import type { CandidateGoal } from "./types.js";

const observations = [
  {
    id: 1,
    kind: "message_received",
    createdAt: Date.now(),
    content: "Can you resolve the pending uncertainty?",
    metadata: { keywords: ["resolve", "pending", "uncertainty"] },
  },
] as const;

const baseCandidate: CandidateGoal = {
  source: "unresolved_user_ask",
  title: "Resolve user ask: pending uncertainty",
  evidence: ["Can you resolve the pending uncertainty?"],
  proposedAction:
    "Author one bounded intention from the available context, take the smallest useful sensing step, record what changed, and stop.",
  targetSurface: "workspace",
  estimatedCost: 300,
  risk: 0.1,
  keywords: ["pending", "uncertainty"],
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
