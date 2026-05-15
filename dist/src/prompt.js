function bulletList(items) {
    return items.map((item) => `- ${item}`).join("\n");
}
export function renderAutonomousGoalPrompt(params) {
    const { goal, budgetUsage, threshold } = params;
    return [
        "## Self-Authored Curiosity Run",
        "This heartbeat is available for one bounded internally chosen curiosity move.",
        `Goal ID: ${goal.goalId}`,
        `Policy: ${goal.selectedByPolicy}`,
        `Act threshold: ${threshold.toFixed(2)}`,
        `Drive signal: ${goal.title}`,
        `Available surface: ${goal.targetSurface}`,
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
        "Constraints:",
        bulletList([
            "Author the actual intention yourself from the available context; this prompt is only a drive signal.",
            "Take at least one low-risk sensing or inspection step through an allowed tool before concluding.",
            "If no safe sensing affordance exists, reply NO_SENSING_AFFORDANCE followed by the blocker.",
            "Pursue at most one autonomous intention in this run.",
            "Stay within existing OpenClaw safety, approvals, and tool policies.",
            `Remaining autonomous budgets are approximate: runs24h=${budgetUsage.autonomousRuns24h}, tokens24h=${budgetUsage.autonomousTokens24h}, external24h=${budgetUsage.externalActions24h}, external1h=${budgetUsage.externalActions1h}.`,
            "If you cannot make meaningful progress, reply HEARTBEAT_OK.",
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
