const NO_SENSING_AFFORDANCE_TOKEN = "NO_SENSING_AFFORDANCE";
const WEB_TARGET_SURFACES = new Set(["web", "search", "browser"]);
const DEFAULT_WEB_TOOLS = ["web_search", "web_fetch", "browser"];
function parseSelectionReason(selection) {
    return selection.reason;
}
function asRecord(value) {
    return value && typeof value === "object" ? value : null;
}
function getPath(root, path) {
    let current = root;
    for (const key of path) {
        const record = asRecord(current);
        if (!record) {
            return undefined;
        }
        current = record[key];
    }
    return current;
}
function readStringArray(value) {
    if (!Array.isArray(value)) {
        return null;
    }
    return value
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}
function mergeAllowPolicy(allow, alsoAllow) {
    const allowList = readStringArray(allow);
    if (!allowList) {
        return null;
    }
    return [...allowList, ...(readStringArray(alsoAllow) ?? [])];
}
function findAgentConfig(runtimeConfig, agentId) {
    const normalizedAgentId = agentId?.trim();
    if (!normalizedAgentId) {
        return null;
    }
    const list = getPath(runtimeConfig, ["agents", "list"]);
    if (!Array.isArray(list)) {
        return null;
    }
    const entry = list.find((candidate) => {
        const record = asRecord(candidate);
        return typeof record?.id === "string" && record.id.trim() === normalizedAgentId;
    });
    return asRecord(entry);
}
function matchesToolPattern(toolName, pattern) {
    const normalizedPattern = pattern.trim().toLowerCase();
    if (!normalizedPattern || normalizedPattern === "*") {
        return true;
    }
    if (normalizedPattern === "group:web") {
        return (DEFAULT_WEB_TOOLS.includes(toolName) ||
            /(?:web|search|fetch|browser|crawl|scrape)/i.test(toolName));
    }
    if (!normalizedPattern.includes("*")) {
        return normalizedPattern === toolName;
    }
    const escaped = normalizedPattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${escaped}$`).test(toolName);
}
function isToolBlockedByList(toolName, patterns) {
    return Boolean(patterns?.some((pattern) => matchesToolPattern(toolName, pattern)));
}
function isToolAllowedByList(toolName, patterns) {
    return !patterns || patterns.some((pattern) => matchesToolPattern(toolName, pattern));
}
function webToolEnabledBySpecificConfig(runtimeConfig, toolName) {
    if (toolName === "browser" && getPath(runtimeConfig, ["browser", "enabled"]) === false) {
        return false;
    }
    if (toolName === "web_search") {
        return getPath(runtimeConfig, ["tools", "web", "search", "enabled"]) !== false;
    }
    if (toolName === "web_fetch") {
        return getPath(runtimeConfig, ["tools", "web", "fetch", "enabled"]) !== false;
    }
    return true;
}
export function availableWebSensingTools(runtimeConfig, agentId) {
    const agentConfig = findAgentConfig(runtimeConfig, agentId);
    const allowLists = [
        mergeAllowPolicy(getPath(runtimeConfig, ["tools", "allow"]), getPath(runtimeConfig, ["tools", "alsoAllow"])),
        readStringArray(getPath(runtimeConfig, ["gateway", "tools", "allow"])),
        mergeAllowPolicy(getPath(runtimeConfig, ["agents", "defaults", "tools", "allow"]), getPath(runtimeConfig, ["agents", "defaults", "tools", "alsoAllow"])),
        mergeAllowPolicy(getPath(agentConfig, ["tools", "allow"]), getPath(agentConfig, ["tools", "alsoAllow"])),
    ].filter((value) => value !== null);
    const denyLists = [
        readStringArray(getPath(runtimeConfig, ["tools", "deny"])),
        readStringArray(getPath(runtimeConfig, ["gateway", "tools", "deny"])),
        readStringArray(getPath(runtimeConfig, ["agents", "defaults", "tools", "deny"])),
        readStringArray(getPath(agentConfig, ["tools", "deny"])),
    ].filter((value) => value !== null);
    return DEFAULT_WEB_TOOLS.filter((toolName) => {
        if (!webToolEnabledBySpecificConfig(runtimeConfig, toolName)) {
            return false;
        }
        if (denyLists.some((patterns) => isToolBlockedByList(toolName, patterns))) {
            return false;
        }
        return allowLists.every((patterns) => isToolAllowedByList(toolName, patterns));
    });
}
function isWebTargetSurface(surface) {
    return WEB_TARGET_SURFACES.has(surface.trim().toLowerCase());
}
export function clampOutput(text, maxChars = 4000) {
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, 1000)}\n...[truncated]...\n${text.slice(-maxChars + 1018)}`;
}
export function renderGoalRunMessage(goal) {
    return [
        "Run this autonomous curiosity goal as one bounded self-directed investigation.",
        "",
        `Goal ID: ${goal.goalId}`,
        `Drive signal: ${goal.title}`,
        `Source: ${goal.source}`,
        `Target surface: ${goal.targetSurface}`,
        "",
        "Evidence:",
        ...goal.evidence.map((item) => `- ${item}`),
        "",
        "Autonomy brief:",
        "- Start by choosing the first allowed sensing tool call; do not spend the turn explaining the plan first.",
        "- If the target surface is web, search, or browser, use a research/web tool as the first sensing step unless none is safely available.",
        "- Do not satisfy this request with narrative alone; use available tools unless no safe tool affordance exists.",
        "- Author the actual intention yourself from the available context.",
        "- Take multiple low-risk sensing or inspection steps through allowed tools before concluding.",
        "- If no safe sensing affordance exists, reply NO_SENSING_AFFORDANCE followed by the blocker.",
        "- Do one bounded pass and stop.",
        "- End with what you did, what surprised you, and the next clue.",
    ].join("\n");
}
export async function runOpenClawAgent(params) {
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
export async function selectCuriosityGoal(params) {
    const decision = await params.manager.selectGoalForRun({
        agentId: params.agentId,
        runId: params.runId,
        trigger: params.trigger ?? "curiosity-executor",
        ignoreRetryBlocks: params.force === true,
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
export async function executeCuriosityRun(params) {
    const runId = params.runId?.trim() || `curiosity-run-${Date.now()}`;
    const selectedGoals = await params.manager.listGoalsByStatus(["selected", "in_progress"], 10);
    const existing = selectedGoals.find((goal) => goal.agentId === params.agentId) ?? selectedGoals[0];
    const selection = existing
        ? {
            selected: true,
            goal: existing,
            reusedSelectedGoal: true,
            adoptedFromAgentId: existing.agentId === params.agentId ? undefined : existing.agentId,
        }
        : params.select !== false
            ? await selectCuriosityGoal({
                manager: params.manager,
                agentId: params.agentId,
                runId,
                notify: params.notifyStart === true,
                force: params.force === true,
                trigger: params.trigger,
            })
            : { selected: false, reason: "no_selected_goal" };
    if (!selection.selected) {
        return {
            selected: false,
            runId,
            agentId: params.agentId,
            reason: parseSelectionReason(selection),
        };
    }
    await params.manager.markGoalInProgress({
        goalId: selection.goal.goalId,
        runId,
        agentId: params.agentId,
    });
    const startedAt = Date.now();
    const webTools = availableWebSensingTools(params.runtimeConfig, params.agentId);
    if (isWebTargetSurface(selection.goal.targetSurface) && webTools.length === 0) {
        const blocker = `${NO_SENSING_AFFORDANCE_TOKEN} Web exploration cannot run because no web/search/browser sensing tool is available in the current OpenClaw runtime configuration.`;
        await params.manager.recordObservation({
            kind: "assistant_output",
            runId,
            agentId: params.agentId,
            success: false,
            content: blocker,
            metadata: {
                trigger: params.trigger,
                preflight: "web_affordance",
            },
        });
        const outcome = await params.manager.finalizeAutonomousRun({
            runId,
            goalId: selection.goal.goalId,
            agentId: params.agentId,
            trigger: params.trigger,
            success: false,
            durationMs: Date.now() - startedAt,
            error: blocker,
        });
        const refreshedGoal = await params.manager.findGoalByRunId(runId);
        const resultNotice = refreshedGoal
            ? await params.manager.notifyAutonomousFinish({
                runId,
                agentId: params.agentId,
                goal: refreshedGoal,
                success: false,
                error: outcome.error,
            })
            : undefined;
        return {
            selected: true,
            executed: false,
            success: false,
            blocked: true,
            runId,
            agentId: params.agentId,
            goalId: selection.goal.goalId,
            adoptedFromAgentId: "adoptedFromAgentId" in selection ? selection.adoptedFromAgentId : undefined,
            blocker,
            outcome,
            resultNotice,
            startNotice: "notification" in selection ? selection.notification : undefined,
        };
    }
    const result = await runOpenClawAgent({
        agentId: params.agentId,
        runId,
        message: renderGoalRunMessage(selection.goal),
        timeoutSeconds: params.timeoutSeconds,
        gatewayUrl: params.gatewayUrl,
    });
    const success = result.exitCode === 0;
    await params.manager.recordObservation({
        kind: success ? "assistant_output" : "tool_failure",
        runId,
        agentId: params.agentId,
        success,
        content: clampOutput(result.stdout || result.stderr),
        metadata: {
            command: "openclaw agent",
            exitCode: result.exitCode,
        },
    });
    const outcome = await params.manager.finalizeAutonomousRun({
        runId,
        goalId: selection.goal.goalId,
        agentId: params.agentId,
        trigger: params.trigger,
        success,
        durationMs: Date.now() - startedAt,
        error: success ? undefined : clampOutput(result.stderr || result.stdout || "agent failed"),
    });
    const refreshedGoal = await params.manager.findGoalByRunId(runId);
    const resultNotice = refreshedGoal
        ? await params.manager.notifyAutonomousFinish({
            runId,
            agentId: params.agentId,
            goal: refreshedGoal,
            success: outcome.success,
            error: outcome.error,
            summary: outcome.success ? clampOutput(result.stdout) : undefined,
        })
        : undefined;
    return {
        selected: true,
        executed: true,
        success: outcome.success,
        runId,
        agentId: params.agentId,
        goalId: selection.goal.goalId,
        adoptedFromAgentId: "adoptedFromAgentId" in selection ? selection.adoptedFromAgentId : undefined,
        exitCode: result.exitCode,
        stdout: clampOutput(result.stdout),
        stderr: clampOutput(result.stderr),
        outcome,
        resultNotice,
        startNotice: "notification" in selection ? selection.notification : undefined,
    };
}
