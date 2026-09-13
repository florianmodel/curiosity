function bulletList(items) {
    return items.map((item) => `- ${item}`).join("\n");
}
function proactivityMode(goal) {
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
export function renderAutonomousGoalPrompt(params) {
    const { goal, budgetUsage, threshold } = params;
    return [
        "## Self-Authored Curiosity Run",
        "This is a heartbeat-triggered autonomous run. The stored record is only a drive signal, not a task assignment.",
        `Goal ID: ${goal.goalId}`,
        `Policy: ${goal.selectedByPolicy}`,
        `Act threshold: ${threshold.toFixed(2)}`,
        `Drive label: ${goal.title}`,
        `Initial surface boundary: ${goal.targetSurface}`,
        "Run objective:",
        goal.proposedAction,
        "Drive evidence:",
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
            "Author your own concrete intention for this run from the current context and your memory; do not wait for a user-supplied topic.",
            "Choose the content domain by neutral opportunity selection: salience in local context, uncertainty, leverage, and reversibility. Do not treat the drive label as the topic.",
            "Do not send a user-visible meta announcement before acting; start with an allowed tool call unless no tool affordance exists.",
            "A scan is not enough by itself: after any read-only sensing step, either take one safe follow-through step that changes, creates, checks, or verifies something, or report the evidenced blocker.",
            "End with the concrete outcome and the evidence for it, not with a description of the policy.",
            "If no tool affordance exists, reply with NO_SENSING_AFFORDANCE followed by one sentence explaining the missing affordance.",
            "Pursue at most this one self-authored intention in this run.",
            "Stay within existing OpenClaw safety, approvals, and tool policies.",
            `Remaining autonomous budgets are approximate: runs24h=${budgetUsage.autonomousRuns24h}, tokens24h=${budgetUsage.autonomousTokens24h}, external24h=${budgetUsage.externalActions24h}, external1h=${budgetUsage.externalActions1h}.`,
        ]),
    ].join("\n");
}
export function renderHeartbeatNoGoalPrompt(reason) {
    return [
        "## Curiosity State",
        `No autonomous goal was selected for this heartbeat (${reason}).`,
        "Do not force exploration. If nothing clearly needs attention, reply HEARTBEAT_OK.",
    ].join("\n");
}
export function renderAwarenessPrompt(params) {
    const { activeGoals, recentFindings } = params;
    if (activeGoals.length === 0 && recentFindings.length === 0) {
        return null;
    }
    const lines = ["## Curiosity Awareness"];
    if (activeGoals.length > 0) {
        lines.push("Active queued goals:");
        for (const goal of activeGoals.slice(0, 3)) {
            lines.push(`- ${goal.title} [${goal.status}] score=${goal.scoresByModel.active_ensemble.toFixed(3)} target=${goal.targetSurface}`);
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
