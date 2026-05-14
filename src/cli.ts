import { parseWindowDuration } from "./config.js";
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

export async function registerCuriosityCli(params: {
  program: {
    command: (name: string) => CliCommand;
  };
  workspaceDir?: string;
  resolveManager: (workspaceDir: string) => Promise<CuriosityManager>;
}) {
  const workspaceDir = params.workspaceDir;
  if (!workspaceDir) {
    return;
  }

  const manager = async () => params.resolveManager(workspaceDir);

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
