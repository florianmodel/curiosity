import type { BudgetUsage, GoalRecord } from "./types.js";

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function proactivityMode(goal: GoalRecord): string[] {
  const boredom = goal.scoresByModel.boredom_drive;
  if (boredom >= 0.85) {
    return [
      "High boredom: prefer a completed outcome over orientation.",
      "If a safe follow-through exists after sensing, take it in this run instead of stopping at inspection.",
    ];
  }
  if (boredom >= 0.55) {
    return [
      "Active autonomy: choose one specific, low-risk outcome you can actually complete now.",
      "A read-only scan is only useful when it leads to a concrete finding, check, artifact, or reversible local change.",
    ];
  }
  return [
    "Light curiosity: one careful tool-backed pass is enough when the available opportunity is still weak.",
  ];
}

export function renderAutonomousGoalPrompt(params: {
  goal: GoalRecord;
  budgetUsage: BudgetUsage;
  threshold: number;
  minimumSensingSteps: number;
}): string {
  const { goal, budgetUsage, threshold, minimumSensingSteps } = params;
  return [
    "## Self-Authored Curiosity Run",
    "This heartbeat is not a status check. Choose a bounded intention, then act through tools.",
    `Goal ID: ${goal.goalId}`,
    `Policy: ${goal.selectedByPolicy}`,
    `Act threshold: ${threshold.toFixed(2)}`,
    `Drive signal: ${goal.title}`,
    `Available surface: ${goal.targetSurface}`,
    "Run objective:",
    goal.proposedAction,
    "Current evidence:",
    bulletList(goal.evidence),
    "Score vector:",
    bulletList([
      `active_ensemble=${goal.scoresByModel.active_ensemble.toFixed(3)}`,
      `novelty=${goal.scoresByModel.novelty_composite.toFixed(3)}`,
      `uncertainty=${goal.scoresByModel.plan2explore_uncertainty.toFixed(3)}`,
      `progress=${goal.scoresByModel.impact_progress.toFixed(3)}`,
      `curriculum=${goal.scoresByModel.llm_curriculum_reflection.toFixed(3)}`,
      `boredom=${goal.scoresByModel.boredom_drive.toFixed(3)}`,
    ]),
    "Proactivity mode:",
    bulletList(proactivityMode(goal)),
    "Constraints:",
    bulletList([
      "Author the actual intention yourself from the available context; this prompt is only the drive signal.",
      "Choose the content domain by neutral opportunity selection: salience in local context, uncertainty, leverage, and reversibility. Do not treat the drive label as the topic.",
      "If the available surface is web, search, or browser, use a research/web affordance first unless none is safely available.",
      "Do not send a user-visible meta announcement before acting; start with an allowed tool call unless no safe tool affordance exists.",
      `Take at least ${minimumSensingSteps} qualifying low-risk tool-backed steps before concluding; curiosity_inspect alone does not count.`,
      "A scan is not enough by itself: after read-only sensing, either take one safe follow-through step that changes, creates, checks, or verifies something, or report the evidenced blocker.",
      "End with the concrete outcome and the evidence for it, not with a description of the policy.",
      "If no safe tool affordance exists, reply NO_SENSING_AFFORDANCE followed by the blocker.",
      "Pursue at most one autonomous intention in this run.",
      "Stay within existing OpenClaw safety, approvals, and tool policies.",
      `Remaining autonomous budgets are approximate: runs24h=${budgetUsage.autonomousRuns24h}, tokens24h=${budgetUsage.autonomousTokens24h}, external24h=${budgetUsage.externalActions24h}, external1h=${budgetUsage.externalActions1h}.`,
    ]),
  ].join("\n");
}

export function renderHeartbeatNoGoalPrompt(reason: string): string {
  return [
    "## Curiosity State",
    `No autonomous goal was selected for this heartbeat (${reason}).`,
    "Do not force exploration. If nothing clearly needs attention, reply HEARTBEAT_OK.",
  ].join("\n");
}

export function renderAwarenessPrompt(params: {
  activeGoals: GoalRecord[];
  recentFindings: GoalRecord[];
}): string | null {
  const { activeGoals, recentFindings } = params;
  if (activeGoals.length === 0 && recentFindings.length === 0) {
    return null;
  }
  const lines = ["## Curiosity Awareness"];
  if (activeGoals.length > 0) {
    lines.push("Active queued goals:");
    for (const goal of activeGoals.slice(0, 3)) {
      lines.push(
        `- ${goal.title} [${goal.status}] score=${goal.scoresByModel.active_ensemble.toFixed(3)} target=${goal.targetSurface}`,
      );
    }
  }
  if (recentFindings.length > 0) {
    lines.push("Recent autonomous findings:");
    for (const goal of recentFindings.slice(0, 3)) {
      lines.push(`- ${goal.title} [${goal.status}]`);
    }
  }
  lines.push("This section is advisory. User-directed work still takes precedence.");
  return lines.join("\n");
}
