import { CuriosityManager } from "./manager.js";
const runtimeState = {
    config: null,
    managers: new Map(),
    activeRuns: new Map(),
};
export function setRuntimeConfig(config) {
    runtimeState.config = config;
}
export function getRuntimeConfig() {
    return runtimeState.config;
}
export function rememberManager(workspaceDir, manager) {
    runtimeState.managers.set(workspaceDir, manager);
}
export function getRememberedManager(workspaceDir) {
    return runtimeState.managers.get(workspaceDir) ?? null;
}
export function listRememberedManagers() {
    return [...runtimeState.managers.values()];
}
export function rememberActiveRun(run) {
    runtimeState.activeRuns.set(run.runId, run);
}
export function getActiveRun(runId) {
    if (!runId) {
        return null;
    }
    return runtimeState.activeRuns.get(runId) ?? null;
}
export function getSoleActiveRun() {
    if (runtimeState.activeRuns.size !== 1) {
        return null;
    }
    return [...runtimeState.activeRuns.values()][0] ?? null;
}
export function clearActiveRun(runId) {
    if (!runId) {
        return;
    }
    runtimeState.activeRuns.delete(runId);
}
export async function getOrCreateManager(params) {
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
