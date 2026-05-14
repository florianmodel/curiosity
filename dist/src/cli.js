import { parseWindowDuration } from "./config.js";
function printJson(value) {
    console.log(JSON.stringify(value, null, 2));
}
function parseBooleanOption(value, fallback) {
    if (value === undefined) {
        return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "n", "off"].includes(normalized)) {
        return false;
    }
    return fallback;
}
export async function registerCuriosityCli(params) {
    const workspaceDir = params.workspaceDir;
    if (!workspaceDir) {
        return;
    }
    const manager = async () => params.resolveManager(workspaceDir);
    const curiosity = params.program
        .command("curiosity")
        .description("Inspect and control autonomous curiosity behavior");
    curiosity
        .command("queue")
        .description("Inspect the curiosity goal queue and budget usage")
        .option("--limit <n>", "Maximum queue items to print", "20")
        .action(async (options) => {
        const payload = await (await manager()).queueSnapshot(Number.parseInt(options.limit ?? "20", 10) || 20);
        printJson(payload);
    });
    curiosity
        .command("inspect")
        .description("Inspect a curiosity goal or run by id")
        .argument("<id>", "Goal ID or run ID")
        .action(async (id) => {
        printJson(await (await manager()).inspectIdentifier(id));
    });
    curiosity
        .command("compare")
        .description("Compare curiosity scorer behavior over a rolling window")
        .option("--window <duration>", "Window like 30m, 6h, or 7d", "24h")
        .action(async (options) => {
        printJson(await (await manager()).compareWindow(parseWindowDuration(options.window)));
    });
    curiosity
        .command("tick")
        .description("Run one curiosity selection tick and optionally send the autonomous-start notice")
        .option("--agent <id>", "Agent id for the autonomous run", "default")
        .option("--run-id <id>", "Run id to use for audit records")
        .option("--notify <boolean>", "Send configured start notification when a goal is selected", "true")
        .action(async (options) => {
        const runId = options.runId?.trim() || `curiosity-cli-${Date.now()}`;
        const agentId = options.agent?.trim() || "default";
        const selectedManager = await manager();
        const decision = await selectedManager.selectGoalForRun({
            agentId,
            runId,
            trigger: "curiosity-cli",
        });
        const notify = parseBooleanOption(options.notify, true);
        const notification = decision.selected && notify
            ? await selectedManager.notifyAutonomousStart({
                runId,
                agentId,
                goal: decision.goal,
            })
            : undefined;
        printJson({
            ...decision,
            runId,
            agentId,
            notification,
        });
    });
    curiosity
        .command("pause")
        .description("Pause autonomous curiosity selection")
        .action(async () => {
        await (await manager()).setPaused(true);
        console.log("Curiosity autonomy paused.");
    });
    curiosity
        .command("resume")
        .description("Resume autonomous curiosity selection")
        .action(async () => {
        await (await manager()).setPaused(false);
        console.log("Curiosity autonomy resumed.");
    });
}
