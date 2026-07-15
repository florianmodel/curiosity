import { parseWindowDuration } from "./config.js";
import { executeCuriosityRun, selectCuriosityGoal } from "./executor.js";
import type { CuriosityManager } from "./manager.js";

type CliCommand = {
  description: (text: string) => CliCommand;
  option: (flags: string, description: string, defaultValue?: string) => CliCommand;
  action: (handler: (...args: any[]) => unknown) => CliCommand;
  argument: (name: string, description: string) => CliCommand;
  command: (name: string) => CliCommand;
};

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function parseBooleanOption(value: string | undefined, fallback: boolean): boolean {
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

export async function registerCuriosityCli(params: {
  program: {
    command: (name: string) => CliCommand;
  };
  workspaceDir?: string;
  gatewayUrl?: string;
  defaultAgentId?: string;
  runtimeConfig?: unknown;
  resolveManager: (workspaceDir: string) => Promise<CuriosityManager>;
}) {
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
    .action(async (options: { limit?: string }) => {
      const payload = await (await manager()).queueSnapshot(
        Number.parseInt(options.limit ?? "20", 10) || 20,
      );
      printJson(payload);
    });

  curiosity
    .command("inspect")
    .description("Inspect a curiosity goal or run by id")
    .argument("<id>", "Goal ID or run ID")
    .action(async (id: string) => {
      printJson(await (await manager()).inspectIdentifier(id));
    });

  curiosity
    .command("compare")
    .description("Compare curiosity scorer behavior over a rolling window")
    .option("--window <duration>", "Window like 30m, 6h, or 7d", "24h")
    .action(async (options: { window?: string }) => {
      printJson(await (await manager()).compareWindow(parseWindowDuration(options.window)));
    });

  curiosity
    .command("tick")
    .description("Run one curiosity selection tick and optionally send the autonomous-start notice")
    .option("--agent <id>", "Agent id for the autonomous run")
    .option("--run-id <id>", "Run id to use for audit records")
    .option("--notify <boolean>", "Send configured start notification when a goal is selected", "true")
    .option("--force <boolean>", "Ignore retry cooldown for a manual selection tick", "false")
    .action(async (options: { agent?: string; runId?: string; notify?: string; force?: string }) => {
      const runId = options.runId?.trim() || `curiosity-cli-${Date.now()}`;
      const agentId = options.agent?.trim() || defaultAgentId;
      const selectedManager = await manager();
      const decision = await selectCuriosityGoal({
        manager: selectedManager,
        agentId,
        runId,
        notify: parseBooleanOption(options.notify, true),
        force: parseBooleanOption(options.force, false),
        trigger: "curiosity-cli",
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
    .option("--force <boolean>", "Force-select the best candidate even below the act threshold", "false")
    .option("--surface <surface>", "Force a target surface such as web, search, browser, or workspace")
    .action(
      async (options: {
        agent?: string;
        runId?: string;
        timeout?: string;
        select?: string;
        notify?: string;
        force?: string;
        surface?: string;
      }) => {
        const runId = options.runId?.trim() || `curiosity-run-${Date.now()}`;
        const agentId = options.agent?.trim() || defaultAgentId;
        const timeoutSeconds = Number.parseInt(options.timeout ?? "900", 10) || 900;
        const result = await executeCuriosityRun({
          manager: await manager(),
          agentId,
          runId,
          timeoutSeconds,
          gatewayUrl,
          runtimeConfig: params.runtimeConfig,
          select: parseBooleanOption(options.select, true),
          notifyStart: parseBooleanOption(options.notify, true),
          force: parseBooleanOption(options.force, false),
          forcedSurface: options.surface?.trim() || undefined,
          trigger: "curiosity-cli-run",
        });
        printJson(result);
      },
    );

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
