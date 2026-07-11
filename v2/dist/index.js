import { resolveConfig } from "./src/config.js";
import { renderAwarenessPrompt, renderDevelopmentPrompt } from "./src/prompt.js";
import { DevelopmentStore } from "./src/store.js";
import { createDevelopmentTool } from "./src/tool.js";
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
        if (ctx.trigger === "heartbeat" && ctx.runId)
            await getStore(workspace(api, ctx)).recordRunEnd(ctx.runId, event.success === true);
    });
}
export const activate = register;
export default register;
