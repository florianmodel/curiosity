import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./src/config.js";
import { renderAwarenessPrompt, renderDevelopmentPrompt } from "./src/prompt.js";
import { DevelopmentStore } from "./src/store.js";
import { createDevelopmentTool } from "./src/tool.js";

export const id = "curiosity-v2";
export const name = "Curiosity v2";
export const description = "Persistent autonomous interest, personality, project, relationship, and reflection development.";

function workspace(api: any, ctx?: any): string {
  return ctx?.workspaceDir ?? api.config?.agents?.defaults?.workspace ?? process.cwd();
}

export function register(api: OpenClawPluginApi) {
  const config = resolveConfig((api as any).pluginConfig);
  const stores = new Map<string, DevelopmentStore>();
  const getStore = (dir: string) => {
    let store = stores.get(dir);
    if (!store) { store = new DevelopmentStore(dir); stores.set(dir, store); }
    return store;
  };

  (api as any).registerTool((ctx: any) => createDevelopmentTool(getStore(workspace(api, ctx))), { name: "curiosity_v2", optional: true });
  let timer: ReturnType<typeof setInterval> | undefined;
  (api as any).registerService({
    id: "curiosity-v2",
    start: () => {
      if (!config.enabled) return;
      const request = () => (api as any).runtime?.system?.requestHeartbeatNow?.({ reason: "curiosity-v2-interval" });
      timer = setInterval(request, config.wakeIntervalMinutes * 60_000);
      timer.unref?.();
      request();
    },
    stop: () => { if (timer) clearInterval(timer); timer = undefined; },
  });
  (api as any).on("before_prompt_build", async (_event: unknown, ctx: any) => {
    if (!config.enabled) return;
    const store = getStore(workspace(api, ctx));
    const snapshot = await store.snapshot();
    if (ctx.trigger === "heartbeat") {
      const usage = await store.usage24h();
      if (usage.runs >= config.maxAutonomousRunsPerDay || usage.tokens >= config.maxAutonomousTokensPerDay) return;
      if (ctx.runId) await store.recordRunStart(ctx.runId);
      return { prependContext: renderDevelopmentPrompt(snapshot, config) };
    }
    const awareness = renderAwarenessPrompt(snapshot);
    return awareness ? { prependContext: awareness } : undefined;
  });
  (api as any).on("agent_end", async (event: any, ctx: any) => {
    if (ctx.trigger === "heartbeat" && ctx.runId) await getStore(workspace(api, ctx)).recordRunEnd(ctx.runId, event.success === true);
  });
}

export const activate = register;
export default register;
