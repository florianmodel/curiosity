import { describe, expect, it } from "vitest";
import { renderAutonomousGoalPrompt } from "./prompt.js";
import type { GoalRecord } from "./types.js";

const baseGoal: GoalRecord = {
  goalId: "goal-1",
  fingerprint: "self-authored|workspace|idle",
  agentId: "main",
  createdAt: Date.now(),
  source: "self_authored_intention",
  title: "Use idle time for one concrete autonomous outcome",
  evidence: ["Boredom level is 0.91 after a long idle window."],
  proposedAction:
    "Author one bounded intention from the available context, choose the topic by neutral opportunity rather than by the drive label, use available tools before narrating, produce one concrete reversible outcome or evidenced blocker, and stop.",
  targetSurface: "workspace",
  scoresByModel: {
    rnd_novelty: 0.8,
    episodic_reachability: 0.8,
    plan2explore_uncertainty: 0.7,
    impact_progress: 0.8,
    llm_curriculum_reflection: 0.7,
    boredom_drive: 0.91,
    semantic_distance: 0.7,
    self_reference_density: 0.1,
    frontier_radius: 0.75,
    frontier_fit: 0.9,
    prediction_error_proxy: 0.72,
    learning_progress_guess: 0.78,
    action_affordance: 0.7,
    structural_recursion_penalty: 0,
    novelty_composite: 0.8,
    cost_penalty: 0.02,
    risk_penalty: 0.01,
    active_ensemble: 0.93,
    shadow_rankings: {},
  },
  selectedByPolicy: "balanced_ensemble_v1",
  estimatedCost: 160,
  risk: 0.06,
  status: "selected",
  attempts: 1,
  lastRunId: "run-1",
  outcome: {},
  updatedAt: Date.now(),
};

describe("renderAutonomousGoalPrompt", () => {
  it("pushes boredom runs toward tool-backed outcomes without choosing a topic", () => {
    const prompt = renderAutonomousGoalPrompt({
      goal: baseGoal,
      budgetUsage: {
        autonomousRuns24h: 0,
        autonomousTokens24h: 0,
        externalActions24h: 0,
        externalActions1h: 0,
      },
      threshold: 0.6,
      minimumSensingSteps: 2,
    });

    expect(prompt).toContain("High boredom: prefer a completed outcome over orientation.");
    expect(prompt).toContain("Do not send a user-visible meta announcement before acting");
    expect(prompt).toContain("A scan is not enough by itself");
    expect(prompt).toContain("Choose the content domain by neutral opportunity selection");
    expect(prompt).toContain("use a research/web affordance first");
    expect(prompt).toContain("curiosity_inspect alone does not count");
  });
});
