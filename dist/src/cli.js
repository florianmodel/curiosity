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
function clampOutput(text, maxChars = 4000) {
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, 1000)}\n...[truncated]...\n${text.slice(-maxChars + 1018)}`;
}
function renderGoalRunMessage(goal) {
    const allowsWeb = goal.targetSurface === "web" ||
        goal.source === "self_directed_exploration" ||
        goal.source === "bootstrap_exploration";
    const allowsMaking = goal.targetSurface === "workspace" ||
        goal.source === "self_directed_exploration" ||
        goal.source === "bootstrap_exploration";
    return [
        "Run this autonomous curiosity goal as one bounded self-directed investigation.",
        "",
        `Goal ID: ${goal.goalId}`,
        `Title: ${goal.title}`,
        `Source: ${goal.source}`,
        `Target surface: ${goal.targetSurface}`,
        `Proposed action: ${goal.proposedAction}`,
        "",
        "Evidence:",
        ...goal.evidence.map((item) => `- ${item}`),
        "",
        "Autonomy brief:",
        "- Be genuinely curious. Do something more interesting than checking status when the goal calls for it.",
        "- Do one bounded pass and stop. Prefer a finished small thing over a sprawling plan.",
        ...(allowsWeb
            ? [
                "- You may browse the public web for research. Use a few reputable sources and include links in the summary.",
                "- Do not log in, buy anything, message people, publish, or mutate external systems.",
            ]
            : []),
        ...(allowsMaking
            ? [
                "- You may create or edit a small local artifact if useful: a note, poem, prototype, script, or demo.",
                "- Keep local changes reversible and explain exactly what file you touched.",
            ]
            : []),
        "- End with what you did, what surprised you, where the artifact or sources are, and the next clue.",
    ].join("\n");
}
async function runOpenClawAgent(params) {
    const { GatewayClient } = (await import("openclaw/plugin-sdk/gateway-runtime"));
    const timeoutMs = Math.max(10_000, (params.timeoutSeconds + 30) * 1000);
    return new Promise((resolve, reject) => {
        let client;
        let settled = false;
        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            void client.stopAndWait().finally(() => resolve(value));
        };
        const fail = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            void client.stopAndWait().finally(() => reject(err));
        };
        const timer = setTimeout(() => {
            fail(new Error(`gateway agent request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        client = new GatewayClient({
            url: params.gatewayUrl,
            requestTimeoutMs: timeoutMs,
            clientDisplayName: "Curiosity",
            onHelloOk: () => {
                client
                    .request("agent", {
                    message: params.message,
                    agentId: params.agentId,
                    timeout: params.timeoutSeconds,
                    idempotencyKey: params.runId,
                }, { expectFinal: true, timeoutMs })
                    .then((response) => {
                    clearTimeout(timer);
                    const payloads = response.result?.payloads ?? [];
                    const text = payloads
                        .map((payload) => [payload.text, payload.mediaUrl, ...(payload.mediaUrls ?? [])]
                        .filter(Boolean)
                        .join("\n"))
                        .filter(Boolean)
                        .join("\n\n");
                    finish({
                        exitCode: 0,
                        stdout: text || response.summary || JSON.stringify(response),
                        stderr: "",
                    });
                })
                    .catch((err) => {
                    clearTimeout(timer);
                    finish({
                        exitCode: 1,
                        stdout: "",
                        stderr: err instanceof Error ? err.message : String(err),
                    });
                });
            },
            onConnectError: (err) => {
                clearTimeout(timer);
                fail(err);
            },
        });
        client.start();
    });
}
async function selectGoal(params) {
    const decision = await params.manager.selectGoalForRun({
        agentId: params.agentId,
        runId: params.runId,
        trigger: "curiosity-cli",
    });
    const notification = decision.selected && params.notify
        ? await params.manager.notifyAutonomousStart({
            runId: params.runId,
            agentId: params.agentId,
            goal: decision.goal,
        })
        : undefined;
    return { ...decision, notification };
}
export async function registerCuriosityCli(params) {
    const workspaceDir = params.workspaceDir;
    if (!workspaceDir) {
        return;
    }
    const manager = async () => params.resolveManager(workspaceDir);
    const gatewayUrl = params.gatewayUrl?.trim() || "ws://127.0.0.1:18789";
    const defaultAgentId = params.defaultAgentId?.trim() || "main";
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
        .option("--agent <id>", "Agent id for the autonomous run")
        .option("--run-id <id>", "Run id to use for audit records")
        .option("--notify <boolean>", "Send configured start notification when a goal is selected", "true")
        .action(async (options) => {
        const runId = options.runId?.trim() || `curiosity-cli-${Date.now()}`;
        const agentId = options.agent?.trim() || defaultAgentId;
        const selectedManager = await manager();
        const decision = await selectGoal({
            manager: selectedManager,
            agentId,
            runId,
            notify: parseBooleanOption(options.notify, true),
        });
        printJson({
            ...decision,
            runId,
            agentId,
        });
    });
    curiosity
        .command("run")
        .description("Execute the next selected curiosity goal with an OpenClaw agent turn")
        .option("--agent <id>", "Agent id for the autonomous run")
        .option("--run-id <id>", "Run id to use for audit records")
        .option("--timeout <seconds>", "Agent command timeout in seconds", "900")
        .option("--select <boolean>", "Select a new goal when none is already selected", "true")
        .option("--notify <boolean>", "Send configured start notification for newly selected goals", "true")
        .action(async (options) => {
        const runId = options.runId?.trim() || `curiosity-run-${Date.now()}`;
        const agentId = options.agent?.trim() || defaultAgentId;
        const timeoutSeconds = Number.parseInt(options.timeout ?? "900", 10) || 900;
        const selectedManager = await manager();
        const selectedGoals = await selectedManager.listGoalsByStatus(["selected", "in_progress"], 10);
        const existing = selectedGoals.find((goal) => goal.agentId === agentId) ?? selectedGoals[0];
        const selection = existing
            ? {
                selected: true,
                goal: existing,
                reusedSelectedGoal: true,
                adoptedFromAgentId: existing.agentId === agentId ? undefined : existing.agentId,
            }
            : parseBooleanOption(options.select, true)
                ? await selectGoal({
                    manager: selectedManager,
                    agentId,
                    runId,
                    notify: parseBooleanOption(options.notify, true),
                })
                : { selected: false, reason: "no_selected_goal" };
        if (!selection.selected) {
            printJson({ selected: false, runId, agentId, reason: selection.reason });
            return;
        }
        await selectedManager.markGoalInProgress({
            goalId: selection.goal.goalId,
            runId,
            agentId,
        });
        const startedAt = Date.now();
        const result = await runOpenClawAgent({
            agentId,
            runId,
            message: renderGoalRunMessage(selection.goal),
            timeoutSeconds,
            gatewayUrl,
        });
        const success = result.exitCode === 0;
        await selectedManager.finalizeAutonomousRun({
            runId,
            goalId: selection.goal.goalId,
            agentId,
            trigger: "curiosity-cli-run",
            success,
            durationMs: Date.now() - startedAt,
            error: success ? undefined : clampOutput(result.stderr || result.stdout || "agent failed"),
        });
        await selectedManager.recordObservation({
            kind: success ? "assistant_output" : "tool_failure",
            runId,
            agentId,
            success,
            content: clampOutput(result.stdout || result.stderr),
            metadata: {
                command: "openclaw agent",
                exitCode: result.exitCode,
            },
        });
        printJson({
            selected: true,
            executed: true,
            success,
            runId,
            agentId,
            goalId: selection.goal.goalId,
            adoptedFromAgentId: "adoptedFromAgentId" in selection
                ? selection.adoptedFromAgentId
                : undefined,
            exitCode: result.exitCode,
            stdout: clampOutput(result.stdout),
            stderr: clampOutput(result.stderr),
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
