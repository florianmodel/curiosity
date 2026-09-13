import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

type GatewayClientInstance = {
  start: () => void;
  stopAndWait: (opts?: { timeoutMs?: number }) => Promise<void>;
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean; timeoutMs?: number | null },
  ) => Promise<T>;
};

type GatewayClientConstructor = new (opts: {
  url?: string;
  requestTimeoutMs?: number;
  clientDisplayName?: string;
  onHelloOk?: () => void;
  onConnectError?: (err: Error) => void;
}) => GatewayClientInstance;

export type AgentRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  meta?: Record<string, unknown>;
};

export type AgentToolSummary = {
  toolNames: string[];
  callCount: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function extractAgentToolSummary(meta: unknown): AgentToolSummary | null {
  const toolSummary = asRecord(asRecord(meta)?.toolSummary);
  if (!toolSummary) {
    return null;
  }
  const tools = Array.isArray(toolSummary.tools)
    ? toolSummary.tools
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const calls = typeof toolSummary.calls === "number" ? Math.trunc(toolSummary.calls) : tools.length;
  if (tools.length === 0 || calls <= 0) {
    return null;
  }
  return { toolNames: tools, callCount: Math.max(calls, tools.length) };
}

function normalizeImportError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function findOpenClawPackageRootFromPath(value: string): string | null {
  const normalized = path.resolve(value);
  const marker = `${path.sep}node_modules${path.sep}openclaw${path.sep}`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    return normalized.slice(0, markerIndex + marker.length - 1);
  }
  const suffix = `${path.sep}node_modules${path.sep}openclaw`;
  return normalized.endsWith(suffix) ? normalized : null;
}

function openClawPackageRootCandidates(): string[] {
  const candidates = new Set<string>();
  const envRoot = process.env.OPENCLAW_PACKAGE_ROOT?.trim();
  if (envRoot) {
    candidates.add(envRoot);
  }
  for (const arg of process.argv) {
    const root = findOpenClawPackageRootFromPath(arg);
    if (root) {
      candidates.add(root);
    }
  }
  const home = process.env.HOME?.trim();
  if (home) {
    candidates.add(path.join(home, ".npm-global", "lib", "node_modules", "openclaw"));
  }
  candidates.add("/usr/local/lib/node_modules/openclaw");
  candidates.add("/opt/homebrew/lib/node_modules/openclaw");
  candidates.add("/usr/lib/node_modules/openclaw");
  return [...candidates];
}

function npmGlobalRoot(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("npm", ["root", "-g"], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const root = stdout.trim();
      resolve(root || null);
    });
  });
}

async function importGatewayRuntimeFromOpenClawRoot(
  openclawRoot: string,
): Promise<{ GatewayClient: GatewayClientConstructor } | null> {
  try {
    const packageRequire = createRequire(pathToFileURL(path.join(openclawRoot, "package.json")).href);
    const resolved = packageRequire.resolve("openclaw/plugin-sdk/gateway-runtime");
    const imported = (await import(pathToFileURL(resolved).href)) as {
      GatewayClient?: GatewayClientConstructor;
      default?: { GatewayClient?: GatewayClientConstructor };
    };
    const GatewayClient = imported.GatewayClient ?? imported.default?.GatewayClient;
    return GatewayClient ? { GatewayClient } : null;
  } catch {
    return null;
  }
}

async function loadGatewayRuntime(): Promise<{ GatewayClient: GatewayClientConstructor }> {
  try {
    return (await import("openclaw/plugin-sdk/gateway-runtime")) as {
      GatewayClient: GatewayClientConstructor;
    };
  } catch (directError) {
    for (const root of openClawPackageRootCandidates()) {
      const runtime = await importGatewayRuntimeFromOpenClawRoot(root);
      if (runtime) {
        return runtime;
      }
    }
    const globalRoot = await npmGlobalRoot();
    if (globalRoot) {
      const runtime = await importGatewayRuntimeFromOpenClawRoot(path.join(globalRoot, "openclaw"));
      if (runtime) {
        return runtime;
      }
    }
    throw new Error(
      `Unable to load OpenClaw gateway runtime from local or global install (${normalizeImportError(directError)})`,
    );
  }
}

export async function runOpenClawAgent(params: {
  agentId: string;
  runId: string;
  message: string;
  timeoutSeconds: number;
  gatewayUrl: string;
}): Promise<AgentRunResult> {
  const { GatewayClient } = await loadGatewayRuntime();
  const timeoutMs = Math.max(10_000, (params.timeoutSeconds + 30) * 1000);

  return new Promise((resolve, reject) => {
    let client: GatewayClientInstance;
    let settled = false;
    const finish = (value: AgentRunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      void client.stopAndWait().finally(() => resolve(value));
    };
    const fail = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      void client.stopAndWait().finally(() => reject(err));
    };

    const timer = setTimeout(() => {
      fail(new Error(`gateway agent request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    client = new GatewayClient({
      url: params.gatewayUrl,
      requestTimeoutMs: timeoutMs,
      clientDisplayName: "Wander",
      onHelloOk: () => {
        client
          .request<{
            status?: string;
            summary?: string;
            result?: {
              payloads?: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }>;
              meta?: unknown;
            };
            meta?: unknown;
          }>(
            "agent",
            {
              message: params.message,
              agentId: params.agentId,
              timeout: params.timeoutSeconds,
              idempotencyKey: params.runId,
            },
            { expectFinal: true, timeoutMs },
          )
          .then((response) => {
            clearTimeout(timer);
            const payloads = response.result?.payloads ?? [];
            const text = payloads
              .map((payload) =>
                [payload.text, payload.mediaUrl, ...(payload.mediaUrls ?? [])]
                  .filter(Boolean)
                  .join("\n"),
              )
              .filter(Boolean)
              .join("\n\n");
            finish({
              exitCode: 0,
              stdout: text || response.summary || JSON.stringify(response),
              stderr: "",
              meta: asRecord(response.result?.meta) ?? asRecord(response.meta) ?? undefined,
            });
          })
          .catch((err) => {
            clearTimeout(timer);
            finish({
              exitCode: 1,
              stdout: "",
              stderr: err instanceof Error ? err.message : String(err),
            });
          });
      },
      onConnectError: (err) => {
        clearTimeout(timer);
        fail(err);
      },
    });
    client.start();
  });
}
