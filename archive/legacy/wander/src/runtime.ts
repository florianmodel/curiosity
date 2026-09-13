import { WanderManager } from "./manager.js";
import type { WanderConfig } from "./types.js";

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

const managers = new Map<string, WanderManager>();

export async function getOrCreateManager(params: {
  workspaceDir: string;
  config: WanderConfig;
  logger: LoggerLike;
}): Promise<WanderManager> {
  const existing = managers.get(params.workspaceDir);
  if (existing) {
    existing.updateConfig(params.config);
    return existing;
  }
  const manager = new WanderManager({
    workspaceDir: params.workspaceDir,
    config: params.config,
    logger: params.logger,
  });
  managers.set(params.workspaceDir, manager);
  return manager;
}

export async function stopManagers() {
  for (const manager of managers.values()) {
    await manager.close();
  }
  managers.clear();
}
