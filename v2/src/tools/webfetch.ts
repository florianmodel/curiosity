import net from "node:net";

const MAX_BYTES = 512 * 1024;
const MAX_TEXT = 6000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init?: { redirect?: string; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export function isBlockedUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `protocol ${url.protocol} not allowed`;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return `host ${host} is local`;
  if (net.isIPv4(host) && blockedIPv4(host)) return `host ${host} is a private address`;
  if (net.isIPv6(host) && blockedIPv6(host)) return `host ${host} is a private address`;
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice(7);
    if (net.isIPv4(mapped) && blockedIPv4(mapped)) return `host ${host} is a private address`;
  }
  return undefined;
}

function blockedIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function blockedIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

export async function guardedFetch(raw: string, fetchImpl: FetchLike = fetch as FetchLike) {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = isBlockedUrl(current);
    if (blocked) throw new Error(`Blocked ${current}: ${blocked}`);
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "curiosity-v2/0.2 (+autonomous agent; respects robots.txt and rate limits)" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect from ${current} without location`);
      current = new URL(location, current).toString();
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error(`Too many redirects fetching ${raw}`);
}

export function extractText(html: string): { title?: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|p|div|section|article|h[1-6]|li|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(withoutScripts).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return { title: titleMatch ? decodeEntities(titleMatch[1]).trim() : undefined, text };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export async function readPage(raw: string, fetchImpl: FetchLike = fetch as FetchLike) {
  const { response, finalUrl } = await guardedFetch(raw, fetchImpl);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^(text\/|application\/(json|xml|.+xml|xhtml))/i.test(contentType)) {
    throw new Error(`Unsupported content-type "${contentType}" at ${finalUrl}`);
  }
  const buffer = await response.arrayBuffer();
  const body = new TextDecoder().decode(buffer.slice(0, MAX_BYTES));
  const isHtml = /text\/html|.xhtml/i.test(contentType);
  const { title, text } = isHtml ? extractText(body) : { title: undefined, text: body };
  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[... truncated ${text.length - MAX_TEXT} chars]` : text;
  if (!response.ok && text.length === 0) throw new Error(`HTTP ${response.status} with empty body at ${finalUrl}`);
  return {
    url: raw,
    finalUrl,
    status: response.status,
    contentType,
    title,
    totalBytes: buffer.byteLength,
    text: clipped || `(empty page at ${finalUrl})`,
  };
}
