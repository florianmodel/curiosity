import { parseWindowDuration } from "./config.js";
function printJson(value) {
    console.log(JSON.stringify(value, null, 2));
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
