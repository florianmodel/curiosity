import { runWanderCycle } from "./executor.js";
import type { WanderManager } from "./manager.js";

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

export async function registerWanderCli(params: {
  program: {
    command: (name: string) => CliCommand;
  };
  workspaceDir?: string;
  gatewayUrl?: string;
  defaultAgentId?: string;
  resolveManager: (workspaceDir: string) => Promise<WanderManager>;
}) {
  const workspaceDir = params.workspaceDir;
  if (!workspaceDir) {
    return;
  }
  const manager = async () => params.resolveManager(workspaceDir);
  const gatewayUrl = params.gatewayUrl?.trim() || "ws://127.0.0.1:18789";
  const defaultAgentId = params.defaultAgentId?.trim() || "main";

  const wander = params.program
    .command("wander")
    .description("Inspect and control autonomous wander exploration");

  wander
    .command("status")
    .description("Show boredom, budgets, embedding availability, and recent territory")
    .action(async () => {
      printJson(await (await manager()).statusSnapshot());
    });

  wander
    .command("queue")
    .description("Show recent candidate goals and their curiosity scores")
    .option("--limit <n>", "Maximum goals to print", "20")
    .action(async (options: { limit?: string }) => {
      printJson(await (await manager()).queueSnapshot(Number.parseInt(options.limit ?? "20", 10) || 20));
    });

  wander
    .command("map")
    .description("Show the persistent exploration map (visited territory)")
    .option("--limit <n>", "Maximum regions to print", "50")
    .action(async (options: { limit?: string }) => {
      printJson(await (await manager()).mapSnapshot(Number.parseInt(options.limit ?? "50", 10) || 50));
    });

  wander
    .command("inspect")
    .description("Inspect a goal or run by id, including its events and observations")
    .argument("<id>", "Goal ID or run ID")
    .action(async (id: string) => {
      printJson(await (await manager()).inspectIdentifier(id));
    });

  wander
    .command("generate")
    .description("Dry run: generate and score candidates without executing anything")
    .option("--agent <id>", "Agent id used for candidate generation")
    .action(async (options: { agent?: string }) => {
      const result = await runWanderCycle({
        manager: await manager(),
        agentId: options.agent?.trim() || defaultAgentId,
        gatewayUrl,
        trigger: "wander-cli-generate",
        force: true,
        dryRun: true,
      });
      printJson(result);
    });

  wander
    .command("run")
    .description("Run one full wander cycle now (generation, scoring, execution)")
    .option("--agent <id>", "Agent id for the autonomous run")
    .action(async (options: { agent?: string }) => {
      const result = await runWanderCycle({
        manager: await manager(),
        agentId: options.agent?.trim() || defaultAgentId,
        gatewayUrl,
        trigger: "wander-cli-run",
        force: true,
      });
      printJson(result);
    });

  wander
    .command("pause")
    .description("Pause autonomous wandering")
    .action(async () => {
      await (await manager()).setPaused(true);
      console.log("Wander autonomy paused.");
    });

  wander
    .command("resume")
    .description("Resume autonomous wandering")
    .action(async () => {
      await (await manager()).setPaused(false);
      console.log("Wander autonomy resumed.");
    });
}
