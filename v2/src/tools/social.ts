import { URL } from "node:url";

/** Operator supplied Mastodon instance and environment variable name.
 *
 * The access token is deliberately not part of this value. It is read from
 * the named environment variable only when a request is executed.
 */
export type MastodonConfig = {
  baseUrl: string;
  accessTokenEnv: string;
};

export type MastodonVisibility = "public" | "unlisted" | "private" | "direct";
export type MastodonSearchType = "accounts" | "statuses" | "hashtags";

/** Mastodon direct posts are audience-limited private mentions, not encrypted messages. */
export const MASTODON_DIRECT_VISIBILITY_NOTICE = "Mastodon direct visibility limits the audience to mentioned participants; it is not end-to-end encrypted.";

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "manual"; signal?: AbortSignal },
) => Promise<Response>;

export type MastodonAction =
  | { action: "account_verify" }
  | { action: "discover_public_timeline"; limit?: number; local?: boolean; maxId?: string; minId?: string; sinceId?: string }
  | { action: "search"; query: string; type?: MastodonSearchType; limit?: number; resolve?: boolean }
  | { action: "read_status"; targetId: string }
  | { action: "read_thread"; targetId: string }
  | { action: "read_notifications"; limit?: number; maxId?: string; minId?: string; sinceId?: string }
  | { action: "read_conversations"; limit?: number; maxId?: string; minId?: string; sinceId?: string }
  | { action: "publish"; text: string; visibility: MastodonVisibility; operationId: string; sensitive?: boolean; spoilerText?: string; language?: string }
  | { action: "reply"; targetId: string; text: string; visibility: MastodonVisibility; operationId: string; sensitive?: boolean; spoilerText?: string; language?: string }
  | { action: "direct"; targetAccountId: string; text: string; visibility: "direct"; operationId: string }
  | { action: "edit"; targetId: string; text: string; operationId: string; sensitive?: boolean; spoilerText?: string; language?: string };

export type MastodonAdapterOptions = {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
};

export type MastodonAccount = {
  id: string;
  acct: string;
  username: string;
  displayName: string;
  url?: string;
  locked?: boolean;
  bot?: boolean;
};

export type MastodonStatus = {
  id: string;
  url?: string;
  createdAt?: string;
  visibility?: MastodonVisibility;
  text: string;
  account: MastodonAccount;
  inReplyToId?: string;
  inReplyToAccountId?: string;
  repliesCount?: number;
  reblogsCount?: number;
  favouritesCount?: number;
  edited?: boolean;
};

export type MastodonNotification = {
  id: string;
  type: string;
  createdAt?: string;
  account?: MastodonAccount;
  status?: MastodonStatus;
};

export type MastodonResult =
  | { action: "account_verify"; account: MastodonAccount }
  | { action: "discover_public_timeline"; statuses: MastodonStatus[] }
  | { action: "search"; accounts: MastodonAccount[]; statuses: MastodonStatus[]; hashtags: string[] }
  | { action: "read_status"; status: MastodonStatus }
  | { action: "read_thread"; ancestors: MastodonStatus[]; descendants: MastodonStatus[] }
  | { action: "read_notifications"; notifications: MastodonNotification[] }
  | { action: "read_conversations"; conversations: Array<{ id: string; unread: boolean; accounts: MastodonAccount[]; lastStatus?: MastodonStatus }> }
  | { action: "publish" | "reply" | "direct" | "edit"; status: MastodonStatus };

export class MastodonRateLimitError extends Error {
  readonly retryAfter?: string;

  constructor(retryAfter?: string) {
    super(retryAfter ? `Mastodon rate limit reached; retry after ${retryAfter}` : "Mastodon rate limit reached");
    this.name = "MastodonRateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class MastodonHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`Mastodon API ${status}: ${message}`);
    this.name = "MastodonHttpError";
    this.status = status;
  }
}

