import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api.js", () => ({
  definePluginEntry: (entry: unknown) => entry,
  resolveAgentWorkspaceDir: () => "/tmp/curiosity-workspace",
  resolveDefaultAgentId: () => "default",
}));

describe("curiosity plugin entry", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers hooks, tool, cli, and service surfaces", async () => {
    const plugin = (await import("./index.js")).default;
    const toolSpy = vi.fn();
    const cliSpy = vi.fn();
    const serviceSpy = vi.fn();
    const onSpy = vi.fn();

    plugin.register({
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
});
