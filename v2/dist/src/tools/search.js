import { guardedFetch, readResponseText } from "./webfetch.js";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
function resultLimit(value) {
    if (!Number.isFinite(value))
        return 5;
    return Math.max(1, Math.min(10, Math.trunc(value)));
}
function cleanQuery(query) {
    const value = query.trim().replace(/\s+/g, " ");
    if (!value)
        throw new Error("Search query must not be empty");
    if (value.length > 256)
        throw new Error("Search query is too long (maximum 256 characters)");
    return value;
}
function normalizeResults(value, limit) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((entry) => {
        if (!entry || typeof entry !== "object")
            return [];
        const record = entry;
        const url = typeof record.url === "string" ? record.url.trim() : "";
        const title = typeof record.title === "string" ? record.title.trim() : "";
        const snippet = typeof record.snippet === "string"
            ? record.snippet.trim()
            : typeof record.content === "string"
                ? record.content.trim()
                : typeof record.description === "string" ? record.description.trim() : "";
        if (!title || !url)
            return [];
        try {
            const resolved = new URL(url);
            if (resolved.protocol !== "http:" && resolved.protocol !== "https:")
                return [];
            return [{ title, url: resolved.toString(), snippet }];
        }
        catch {
            return [];
        }
    }).slice(0, limit);
}
async function searchSearxng(query, baseUrl, limit, options) {
    const base = new URL(baseUrl);
    if (base.username || base.password)
        throw new Error("SearXNG URL must not contain credentials");
    const endpoint = new URL(base.toString());
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/search`;
    endpoint.search = "";
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("categories", "general");
    endpoint.searchParams.set("language", "en");
    const { response, finalUrl } = await guardedFetch(endpoint.toString(), options.fetchImpl, options.lookupImpl);
    const body = await readResponseText(response);
    if (!response.ok)
        throw new Error(`SearXNG HTTP ${response.status} at ${finalUrl}`);
    let parsed;
    try {
        parsed = JSON.parse(body.text);
    }
    catch {
        throw new Error(`SearXNG returned invalid JSON at ${finalUrl}`);
    }
    const results = parsed && typeof parsed === "object" ? parsed.results : undefined;
    return normalizeResults(results, limit);
}
async function searchWikipedia(query, limit, options) {
    const endpoint = new URL(WIKIPEDIA_API);
    endpoint.searchParams.set("action", "query");
    endpoint.searchParams.set("list", "search");
    endpoint.searchParams.set("srsearch", query);
    endpoint.searchParams.set("srlimit", String(limit));
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("origin", "*");
    const { response, finalUrl } = await guardedFetch(endpoint.toString(), options.fetchImpl, options.lookupImpl);
    const body = await readResponseText(response);
    if (!response.ok)
        throw new Error(`Wikipedia API HTTP ${response.status} at ${finalUrl}`);
    let parsed;
    try {
        parsed = JSON.parse(body.text);
    }
    catch {
        throw new Error(`Wikipedia API returned invalid JSON at ${finalUrl}`);
    }
    const root = parsed && typeof parsed === "object" ? parsed : {};
    const queryValue = root.query;
    const entries = queryValue && typeof queryValue === "object" ? queryValue.search : undefined;
    if (!Array.isArray(entries))
        return [];
    return entries.flatMap((entry) => {
        if (!entry || typeof entry !== "object")
            return [];
        const item = entry;
        const pageId = typeof item.pageid === "number" ? item.pageid : null;
        const title = typeof item.title === "string" ? item.title : "";
        if (!title || pageId === null)
            return [];
        return [{
                title,
                url: `https://en.wikipedia.org/?curid=${pageId}`,
                snippet: typeof item.snippet === "string" ? item.snippet.replace(/<[^>]+>/g, "") : "",
            }];
    }).slice(0, limit);
}
/**
 * Search with the host's native OpenClaw provider when supplied. If no native
 * provider is exposed, use an explicitly configured SearXNG instance, then a
 * clearly scoped Wikipedia encyclopedia fallback. No paid search API is used.
 */
export async function searchWeb(query, options = {}) {
    const clean = cleanQuery(query);
    const limit = resultLimit(options.maxResults);
    const failures = [];
    if (options.nativeSearch) {
        try {
            const results = normalizeResults(await options.nativeSearch(clean, { maxResults: limit }), limit);
            if (results.length > 0)
                return { query: clean, provider: "native_web_search", scope: "OpenClaw native web search", encyclopediaOnly: false, results };
            failures.push("native web_search returned no results");
        }
        catch (error) {
            failures.push(`native web_search failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (options.searxngBaseUrl) {
        try {
            const results = await searchSearxng(clean, options.searxngBaseUrl, limit, options);
            if (results.length > 0)
                return { query: clean, provider: "searxng", scope: "Configured SearXNG general web search", encyclopediaOnly: false, results };
            failures.push("SearXNG returned no results");
        }
        catch (error) {
            failures.push(`SearXNG failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    try {
        const results = await searchWikipedia(clean, limit, options);
        return { query: clean, provider: "wikipedia_api", scope: "Wikipedia encyclopedia only; this is not general web coverage", encyclopediaOnly: true, results };
    }
    catch (error) {
        failures.push(`Wikipedia API failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new Error(`Search failed: ${failures.join("; ")}`);
}
/** Default provider-neutral entrypoint used by the plugin tool wrapper. */
export async function searchPublic(query) {
    return searchWeb(query);
}