const MAX_ITEMS = 40;
const MAX_TEXT = 2_000;
const MAX_RESPONSE_CHARS = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 20;
const VISIBILITIES = new Set<MastodonVisibility>(["public", "unlisted", "private", "direct"]);

function required(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function limit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("limit must be a finite number");
  return Math.max(1, Math.min(MAX_ITEMS, Math.trunc(value)));
}

function visibility(value: unknown): MastodonVisibility {
  if (!VISIBILITIES.has(value as MastodonVisibility)) throw new Error("visibility must be public, unlisted, private, or direct");
  return value as MastodonVisibility;
}

function text(value: unknown): string {
  return required(value, "text");
}

function rejectExtraMentions(value: string): void {
  if (/@[a-z0-9_]+(?:@[a-z0-9.-]+)?/i.test(value)) {
    throw new Error("message text must not contain @mentions; the adapter adds exactly one verified recipient");
  }
}

function id(value: unknown, name = "targetId"): string {
  return required(value, name).slice(0, 200);
}

function stripHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

function optionalString(value: unknown): string | undefined {
  const result = typeof value === "string" ? value.trim() : "";
  return result || undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function account(value: unknown): MastodonAccount {
  const raw = asRecord(value);
  return {
    id: required(raw.id, "account.id"),
    acct: required(raw.acct ?? raw.username, "account.acct"),
    username: required(raw.username ?? raw.acct, "account.username"),
    displayName: stripHtml(raw.display_name ?? raw.username ?? raw.acct),
    ...(optionalString(raw.url) ? { url: String(raw.url) } : {}),
    ...(typeof raw.locked === "boolean" ? { locked: raw.locked } : {}),
    ...(typeof raw.bot === "boolean" ? { bot: raw.bot } : {}),
  };
}

function status(value: unknown): MastodonStatus {
  const raw = asRecord(value);
  const rawAccount = raw.account;
  return {
    id: required(raw.id, "status.id"),
    ...(optionalString(raw.url) ? { url: String(raw.url) } : {}),
    ...(optionalString(raw.created_at) ? { createdAt: String(raw.created_at) } : {}),
    ...(VISIBILITIES.has(raw.visibility as MastodonVisibility) ? { visibility: raw.visibility as MastodonVisibility } : {}),
    text: stripHtml(raw.content ?? raw.text),
    account: account(rawAccount),
    ...(optionalString(raw.in_reply_to_id) ? { inReplyToId: String(raw.in_reply_to_id) } : {}),
    ...(optionalString(raw.in_reply_to_account_id) ? { inReplyToAccountId: String(raw.in_reply_to_account_id) } : {}),
    ...(typeof raw.replies_count === "number" ? { repliesCount: raw.replies_count } : {}),
    ...(typeof raw.reblogs_count === "number" ? { reblogsCount: raw.reblogs_count } : {}),
    ...(typeof raw.favourites_count === "number" ? { favouritesCount: raw.favourites_count } : {}),
    ...(Array.isArray(raw.edits) && raw.edits.length > 1 ? { edited: true } : {}),
  };
}

function queryParams(entries: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export class MastodonClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly config: MastodonConfig, options: MastodonAdapterOptions = {}) {
    const parsed = new URL(required(config.baseUrl, "baseUrl"));
    if (parsed.protocol !== "https:") throw new Error("baseUrl must use HTTPS");
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
      throw new Error("baseUrl must be an HTTPS instance origin without credentials, path, query, or fragment");
    }
    this.baseUrl = parsed.origin;
    this.fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
    this.env = options.env ?? process.env;
    required(config.accessTokenEnv, "accessTokenEnv");
  }

  async execute(input: MastodonAction): Promise<MastodonResult> {
    switch (input.action) {
      case "account_verify":
        return { action: input.action, account: account(await this.request("GET", "/api/v1/accounts/verify_credentials")) };
      case "discover_public_timeline":
        return { action: input.action, statuses: (await this.request("GET", `/api/v1/timelines/public${queryParams({ limit: limit(input.limit), local: input.local, max_id: optionalString(input.maxId), min_id: optionalString(input.minId), since_id: optionalString(input.sinceId) })}`) as unknown[]).slice(0, MAX_ITEMS).map(status) };
      case "search": {
        const query = required(input.query, "query");
        const raw = asRecord(await this.request("GET", `/api/v2/search${queryParams({ q: query, type: input.type, limit: limit(input.limit), resolve: input.resolve })}`));
        return {
          action: input.action,
          accounts: Array.isArray(raw.accounts) ? raw.accounts.slice(0, MAX_ITEMS).map(account) : [],
          statuses: Array.isArray(raw.statuses) ? raw.statuses.slice(0, MAX_ITEMS).map(status) : [],
          hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.slice(0, MAX_ITEMS).map(item => typeof item === "string" ? item.slice(0, 200) : String(asRecord(item).name ?? "")).filter(Boolean) : [],
        };
      }
      case "read_status":
        return { action: input.action, status: status(await this.request("GET", `/api/v1/statuses/${encodeURIComponent(id(input.targetId))}`)) };
      case "read_thread": {
        const raw = asRecord(await this.request("GET", `/api/v1/statuses/${encodeURIComponent(id(input.targetId))}/context`));
        return { action: input.action, ancestors: Array.isArray(raw.ancestors) ? raw.ancestors.slice(-MAX_ITEMS).map(status) : [], descendants: Array.isArray(raw.descendants) ? raw.descendants.slice(0, MAX_ITEMS).map(status) : [] };
      }
      case "read_notifications": {
        const raw = await this.request("GET", `/api/v1/notifications${queryParams({ limit: limit(input.limit), max_id: optionalString(input.maxId), min_id: optionalString(input.minId), since_id: optionalString(input.sinceId) })}`);
        return { action: input.action, notifications: Array.isArray(raw) ? raw.slice(0, MAX_ITEMS).map(notification) : [] };
      }
      case "read_conversations": {
        const raw = await this.request("GET", `/api/v1/conversations${queryParams({ limit: limit(input.limit), max_id: optionalString(input.maxId), min_id: optionalString(input.minId), since_id: optionalString(input.sinceId) })}`);
        return { action: input.action, conversations: Array.isArray(raw) ? raw.slice(0, MAX_ITEMS).map(conversation) : [] };
      }
      case "publish":
        {
          const requestedVisibility = visibility(input.visibility);
          if (requestedVisibility === "direct") throw new Error("publish does not accept direct visibility; use the direct action with one verified recipient");
          const body = text(input.text);
          rejectExtraMentions(body);
          return { action: input.action, status: await this.publish({ text: body, visibility: requestedVisibility, operationId: required(input.operationId, "operationId"), sensitive: input.sensitive, spoilerText: input.spoilerText, language: input.language }) };
        }
      case "reply":
        {
          const targetId = id(input.targetId);
          const parent = status(await this.request("GET", `/api/v1/statuses/${encodeURIComponent(targetId)}`));
          const requestedVisibility = visibility(input.visibility);
          if ((parent.visibility === "private" || parent.visibility === "direct") && requestedVisibility !== parent.visibility) {
            throw new Error(`reply visibility must remain ${parent.visibility} for a non-public parent`);
          }
          const body = text(input.text);
          rejectExtraMentions(body);
          return { action: input.action, status: await this.publish({ text: `@${parent.account.acct} ${body}`, visibility: requestedVisibility, operationId: required(input.operationId, "operationId"), inReplyToId: targetId, sensitive: input.sensitive, spoilerText: input.spoilerText, language: input.language }, requestedVisibility === "direct") };
        }
      case "direct": {
        const targetAccountId = id(input.targetAccountId, "targetAccountId");
        if (input.visibility !== "direct") throw new Error("direct messages require visibility=direct");
        const target = account(await this.request("GET", `/api/v1/accounts/${encodeURIComponent(targetAccountId)}`));
        const body = text(input.text);
        rejectExtraMentions(body);
        return { action: input.action, status: await this.publish({ text: `@${target.acct} ${body}`, visibility: "direct", operationId: required(input.operationId, "operationId") }, true) };
      }
      case "edit":
        required(input.operationId, "operationId");
        const editBody = text(input.text);
        rejectExtraMentions(editBody);
        return { action: input.action, status: status(await this.request("PUT", `/api/v1/statuses/${encodeURIComponent(id(input.targetId))}`, form({ status: editBody, sensitive: input.sensitive, spoiler_text: input.spoilerText, language: input.language }))) };
      default:
        return assertNever(input);
    }
  }

  private async publish(input: { text: string; visibility: MastodonVisibility; operationId: string; inReplyToId?: string; sensitive?: boolean; spoilerText?: string; language?: string }, allowDirect = false): Promise<MastodonStatus> {
    if (input.visibility === "direct" && !allowDirect) throw new Error("direct visibility requires the direct or direct-reply action");
    return status(await this.request("POST", "/api/v1/statuses", form({ status: input.text, visibility: input.visibility, in_reply_to_id: input.inReplyToId, sensitive: input.sensitive, spoiler_text: input.spoilerText, language: input.language }), input.operationId));
  }

  private url(path: string): string {
    return new URL(path, `${this.baseUrl}/`).toString();
  }

  private token(): string {
    const token = this.env[this.config.accessTokenEnv];
    return required(token, `environment variable ${this.config.accessTokenEnv}`);
  }

  private async request(method: string, path: string, body?: string, idempotencyKey?: string): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token()}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await this.fetchImpl(this.url(path), { method, headers, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(body === undefined ? {} : { body }) });
    if (response.status === 429) throw new MastodonRateLimitError(response.headers.get("retry-after") ?? undefined);
    if (!response.ok) {
      // Do not echo instance response bodies: they can contain reflected input
      // or sensitive server details. The status is enough for the parent loop.
      throw new MastodonHttpError(response.status, "request failed");
    }
    if (response.status === 204) return {};
    const bodyText = await readBoundedResponseText(response, MAX_RESPONSE_CHARS);
    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      throw new Error("Mastodon returned an invalid JSON response");
    }
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const stream = response.body;
  if (!stream) {
    // Real fetch responses have a body stream. This fallback keeps injected
    // test doubles useful while still rejecting an oversized materialized body.
    const bodyText = await response.text();
    if (new TextEncoder().encode(bodyText).byteLength > maxBytes) throw new Error("Mastodon response exceeded the adapter size limit");
    return bodyText;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return output + decoder.decode();
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("response too large");
        throw new Error("Mastodon response exceeded the adapter size limit");
      }
      output += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function form(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

function notification(value: unknown): MastodonNotification {
  const raw = asRecord(value);
  return {
    id: required(raw.id, "notification.id"),
    type: required(raw.type, "notification.type"),
    ...(optionalString(raw.created_at) ? { createdAt: String(raw.created_at) } : {}),
    ...(raw.account ? { account: account(raw.account) } : {}),
    ...(raw.status ? { status: status(raw.status) } : {}),
  };
}

function conversation(value: unknown): { id: string; unread: boolean; accounts: MastodonAccount[]; lastStatus?: MastodonStatus } {
  const raw = asRecord(value);
  return {
    id: required(raw.id, "conversation.id"),
    unread: raw.unread === true,
    accounts: Array.isArray(raw.accounts) ? raw.accounts.slice(0, MAX_ITEMS).map(account) : [],
    ...(raw.last_status ? { lastStatus: status(raw.last_status) } : {}),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Mastodon action ${(value as { action?: unknown }).action ?? "unknown"}`);
}
