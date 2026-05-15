declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginApi = {
    config: Record<string, unknown>;
    pluginConfig?: unknown;
    logger: {
      debug?: (message: string) => void;
      info?: (message: string) => void;
      warn?: (message: string) => void;
      error?: (message: string) => void;
    };
    registerTool: (tool: unknown, opts?: unknown) => void;
    registerCli: (registrar: unknown, opts?: unknown) => void;
    registerService: (service: unknown) => void;
    on: (name: string, handler: (...args: any[]) => unknown) => void;
    runtime?: {
      system?: {
        requestHeartbeatNow?: (params?: { reason?: string; agentId?: string }) => void;
      };
    };
  };

  export type OpenClawPluginService = {
    id: string;
    start?: (ctx: OpenClawPluginServiceContext) => Promise<void> | void;
    stop?: () => Promise<void> | void;
  };

  export type OpenClawPluginServiceContext = {
    workspaceDir?: string;
    stateDir?: string;
  };

  export type OpenClawPluginToolContext = {
    config?: Record<string, unknown>;
    runtimeConfig?: Record<string, unknown>;
    workspaceDir?: string;
    agentDir?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    messageChannel?: string;
    sandboxed?: boolean;
    browser?: {
      sandboxBridgeUrl?: string;
      allowHostControl?: boolean;
    };
  };

  export function definePluginEntry<T extends Record<string, unknown>>(entry: T): T;
}

declare module "openclaw/plugin-sdk/agent-runtime" {
  export function resolveAgentWorkspaceDir(
    config: Record<string, unknown>,
    agentId?: string,
  ): string;
  export function resolveDefaultAgentId(config: Record<string, unknown>): string;
}

declare module "openclaw/plugin-sdk/gateway-runtime" {
  export class GatewayClient {
    constructor(opts: {
      url?: string;
      requestTimeoutMs?: number;
      clientDisplayName?: string;
      onHelloOk?: () => void;
      onConnectError?: (err: Error) => void;
    });
    start(): void;
    stopAndWait(opts?: { timeoutMs?: number }): Promise<void>;
    request<T = Record<string, unknown>>(
      method: string,
      params?: unknown,
      opts?: { expectFinal?: boolean; timeoutMs?: number | null },
    ): Promise<T>;
  }
}
