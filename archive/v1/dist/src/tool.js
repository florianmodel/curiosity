import { parseWindowDuration } from "./config.js";
const CuriosityInspectSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        action: {
            type: "string",
            description: "Inspection action: queue, inspect, compare, pause, or resume.",
        },
        id: {
            type: "string",
            description: "Goal ID or run ID used by the inspect action.",
        },
        window: {
            type: "string",
            description: "Comparison window like 30m, 6h, or 7d.",
        },
        limit: {
            type: "number",
            description: "Maximum number of queue entries to return.",
            minimum: 1,
            maximum: 100,
        },
    },
};
function renderText(title, payload) {
    return `${title}\n\n${JSON.stringify(payload, null, 2)}`;
}
export function createCuriosityInspectTool(params) {
    return {
        name: "curiosity_inspect",
        description: "Inspect the curiosity goal queue, compare scorer behavior, or pause/resume autonomous curiosity.",
        parameters: CuriosityInspectSchema,
        execute: async (_toolCallId, rawParams) => {
            const workspaceDir = params.context?.workspaceDir ?? params.fallbackWorkspaceDir;
            if (!workspaceDir) {
                throw new Error("curiosity_inspect requires a workspaceDir");
            }
            const manager = await params.resolveManager(workspaceDir);
            const action = typeof rawParams.action === "string" && rawParams.action.trim()
                ? rawParams.action.trim().toLowerCase()
                : "queue";
            if (action === "pause") {
                await manager.setPaused(true);
                return { content: [{ type: "text", text: "Curiosity autonomy paused." }] };
            }
            if (action === "resume") {
                await manager.setPaused(false);
                return { content: [{ type: "text", text: "Curiosity autonomy resumed." }] };
            }
            if (action === "inspect") {
                const id = typeof rawParams.id === "string" ? rawParams.id.trim() : "";
                if (!id) {
                    throw new Error("curiosity_inspect action=inspect requires id");
                }
                const payload = await manager.inspectIdentifier(id);
                return { content: [{ type: "text", text: renderText("Curiosity inspect", payload) }] };
            }
            if (action === "compare") {
                const window = typeof rawParams.window === "string" ? parseWindowDuration(rawParams.window) : parseWindowDuration(undefined);
                const payload = await manager.compareWindow(window);
                return { content: [{ type: "text", text: renderText("Curiosity compare", payload) }] };
            }
            const limit = typeof rawParams.limit === "number" && Number.isFinite(rawParams.limit)
                ? Math.max(1, Math.min(100, Math.trunc(rawParams.limit)))
                : 20;
            const payload = await manager.queueSnapshot(limit);
            return { content: [{ type: "text", text: renderText("Curiosity queue", payload) }] };
        },
    };
}
