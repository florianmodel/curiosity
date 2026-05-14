import { CuriosityManager } from "./manager.js";
import type { ActiveAutonomousRun, CuriosityConfig } from "./types.js";

type RuntimeState = {
  config: CuriosityConfig | null;
  managers: Map<string, CuriosityManager>;
  activeRuns: Map<string, ActiveAutonomousRun>;
};

const runtimeState: RuntimeState = {
  config: null,
  managers: new Map(),
  activeRuns: new Map(),
};

export function setRuntimeConfig(config: CuriosityConfig) {
  runtimeState.config = config;
}

export function getRuntimeConfig(): CuriosityConfig | null {
  return runtimeState.config;
}

export function rememberManager(workspaceDir: string, manager: CuriosityManager) {
  runtimeState.managers.set(workspaceDir, manager);
}

export function getRememberedManager(workspaceDir: string): CuriosityManager | null {
  return runtimeState.managers.get(workspaceDir) ?? null;
}

export function listRememberedManagers(): CuriosityManager[] {
  return [...runtimeState.managers.values()];
}

export function rememberActiveRun(run: ActiveAutonomousRun) {
  runtimeState.activeRuns.set(run.runId, run);
}

export function getActiveRun(runId: string | undefined): ActiveAutonomousRun | null {
  if (!runId) {
    return null;
  }
  return runtimeState.activeRuns.get(runId) ?? null;
}

export function getSoleActiveRun(): ActiveAutonomousRun | null {
  if (runtimeState.activeRuns.size !== 1) {
    return null;
  }
  return [...runtimeState.activeRuns.values()][0] ?? null;
}

export function clearActiveRun(runId: string | undefined) {
  if (!runId) {
    return;
  }
  runtimeState.activeRuns.delete(runId);
}

export async function getOrCreateManager(params: {
  workspaceDir: string;
  config: CuriosityConfig;
  configuredSurfaces?: string[];
  logger: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<CuriosityManager> {
  const existing = runtimeState.managers.get(params.workspaceDir);
  if (existing) {
    existing.updateConfig(params.config);
    existing.setConfiguredSurfaces(params.configuredSurfaces ?? []);
    return existing;
  }
  const manager = new CuriosityManager({
    workspaceDir: params.workspaceDir,
    config: params.config,
    configuredSurfaces: params.configuredSurfaces ?? [],
    logger: params.logger,
  });
  runtimeState.managers.set(params.workspaceDir, manager);
  return manager;
}

export async function stopManagers() {
  for (const manager of runtimeState.managers.values()) {
    await manager.close();
  }
  runtimeState.managers.clear();
  runtimeState.activeRuns.clear();
}
