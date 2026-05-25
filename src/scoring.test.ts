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
    "Author one bounded intention from the available context, choose the topic by neutral opportunity rather than by the drive label, use available tools before narrating, produce one concrete reversible outcome or evidenced blocker, and stop.",
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

  it("rewards semantic frontier fit and penalizes self-reference under boredom", () => {
    const nearCandidate: CandidateGoal = {
      source: "stale_open_question",
      title: "Re-evaluate stale goal: Re-evaluate stale goal: inspect curiosity workspace",
      evidence: ["The recent loop keeps inspecting OpenClaw curiosity manager state."],
      proposedAction: baseCandidate.proposedAction,
      targetSurface: "workspace",
      estimatedCost: 220,
      risk: 0.2,
      keywords: ["curiosity", "workspace", "openclaw", "manager"],
      metadata: {},
    };
    const frontierCandidate: CandidateGoal = {
      source: "frontier_exploration",
      title: "Search beyond the current semantic frontier",
      evidence: ["Probe reachable seeds and choose one with prediction error."],
      proposedAction:
        "Probe reachable seed sources, reject boring seeds, then build or compare one artifact.",
      targetSurface: "web",
      estimatedCost: 520,
      risk: 0.16,
      keywords: ["frontier", "seed", "prediction", "artifact"],
      metadata: { semanticFrontier: true },
    };
    const context = {
      observations: [...observations],
      openGoals: [],
      recentToolNames: ["curiosity_inspect", "read"],
      boredomDrive: 1,
      selfContextKeywords: ["curiosity", "workspace", "openclaw", "manager", "stale", "goal"],
    };

    const near = scoreCandidate(nearCandidate, context, DEFAULT_CURIOSITY_CONFIG);
    const frontier = scoreCandidate(frontierCandidate, context, DEFAULT_CURIOSITY_CONFIG);

    expect(frontier.semantic_distance).toBeGreaterThan(near.semantic_distance);
    expect(near.self_reference_density).toBeGreaterThan(frontier.self_reference_density);
    expect(near.structural_recursion_penalty).toBeGreaterThan(0);
    expect(frontier.active_ensemble).toBeGreaterThan(near.active_ensemble);
  });
});
