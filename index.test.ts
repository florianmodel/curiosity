import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api.js", () => ({
  resolveAgentWorkspaceDir: () => "/tmp/curiosity-workspace",
  resolveDefaultAgentId: () => "default",
}));

describe("curiosity plugin entry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("./src/runtime.js");
    vi.doUnmock("./src/executor.js");
  });

  it("registers hooks, tool, cli, and service surfaces", async () => {
    const register = (await import("./index.js")).default;
    const toolSpy = vi.fn();
    const cliSpy = vi.fn();
    const serviceSpy = vi.fn();
    const onSpy = vi.fn();

    register({
      config: {},
      pluginConfig: {},
      logger: {},
      registerTool: toolSpy,
      registerCli: cliSpy,
      registerService: serviceSpy,
      on: onSpy,
    } as any);

    expect(toolSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(serviceSpy).toHaveBeenCalledTimes(1);
    expect(onSpy).toHaveBeenCalledTimes(8);
  });

  it("extracts real configured surfaces without treating defaults as a channel", async () => {
    const { extractConfiguredSurfaces } = await import("./index.js");

    expect(
      extractConfiguredSurfaces({
        channels: {
          defaults: {},
          telegram: {},
          slack: {},
        },
        messageChannels: {
          default: {},
          discord: {},
        },
      }),
    ).toEqual(["telegram", "slack", "discord", "workspace"]);
  });

  it("runs the curiosity executor directly when boredom wakes the service", async () => {
    const executeCuriosityRun = vi.fn(async () => ({
      selected: false,
      runId: "curiosity-run-test",
      agentId: "default",
      reason: "no_candidates",
    }));
    const stopManagers = vi.fn();
    const manager = {
      pruneRetention: vi.fn(),
      getBoredomState: vi.fn(),
      shouldRequestBoredomWake: vi.fn(async () => ({
        shouldWake: true,
        reason: "boredom_ready",
        boredom: { level: 1 },
        budgetUsage: {},
      })),
      markBoredomWakeRequested: vi.fn(),
    };
    vi.doMock("./src/executor.js", () => ({ executeCuriosityRun }));
    vi.doMock("./src/runtime.js", () => ({
      clearActiveRun: vi.fn(),
      getActiveRun: vi.fn(),
      getOrCreateManager: vi.fn(async () => manager),
      getSoleActiveRun: vi.fn(),
      rememberActiveRun: vi.fn(),
      setRuntimeConfig: vi.fn(),
      stopManagers,
    }));

    const register = (await import("./index.js")).default;
    const serviceSpy = vi.fn();
    const requestHeartbeatNow = vi.fn();

    register({
      config: {},
      pluginConfig: {},
      logger: {},
      runtime: { system: { requestHeartbeatNow } },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: serviceSpy,
      on: vi.fn(),
    } as any);

    const service = serviceSpy.mock.calls[0]?.[0];
    await service.start({ workspaceDir: "/tmp/curiosity-workspace" });

    await vi.waitFor(() => {
      expect(executeCuriosityRun).toHaveBeenCalledTimes(1);
    });
    expect(executeCuriosityRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "default",
        gatewayUrl: "ws://127.0.0.1:18789",
        notifyStart: false,
        select: true,
        trigger: "curiosity-boredom-executor",
      }),
    );
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    await service.stop();
    expect(stopManagers).toHaveBeenCalled();
  });
});
