import { resolveConfig } from "./src/config.js";
import { renderAwarenessPrompt, renderDevelopmentPrompt } from "./src/prompt.js";
import { DevelopmentStore } from "./src/store.js";
import { createDevelopmentTool } from "./src/tool.js";
import { NoteWriter } from "./src/tools/notewrite.js";
import { readPage } from "./src/tools/webfetch.js";
export const id = "curiosity-v2";
export const name = "Curiosity v2";
export const description = "Persistent autonomous interest, personality, project, relationship, and reflection development.";
function workspace(api, ctx) {
    return ctx?.workspaceDir ?? api.config?.agents?.defaults?.workspace ?? process.cwd();
}
export function register(api) {
    const config = resolveConfig(api.pluginConfig);
    const stores = new Map();
    const getStore = (dir) => {
        let store = stores.get(dir);
        if (!store) {
            store = new DevelopmentStore(dir);
            stores.set(dir, store);
        }
        return store;
    };
    api.registerTool((ctx) => createDevelopmentTool(getStore(workspace(api, ctx))), { name: "curiosity_v2", optional: true });
    if (config.allowWebFetch) {
        api.registerTool(() => ({
            name: "curiosity_web_fetch",
            description: "Read a public web page (http/https) and return its title and text. Blocked for local/private network addresses. Use it to explore, verify, and gather evidence.",
            parameters: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", description: "Absolute http(s) URL to fetch" } } },
            execute: async (_id, input) => {
                const page = await readPage(String(input.url ?? ""));
                return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
            },
        }), { name: "curiosity_web_fetch", optional: true });
    }
    if (config.allowNotes) {
        api.registerTool((ctx) => {
            const writer = new NoteWriter(workspace(api, ctx));
            return {
                name: "curiosity_note_write",
                description: "Create a durable artifact file under <workspace>/creations/<year-month>/<slug>.<ext>. Use for visible creations, notes from exploration, experiments.",
                parameters: {
                    type: "object", additionalProperties: false,
                    required: ["slug", "content"],
                    properties: {
                        slug: { type: "string", description: "Short lowercase filename slug, e.g. tide-pool-hypotheses" },
                        title: { type: "string", description: "Optional markdown H1 title" },
                        content: { type: "string", description: "Full file content" },
                        extension: { type: "string", enum: [...new Set(["md", "txt", "json", "html", "css", "js", "ts", "svg", "csv"])], description: "File extension, default md" },
                        overwrite: { type: "boolean", description: "Deliberately replace an existing file, default false" },
                    },
                },
                execute: async (_id, input) => {
                    const result = await writer.write(input);
                    return { content: [{ type: "text", text: `Wrote ${result.path} (${result.bytes} bytes).` }] };
                },
            };
        }, { name: "curiosity_note_write", optional: true });
    }
    let timer;
    api.registerService({
        id: "curiosity-v2",
        start: () => {
            if (!config.enabled)
                return;
            const request = () => api.runtime?.system?.requestHeartbeatNow?.({ reason: "curiosity-v2-interval" });
            timer = setInterval(request, config.wakeIntervalMinutes * 60_000);
            timer.unref?.();
            request();
        },
        stop: () => { if (timer)
            clearInterval(timer); timer = undefined; },
    });
    api.on("before_prompt_build", async (_event, ctx) => {
        if (!config.enabled)
            return;
        const store = getStore(workspace(api, ctx));
        const snapshot = await store.snapshot();
        if (ctx.trigger === "heartbeat") {
            const usage = await store.usage24h();
            if (usage.runs >= config.maxAutonomousRunsPerDay || usage.tokens >= config.maxAutonomousTokensPerDay)
                return;
            if (ctx.runId)
                await store.recordRunStart(ctx.runId);
            return { prependContext: renderDevelopmentPrompt(snapshot, config) };
        }
        const awareness = renderAwarenessPrompt(snapshot);
        return awareness ? { prependContext: awareness } : undefined;
    });
    api.on("agent_end", async (event, ctx) => {
        if (ctx.trigger === "heartbeat" && ctx.runId) {
            const tokens = Number(event?.tokens ?? event?.usage?.totalTokens ?? event?.usage?.tokens ?? 0);
            await getStore(workspace(api, ctx)).recordRunEnd(ctx.runId, event.success === true, Number.isFinite(tokens) ? tokens : 0);
        }
    });
}
export const activate = register;
export default register;
