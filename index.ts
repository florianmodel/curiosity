import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  type OpenClawPluginApi,
} from "./api.js";
import {
  curiosityPluginConfigSchemaJson,
  resolveCuriosityConfig,
} from "./src/config.js";
import { executeCuriosityRun } from "./src/executor.js";
import { renderAutonomousGoalPrompt, renderHeartbeatNoGoalPrompt } from "./src/prompt.js";
import {
  clearActiveRun,
  getActiveRun,
  getOrCreateManager,
  getSoleActiveRun,
  rememberActiveRun,
  setRuntimeConfig,
  stopManagers,
} from "./src/runtime.js";
import { createCuriosityInspectTool } from "./src/tool.js";
import { registerCuriosityCli } from "./src/cli.js";

function resolveWorkspaceDir(api: OpenClawPluginApi, workspaceDir?: string, agentId?: string) {
  if (workspaceDir) {
    return workspaceDir;
  }
  const resolvedAgentId = agentId ?? resolveDefaultAgentId(api.config);
  return resolveAgentWorkspaceDir(api.config, resolvedAgentId);
}

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
  const gateway = root.gateway && typeof root.gateway === "object"
    ? (root.gateway as Record<string, unknown>)
    : {};
  const port =
    typeof gateway.port === "number" || typeof gateway.port === "string"
      ? String(gateway.port).trim()
      : "18789";
  return `ws://127.0.0.1:${port || "18789"}`;
}

const NON_SURFACE_CONFIG_KEYS = new Set(["defaults", "default", "accounts"]);

export const id = "curiosity";
export const name = "Curiosity";
export const description = "Autonomous goal discovery and curiosity scoring overlay for OpenClaw.";
export const configSchema = curiosityPluginConfigSchemaJson;

export function extractConfiguredSurfaces(config: Record<string, unknown> | undefined): string[] {
  if (!config || typeof config !== "object") {
    return ["workspace"];
  }
  const root = config as Record<string, unknown>;
  const surfaces = new Set<string>();

  const candidates = ["channels", "messageChannels"];
  for (const key of candidates) {
    const value = root[key];
    if (typeof value !== "object" || value == null) {
      continue;
    }
    for (const surface of Object.keys(value as Record<string, unknown>)) {
      const normalized = surface.trim().toLowerCase();
      if (normalized && !NON_SURFACE_CONFIG_KEYS.has(normalized)) {
        surfaces.add(normalized);
      }
    }
  }

  surfaces.add("workspace");
  return [...surfaces];
}

