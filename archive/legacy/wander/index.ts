import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  type OpenClawPluginApi,
} from "./api.js";
import { registerWanderCli } from "./src/cli.js";
import { resolveWanderConfig } from "./src/config.js";
import { runWanderCycle } from "./src/executor.js";
import { getOrCreateManager, stopManagers } from "./src/runtime.js";

export const id = "wander";
export const name = "Wander";
export const description =
  "Radius-expanding autonomous curiosity for OpenClaw: the model authors its own candidate curiosities, an embedding-based frontier scorer picks one, and a persistent exploration map remembers where it has been.";

function summarizeUnknown(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveGatewayUrl(config: unknown): string {
  const envPort = process.env.OPENCLAW_GATEWAY_PORT?.trim();
  if (envPort) {
    return `ws://127.0.0.1:${envPort}`;
  }
  const root = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const gateway =
    root.gateway && typeof root.gateway === "object"
      ? (root.gateway as Record<string, unknown>)
      : {};
  const port =
    typeof gateway.port === "number" || typeof gateway.port === "string"
      ? String(gateway.port).trim()
      : "18789";
  return `ws://127.0.0.1:${port || "18789"}`;
}

export function register(api: OpenClawPluginApi) {
  const pluginConfig = resolveWanderConfig(api.pluginConfig);
  const gatewayUrl = resolveGatewayUrl(api.config);
  const defaultAgentId = resolveDefaultAgentId(api.config);

  const resolveWorkspaceDir = (workspaceDir?: string, agentId?: string) => {
    if (workspaceDir) {
      return workspaceDir;
    }
    return resolveAgentWorkspaceDir(api.config, agentId ?? defaultAgentId);
  };
  const resolveManager = (workspaceDir: string) =>
    getOrCreateManager({ workspaceDir, config: pluginConfig, logger: api.logger });
  const defaultWorkspaceDir = resolveWorkspaceDir();

  let wakeTimer: ReturnType<typeof setInterval> | null = null;
  let cycleInFlight = false;
  const stopWakeLoop = () => {
    if (!wakeTimer) {
      return;
    }
    clearInterval(wakeTimer);
    wakeTimer = null;
  };
  const startWakeLoop = (workspaceDir: string) => {
    stopWakeLoop();
    if (!pluginConfig.boredom.enabled) {
      return;
    }
    const tick = async () => {
      if (cycleInFlight) {
        return;
      }
      try {
        const manager = await resolveManager(workspaceDir);
        const decision = await manager.shouldWake();
        if (!decision.shouldWake) {
          return;
        }
        cycleInFlight = true;
        const result = await runWanderCycle({
          manager,
          agentId: defaultAgentId,
          gatewayUrl,
          trigger: "wander-boredom",
        });
        if (result.ran) {
          api.logger.info?.(
            `wander: cycle finished run=${result.runId} topic="${result.topic}" success=${String(result.success)} sensingSteps=${result.sensingSteps}`,
          );
        } else {
          api.logger.info?.(`wander: cycle skipped (${result.reason})`);
        }
      } catch (error) {
        api.logger.warn?.(`wander: cycle failed (${String(error)})`);
      } finally {
        cycleInFlight = false;
      }
    };
    const intervalMs = Math.max(5_000, pluginConfig.boredom.wakeCheckMinutes * 60 * 1000);
    wakeTimer = setInterval(() => {
      void tick();
    }, intervalMs);
    wakeTimer.unref?.();
  };

  api.registerCli(
    async ({ program, workspaceDir }: any) => {
      await registerWanderCli({
        program,
        workspaceDir: workspaceDir ?? defaultWorkspaceDir,
        gatewayUrl,
        defaultAgentId,
        resolveManager,
      });
    },
    {
      descriptors: [
        {
          name: "wander",
          description: "Inspect and control autonomous wander exploration",
          hasSubcommands: true,
        },
      ],
    },
  );

  api.registerService({
    id: "wander",
    start: async (ctx: any) => {
      const workspaceDir = resolveWorkspaceDir(ctx.workspaceDir);
      const manager = await resolveManager(workspaceDir);
      await manager.pruneRetention();
      await manager.getBoredomState();
      startWakeLoop(workspaceDir);
      api.logger.info?.("wander: service started");
    },
    stop: async () => {
      stopWakeLoop();
      await stopManagers();
      api.logger.info?.("wander: service stopped");
    },
  });

  // Observation hooks feed the idle/boredom signal and the self-context bundle.
  api.on("message_received", async (event: any, ctx: any) => {
    const manager = await resolveManager(resolveWorkspaceDir(undefined, ctx.agentId));
    await manager.recordObservation({
      kind: "message_received",
      agentId: ctx.agentId,
      channelId: ctx.channelId,
      content: event.content,
      metadata: { from: event.from, trigger: ctx.trigger },
    });
  });

  api.on("after_tool_call", async (event: any, ctx: any) => {
    const manager = await resolveManager(resolveWorkspaceDir(undefined, ctx.agentId));
    const activeRun = manager.getActiveRun(ctx.agentId);
    if (activeRun) {
      manager.noteSensingStep(ctx.agentId);
    }
    await manager.recordObservation({
      kind: event.error ? "tool_failure" : "tool_success",
      runId: activeRun?.runId,
      agentId: ctx.agentId,
      toolName: event.toolName,
      success: !event.error,
      content: summarizeUnknown(event.error ?? event.result),
      metadata: { durationMs: event.durationMs, trigger: ctx.trigger },
    });
  });

  api.on("message_sent", async (event: any, ctx: any) => {
    const manager = await resolveManager(resolveWorkspaceDir(undefined, ctx.agentId));
    await manager.recordObservation({
      kind: "message_sent",
      agentId: ctx.agentId,
      channelId: ctx.channelId,
      success: event.success,
      content: event.content,
      metadata: { to: event.to, error: event.error, trigger: ctx.trigger },
    });
  });

  api.on("llm_output", async (event: any, ctx: any) => {
    const manager = await resolveManager(resolveWorkspaceDir(ctx.workspaceDir, ctx.agentId));
    await manager.recordObservation({
      kind: "assistant_output",
      agentId: ctx.agentId,
      content: (event.assistantTexts ?? []).join("\n"),
      metadata: { provider: event.provider, model: event.model, trigger: ctx.trigger },
    });
    await manager.addRunTokens({
      agentId: ctx.agentId,
      inputTokens: event.usage?.input,
      outputTokens: event.usage?.output,
      totalTokens: event.usage?.total,
    });
  });

  // Hard token-budget stop for wander-driven runs only; user-driven work is untouched.
  api.on("before_tool_call", async (_event: any, ctx: any) => {
    const manager = await resolveManager(resolveWorkspaceDir(undefined, ctx.agentId));
    if (!manager.isAutonomousWindow(ctx.agentId)) {
      return;
    }
    const usage = await manager.getBudgetUsage();
    if (usage.autonomousTokens24h >= pluginConfig.budgets.autonomousTokensPerDay) {
      return {
        block: true,
        blockReason: "wander policy blocked the tool call: autonomous token budget exhausted",
      };
    }
  });
}

export const activate = register;

export default register;
