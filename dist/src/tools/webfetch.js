import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_RESPONSE_TEXT = 6000;
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_LINKS = 50;
function blockedIPv4(host) {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return true;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127);
}
function blockedIPv6(host) {
    // Only globally routable unicast IPv6. Reject mapped/translated IPv4 and
    // special-use ranges rather than allowing a private IPv4 destination in hex.
    let normalized;
    try {
        normalized = new URL(`http://[${host.replace(/^\[|\]$/g, "")}]`).hostname.slice(1, -1).toLowerCase();
    }
    catch {
        return true;
    }
    return !/^[23][0-9a-f]{3}:/.test(normalized) || normalized.startsWith("2001:db8:");
}
function blockedAddress(address) {
    const family = net.isIP(address);
    return family === 4 ? blockedIPv4(address) : family === 6 ? blockedIPv6(address) : true;
}
function hostnameFor(url) {
    return url.hostname.replace(/^\[|\]$/g, "");
}
/** Synchronous syntax check. DNS-rebinding protection is performed before each request. */
export function isBlockedUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return "not a valid URL";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        return `protocol ${url.protocol} not allowed`;
    if (url.username || url.password)
        return "credentials in URL are not allowed";
    const host = hostnameFor(url).toLowerCase();
    if (!host)
        return "missing host";
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
        return `host ${host} is local`;
    }
    if (net.isIPv4(host) && blockedIPv4(host))
        return `host ${host} is a private address`;
    if (net.isIPv6(host) && blockedIPv6(host))
        return `host ${host} is a private address`;
    return undefined;
}
async function resolvePublicHost(raw, lookup) {
    const blocked = isBlockedUrl(raw);
    if (blocked)
        throw new Error(`Blocked ${raw}: ${blocked}`);
    const url = new URL(raw);
    const hostname = hostnameFor(url);
    const literalFamily = net.isIP(hostname);
    if (literalFamily)
        return { address: hostname, family: literalFamily };
    let addresses;
    try {
        addresses = await lookup(hostname, { all: true, verbatim: true });
    }
    catch (error) {
        throw new Error(`DNS lookup failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (addresses.length === 0)
        throw new Error(`DNS lookup returned no addresses for ${hostname}`);
    const privateAddress = addresses.find((entry) => blockedAddress(entry.address));
    if (privateAddress)
        throw new Error(`Blocked ${raw}: ${hostname} resolves to a private address (${privateAddress.address})`);
    return addresses[0];
}
/**
 * Native requester used in production. It passes the checked address to the
 * socket lookup callback, so the DNS result checked above is the address used
 * for this request. Tests and host integrations may inject another FetchLike.
 */
async function nativeFetch(input, init = {}) {
    const url = new URL(input);
    const transport = url.protocol === "https:" ? https : http;
    const address = init.lookupAddress;
    const hostname = hostnameFor(url);
    return await new Promise((resolve, reject) => {
        const requestOptions = {
            protocol: url.protocol,
            hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: init.headers,
            signal: init.signal,
            ...(url.protocol === "https:" && !net.isIP(hostname) ? { servername: hostname } : {}),
            autoSelectFamily: false,
            ...(address ? { lookup: ((_hostname, _options, callback) => callback(null, address.address, address.family)) } : {}),
        };
        const request = transport.request(requestOptions, (response) => {
            const body = response.statusCode === 204 || response.statusCode === 304 ? null : new ReadableStream({
                start(controller) {
                    response.on("data", (chunk) => {
                        response.pause();
                        controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
                    });
                    response.on("end", () => controller.close());
                    response.on("error", (error) => controller.error(error));
                },
                pull() { response.resume(); },
                cancel() { response.destroy(); },
            });
            resolve(new Response(body, {
                status: response.statusCode ?? 0,
                statusText: response.statusMessage ?? "",
                headers: Object.fromEntries(Object.entries(response.headers).flatMap(([key, value]) => value == null ? [] : [[key, Array.isArray(value) ? value.join(", ") : String(value)]])),
            }));
        });
        request.once("error", reject);
        request.end();
    });
}
export async function guardedFetch(raw, fetchImpl = nativeFetch, lookupImpl = dns.lookup) {
    let current = raw;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const address = await resolvePublicHost(current, lookupImpl);
        const response = await fetchImpl(current, {
            redirect: "manual",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { "user-agent": "curiosity-v2/0.2 (autonomous agent)" },
            lookupAddress: address,
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location)
                throw new Error(`Redirect from ${current} without location`);
            await response.body?.cancel();
            current = new URL(location, current).toString();
            continue;
        }
        return { response, finalUrl: current };
    }
    throw new Error(`Too many redirects fetching ${raw}`);
}
export async function readResponseText(response, maxBytes = MAX_RESPONSE_BYTES) {
    const reader = response.body?.getReader();
    if (!reader) {
        const buffer = await response.arrayBuffer();
        const view = new Uint8Array(buffer);
        const clipped = view.slice(0, maxBytes);
        return { text: new TextDecoder().decode(clipped), bytes: view.byteLength, truncated: view.byteLength > maxBytes };
    }
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    try {
        while (bytes < maxBytes) {
            const next = await reader.read();
            if (next.done)
                break;
            const chunk = next.value;
            bytes += chunk.byteLength;
            if (bytes < maxBytes) {
                chunks.push(chunk);
            }
            else {
                const accepted = chunk.slice(0, Math.max(0, maxBytes - (bytes - chunk.byteLength)));
                chunks.push(accepted);
                truncated = true;
                await reader.cancel();
                break;
            }
        }
        const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return { text: new TextDecoder().decode(merged), bytes, truncated };
    }
    finally {
        reader.releaseLock();
    }
}
function decodeEntities(value) {
    return value
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}
function contentHtml(html) {
    return html
        .replace(/<(script|style|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<(div|span)\b[^>]*class\s*=\s*["'][^"']*(?:mw-editsection|reference|sidebar|navigation)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ");
}
function extractLinks(html, baseUrl) {
    if (!baseUrl)
        return [];
    const links = [];
    const seen = new Set();
    const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    for (const match of html.matchAll(pattern)) {
        const raw = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
        if (!raw || raw.startsWith("#"))
            continue;
        try {
            const resolved = new URL(raw, baseUrl);
            if (resolved.protocol !== "http:" && resolved.protocol !== "https:")
                continue;
            if (resolved.username || resolved.password)
                continue;
            resolved.hash = "";
            const value = resolved.toString();
            if (!seen.has(value)) {
                seen.add(value);
                links.push(value);
                if (links.length >= MAX_LINKS)
                    break;
            }
        }
        catch {
            // Ignore malformed hrefs while retaining the usable links.
        }
    }
    return links;
}
export function extractText(html, baseUrl) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const main = contentHtml(html);
    const withoutScripts = main
        .replace(/<(br|p|div|section|article|h[1-6]|li|tr)[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ");
    const text = decodeEntities(withoutScripts).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    return { title: titleMatch ? decodeEntities(titleMatch[1]).trim() : undefined, text, links: extractLinks(main, baseUrl) };
}
export async function readPage(raw, fetchImpl = nativeFetch, lookupImpl = dns.lookup) {
    const { response, finalUrl } = await guardedFetch(raw, fetchImpl, lookupImpl);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(text\/|application\/(json|xml|.+xml|xhtml))/i.test(contentType)) {
        throw new Error(`Unsupported content-type "${contentType}" at ${finalUrl}`);
    }
    const body = await readResponseText(response, MAX_RESPONSE_BYTES);
    if (!response.ok)
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} at ${finalUrl}`);
    const isHtml = /text\/html|\.xhtml/i.test(contentType);
    const parsed = isHtml ? extractText(body.text, finalUrl) : { title: undefined, text: body.text, links: [] };
    const clipped = parsed.text.length > MAX_RESPONSE_TEXT
        ? `${parsed.text.slice(0, MAX_RESPONSE_TEXT)}\n[... truncated ${parsed.text.length - MAX_RESPONSE_TEXT} chars]`
        : parsed.text;
    return {
        url: raw,
        finalUrl,
        status: response.status,
        contentType,
        title: parsed.title,
        links: parsed.links,
        totalBytes: body.bytes,
        truncated: body.truncated || parsed.text.length > MAX_RESPONSE_TEXT,
        text: clipped || `(empty page at ${finalUrl})`,
    };
}