export function register(api: OpenClawPluginApi) {
    const pluginConfig = resolveCuriosityConfig(api.pluginConfig);
    setRuntimeConfig(pluginConfig);
    const gatewayUrl = resolveGatewayUrl(api.config);

    const resolveManager = async (workspaceDir: string) =>
      getOrCreateManager({
        workspaceDir,
        config: pluginConfig,
        configuredSurfaces: extractConfiguredSurfaces(api.config as Record<string, unknown>),
        logger: api.logger,
      });
    let boredomWakeTimer: ReturnType<typeof setInterval> | null = null;
    let boredomRunInFlight = false;
    const stopBoredomWakeLoop = () => {
      if (!boredomWakeTimer) {
        return;
      }
      clearInterval(boredomWakeTimer);
      boredomWakeTimer = null;
    };
    const startBoredomWakeLoop = (workspaceDir: string) => {
      stopBoredomWakeLoop();
      if (!pluginConfig.boredom.enabled) {
        return;
      }
      const agentId = resolveDefaultAgentId(api.config);
      const runReason = "curiosity-boredom-executor";
      const tick = async () => {
        if (boredomRunInFlight) {
          return;
        }
        try {
          const manager = await resolveManager(workspaceDir);
          const decision = await manager.shouldRequestBoredomWake();
          if (!decision.shouldWake) {
            return;
          }
          boredomRunInFlight = true;
          await manager.markBoredomWakeRequested({
            runReason,
            agentId,
            boredom: decision.boredom,
          });
          const result = await executeCuriosityRun({
            manager,
            agentId,
            timeoutSeconds: 900,
            gatewayUrl,
            runtimeConfig: api.config,
            select: true,
            notifyStart: false,
            trigger: runReason,
          });
          if (!result.selected) {
            api.logger.info?.(`curiosity: autonomous executor did not select a goal (${result.reason})`);
          } else {
            api.logger.info?.(
              `curiosity: autonomous executor finished run ${result.runId} success=${String(result.success)}`,
            );
          }
        } catch (error) {
          api.logger.warn?.(`curiosity: autonomous executor failed (${String(error)})`);
        } finally {
          boredomRunInFlight = false;
        }
      };
      const intervalMs = Math.max(5_000, pluginConfig.boredom.wakeCheckMinutes * 60 * 1000);
      boredomWakeTimer = setInterval(() => {
        void tick();
      }, intervalMs);
      boredomWakeTimer.unref?.();
      void tick();
    };

    api.registerTool(
      (ctx: any) => {
        const workspaceDir = resolveWorkspaceDir(api, ctx.workspaceDir, ctx.agentId);
        return createCuriosityInspectTool({
          context: ctx,
          resolveManager,
          fallbackWorkspaceDir: workspaceDir,
        });
      },
      { name: "curiosity_inspect", optional: true },
    );

    api.registerCli(
      async ({ program, workspaceDir }: any) => {
        await registerCuriosityCli({
          program,
          workspaceDir: workspaceDir ?? resolveWorkspaceDir(api),
          gatewayUrl,
          defaultAgentId: resolveDefaultAgentId(api.config),
          runtimeConfig: api.config,
          resolveManager,
        });
      },
      {
        descriptors: [
          {
            name: "curiosity",
            description: "Inspect and control autonomous curiosity behavior",
            hasSubcommands: true,
          },
        ],
      },
    );

    api.registerService({
      id: "curiosity",
      start: async (ctx: any) => {
        setRuntimeConfig(pluginConfig);
        const workspaceDir = resolveWorkspaceDir(api, ctx.workspaceDir);
        const manager = await resolveManager(workspaceDir);
        await manager.pruneRetention();
        await manager.getBoredomState();
        startBoredomWakeLoop(workspaceDir);
        api.logger.info?.("curiosity: service started");
      },
      stop: async () => {
        stopBoredomWakeLoop();
        await stopManagers();
        api.logger.info?.("curiosity: service stopped");
      },
    });

    api.on("message_received", async (event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(api);
      const manager = await resolveManager(workspaceDir);
      await manager.recordObservation({
        kind: "message_received",
        channelId: ctx.channelId,
        content: event.content,
        metadata: {
          from: event.from,
          channelId: ctx.channelId,
          trigger: ctx.trigger,
        },
      });
    });

    api.on("before_prompt_build", async (_event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(api, ctx.workspaceDir, ctx.agentId);
      const manager = await resolveManager(workspaceDir);

      if (ctx.trigger === "heartbeat" && ctx.runId && ctx.agentId) {
        const decision = await manager.selectGoalForRun({
          agentId: ctx.agentId,
          runId: ctx.runId,
          trigger: ctx.trigger,
        });
        if (decision.selected) {
          rememberActiveRun({
            runId: ctx.runId,
            goalId: decision.goal.goalId,
            agentId: ctx.agentId,
            selectedAt: Date.now(),
          });
          await manager.notifyAutonomousStart({
            runId: ctx.runId,
            agentId: ctx.agentId,
            goal: decision.goal,
          });
          return {
            prependContext: renderAutonomousGoalPrompt({
              goal: decision.goal,
              budgetUsage: decision.budgetUsage,
              threshold: pluginConfig.thresholds.act,
              minimumSensingSteps: pluginConfig.actionPolicy.minimumSensingSteps,
            }),
          };
        }
        return {
          prependContext: renderHeartbeatNoGoalPrompt(decision.reason),
        };
      }

      const awareness = await manager.buildAwarenessContext();
      return awareness ? { prependContext: awareness } : undefined;
    });

    api.on("before_tool_call", async (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      const activeRun = getActiveRun(runId);
      const workspaceDir = resolveWorkspaceDir(api, undefined, activeRun?.agentId ?? ctx.agentId);
      const manager = await resolveManager(workspaceDir);
      const runGoal = activeRun ? null : runId ? await manager.findGoalByRunId(runId) : null;
      const activeGoal =
        !activeRun && !runGoal ? await manager.findActiveGoalForAgent(ctx.agentId) : null;
      if (!activeRun && !runGoal && !activeGoal) {
        return;
      }
      const allowed = await manager.canUseTool(activeRun?.runId ?? runId ?? "", event.toolName, {
        agentId: activeRun?.agentId ?? ctx.agentId,
      });
      if (!allowed.allowed) {
        return {
          block: true,
          blockReason: `curiosity policy blocked tool "${event.toolName}": ${allowed.reason}`,
        };
      }
    });

    api.on("after_tool_call", async (event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(api, undefined, ctx.agentId);
      const manager = await resolveManager(workspaceDir);
      await manager.recordObservation({
        kind: event.error ? "tool_failure" : "tool_success",
        runId:
          (
            await manager.resolveRunForAutonomousEvent({
              runId: event.runId ?? ctx.runId,
              agentId: ctx.agentId,
            })
          )?.runId ?? ctx.runId,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        toolName: event.toolName,
        success: !event.error,
        content: summarizeUnknown(event.error ?? event.result),
        metadata: {
          durationMs: event.durationMs,
          toolCallId: event.toolCallId,
          trigger: ctx.trigger,
        },
      });
    });

    api.on("message_sending", async (event, ctx) => {
      const activeRun = getSoleActiveRun();
      const workspaceDir = resolveWorkspaceDir(api);
      const manager = await resolveManager(workspaceDir);
      const runId = activeRun?.runId ?? ctx.runId;
      const runGoal = activeRun ? null : runId ? await manager.findGoalByRunId(runId) : null;
      await manager.recordObservation({
        kind: "message_sending",
        channelId: ctx.channelId,
        content: event.content,
        metadata: {
          to: event.to,
          channelId: ctx.channelId,
          trigger: ctx.trigger,
        },
      });
      const activeGoal =
        !activeRun && !runGoal ? await manager.findActiveGoalForAgent(ctx.agentId) : null;
      if (!activeRun && !runGoal && !activeGoal) {
        return;
      }
      const allowed = await manager.canSendMessage(
        activeRun?.runId ?? runId ?? "",
        ctx.channelId ?? event.to,
        event.to,
        { agentId: activeRun?.agentId ?? ctx.agentId },
      );
      if (!allowed.allowed) {
        return {
          cancel: true,
          content: `Curiosity policy blocked send to ${ctx.channelId ?? event.to}: ${allowed.reason}`,
        };
      }
    });

    api.on("message_sent", async (event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(api);
      const manager = await resolveManager(workspaceDir);
      await manager.recordObservation({
        kind: "message_sent",
        channelId: ctx.channelId,
        success: event.success,
        content: event.content,
        metadata: {
          to: event.to,
          error: event.error,
          channelId: ctx.channelId,
          trigger: ctx.trigger,
        },
      });
    });

    api.on("llm_output", async (event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(api, ctx.workspaceDir, ctx.agentId);
      const manager = await resolveManager(workspaceDir);
      const activeRun = getActiveRun(event.runId);
      const runGoal = activeRun ? null : await manager.findGoalByRunId(event.runId);
      const resolvedRun = await manager.resolveRunForAutonomousEvent({
        runId: event.runId,
        agentId: ctx.agentId,
      });
      const goalId = activeRun?.goalId ?? runGoal?.goalId ?? resolvedRun?.goalId;
      const observationRunId = activeRun?.runId ?? resolvedRun?.runId ?? event.runId;
      await manager.recordObservation({
        kind: "assistant_output",
        runId: observationRunId,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        content: event.assistantTexts.join("\n"),
        metadata: {
          provider: event.provider,
          model: event.model,
          trigger: ctx.trigger,
        },
      });
      await manager.updateRunTokens({
        runId: observationRunId,
        goalId,
        agentId: ctx.agentId ?? "unknown",
        trigger: ctx.trigger ?? "user",
        inputTokens: event.usage?.input,
        outputTokens: event.usage?.output,
        totalTokens: event.usage?.total,
      });
    });

    api.on("agent_end", async (event, ctx) => {
      const activeRun = getActiveRun(ctx.runId);
      if (!activeRun) {
        return;
      }
      const workspaceDir = resolveWorkspaceDir(api, ctx.workspaceDir, activeRun.agentId);
      const manager = await resolveManager(workspaceDir);
      const outcome = await manager.finalizeAutonomousRun({
        runId: activeRun.runId,
        goalId: activeRun.goalId,
        agentId: activeRun.agentId,
        trigger: ctx.trigger ?? "heartbeat",
        success: event.success,
        durationMs: event.durationMs,
        error: event.error,
      });
      const goal = await manager.findGoalByRunId(activeRun.runId);
      if (goal) {
        await manager.notifyAutonomousFinish({
          runId: activeRun.runId,
          agentId: activeRun.agentId,
          goal,
          success: outcome.success,
          error: outcome.error,
        });
      }
      clearActiveRun(ctx.runId);
    });
}

export const activate = register;

export default register;
