import { describe, expect, it, vi } from "vitest";
import { MastodonClient, MastodonRateLimitError } from "./social.js";

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "manual"; signal?: AbortSignal } };

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const raw = JSON.stringify(body);
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => normalized.get(key.toLowerCase()) ?? null },
    text: async () => raw,
  } as unknown as Response;
}

function account(id = "acct-1") {
  return { id, username: "agent", acct: "agent@example.social", display_name: "Dedicated Agent", url: "https://example.social/@agent" };
}

function status(id = "status-1", overrides: Record<string, unknown> = {}) {
  return { id, url: `https://example.social/@agent/${id}`, created_at: "2026-09-11T10:00:00Z", visibility: "public", content: "<p>Hello</p>", account: account(), ...overrides };
}

function client(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: Call["init"]) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  });
  return { client: new MastodonClient({ baseUrl: "https://example.social", accessTokenEnv: "MASTODON_TOKEN" }, { fetch, env: { MASTODON_TOKEN: "secret-token" } }), calls, fetch };
}

describe("MastodonClient", () => {
  it("requires an HTTPS instance origin and never accepts a path or embedded credential", () => {
    expect(() => new MastodonClient({ baseUrl: "http://example.social", accessTokenEnv: "TOKEN" })).toThrow(/HTTPS/);
    expect(() => new MastodonClient({ baseUrl: "https://example.social/api", accessTokenEnv: "TOKEN" })).toThrow(/origin/);
    expect(() => new MastodonClient({ baseUrl: "https://user:pass@example.social", accessTokenEnv: "TOKEN" })).toThrow(/origin/);
  });

  it("verifies and normalizes the dedicated account without exposing raw payload", async () => {
    const { client } = clientFor(response(account()));
    await expect(client.execute({ action: "account_verify" })).resolves.toEqual({
      action: "account_verify",
      account: { id: "acct-1", acct: "agent@example.social", username: "agent", displayName: "Dedicated Agent", url: "https://example.social/@agent" },
    });
  });

  it("uses fixed instance paths, manual redirects, bounded limits, and bearer auth", async () => {
    const { client, calls } = clientFor(response([status(), status("status-2")]));
    await client.execute({ action: "discover_public_timeline", limit: 1000, local: true });
    expect(calls[0].url).toBe("https://example.social/api/v1/timelines/public?limit=40&local=true");
    expect(calls[0].url).not.toContain("secret-token");
    expect(calls[0].init?.redirect).toBe("manual");
    expect(calls[0].init?.headers?.authorization).toBe("Bearer secret-token");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("requires operation IDs and idempotency keys, and separates direct publishing", async () => {
    const { client, calls } = clientFor(response(status("published")));
    await expect(client.execute({ action: "publish", text: "A small observation", visibility: "public", operationId: "op-1" })).resolves.toMatchObject({ action: "publish", status: { id: "published" } });
    expect(calls[0].init?.headers?.["idempotency-key"]).toBe("op-1");
    expect(calls[0].init?.body).toContain("visibility=public");
    await expect(client.execute({ action: "publish", text: "dm", visibility: "direct", operationId: "op-2" })).rejects.toThrow(/direct action/);
    await expect(client.execute({ action: "publish", text: "missing", visibility: "public", operationId: "" })).rejects.toThrow(/operationId/);
  });

  it("routes mentions through verified reply/direct actions instead of public publish or unverified edit", async () => {
    const { client, fetch } = clientFor(response(status("unused")));
    await expect(client.execute({ action: "publish", text: "hello @someone", visibility: "public", operationId: "op-mention-1" })).rejects.toThrow(/@mentions/);
    await expect(client.execute({ action: "edit", targetId: "status-1", text: "edited @someone", operationId: "op-mention-2" })).rejects.toThrow(/@mentions/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("verifies one direct recipient and rejects additional mentions", async () => {
    const { client, calls } = clientFor((call) => call.url.endsWith("/accounts/acct-2") ? response({ ...account("acct-2"), acct: "one@remote.social" }) : response(status("dm-1", { visibility: "direct" })));
    await client.execute({ action: "direct", targetAccountId: "acct-2", text: "A private hello", visibility: "direct", operationId: "dm-op" });
    expect(calls.map(call => call.url)).toEqual(["https://example.social/api/v1/accounts/acct-2", "https://example.social/api/v1/statuses"]);
    expect(calls[1].init?.body).toContain("%40one%40remote.social+A+private+hello");
    await expect(client.execute({ action: "direct", targetAccountId: "acct-2", text: "hello @other", visibility: "direct", operationId: "dm-op-2" })).rejects.toThrow(/@mentions/);
    expect(calls).toHaveLength(3);
    expect(calls[2].url).toBe("https://example.social/api/v1/accounts/acct-2");
  });

  it("reads the parent before replying and preserves private visibility", async () => {
    const { client, calls } = clientFor((call) => call.url.endsWith("/statuses/parent") ? response(status("parent", { visibility: "private", account: { ...account(), acct: "author@example.social" } })) : response(status("reply-1", { visibility: "private" })));
    await client.execute({ action: "reply", targetId: "parent", text: "A careful response", visibility: "private", operationId: "reply-op" });
    expect(calls[0].url).toBe("https://example.social/api/v1/statuses/parent");
    expect(calls[1].init?.body).toContain("visibility=private");
    expect(calls[1].init?.body).toContain("in_reply_to_id=parent");
    await expect(client.execute({ action: "reply", targetId: "parent", text: "Do not widen", visibility: "public", operationId: "reply-op-2" })).rejects.toThrow(/remain private/);
  });

  it("surfaces Retry-After without retrying and does not echo server error bodies", async () => {
    const { client, fetch, calls } = clientFor(response({ error: "token=secret-token reflected" }, 429, { "retry-after": "30" }));
    await expect(client.execute({ action: "publish", text: "one attempt", visibility: "public", operationId: "rate-op" })).rejects.toBeInstanceOf(MastodonRateLimitError);
    await expect(client.execute({ action: "publish", text: "one attempt", visibility: "public", operationId: "rate-op-2" })).rejects.toMatchObject({ retryAfter: "30" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(calls[0].init?.headers?.authorization).toBe("Bearer secret-token");
    try {
      await client.execute({ action: "publish", text: "server", visibility: "public", operationId: "server-op" });
    } catch (error) {
      expect(error).toBeInstanceOf(MastodonRateLimitError);
      expect(String(error)).not.toContain("secret-token");
    }
  });

  it("bounds and normalizes thread, notification, and conversation responses", async () => {
    const { client } = clientFor((call) => {
      if (call.url.endsWith("/context")) return response({ ancestors: [status("a")], descendants: [status("d")] });
      if (call.url.includes("/notifications")) return response([{ id: "n1", type: "mention", account: account(), status: status() }]);
      return response([{ id: "c1", unread: true, accounts: [account()], last_status: status() }]);
    });
    await expect(client.execute({ action: "read_thread", targetId: "root" })).resolves.toMatchObject({ ancestors: [{ id: "a" }], descendants: [{ id: "d" }] });
    await expect(client.execute({ action: "read_notifications", limit: 2 })).resolves.toMatchObject({ notifications: [{ id: "n1", type: "mention" }] });
    await expect(client.execute({ action: "read_conversations", limit: 2 })).resolves.toMatchObject({ conversations: [{ id: "c1", unread: true }] });
  });

  it("cancels a streaming response when it exceeds the JSON size bound", async () => {
    let cancelled = false;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode("x".repeat(512 * 1024 + 1)));
        }
      },
      cancel() { cancelled = true; },
    });
    const { client } = clientFor(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.execute({ action: "account_verify" })).rejects.toThrow(/size limit/);
    expect(cancelled).toBe(true);
  });
});

function clientFor(result: Response | ((call: Call) => Response | Promise<Response>)) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: Call["init"]) => {
    const call = { url, init };
    calls.push(call);
    return typeof result === "function" ? result(call) : result;
  });
  const client = new MastodonClient({ baseUrl: "https://example.social", accessTokenEnv: "MASTODON_TOKEN" }, { fetch, env: { MASTODON_TOKEN: "secret-token" } });
  return { client, calls, fetch };
}
