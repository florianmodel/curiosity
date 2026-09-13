import { describe, expect, it } from "vitest";
import { searchWeb, type NativeWebSearch } from "./search.js";
import type { LookupLike } from "./webfetch.js";

function jsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  const headers = new Map([["content-type", "application/json"]]);
  return {
    ok: status < 400,
    status,
    headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null },
    body: null,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  } as unknown as Response;
}

const lookup: LookupLike = async () => [{ address: "192.0.2.1", family: 4 }];

describe("searchWeb", () => {
  it("uses the native OpenClaw provider when supplied", async () => {
    let fallbackCalled = false;
    const native: NativeWebSearch = async () => [{ title: "Native result", url: "https://example.com/native", snippet: "native" }];
    const result = await searchWeb("odd clocks", {
      nativeSearch: native,
      fetchImpl: (async () => { fallbackCalled = true; return jsonResponse({}); }) as never,
      lookupImpl: lookup,
    });
    expect(result.provider).toBe("native_web_search");
    expect(result.encyclopediaOnly).toBe(false);
    expect(result.results[0].url).toBe("https://example.com/native");
    expect(fallbackCalled).toBe(false);
  });

  it("labels the Wikipedia fallback as encyclopedia-only", async () => {
    let requested = "";
    const fetchMock = (async (url: string) => {
      requested = url;
      return jsonResponse({ query: { search: [{ pageid: 42, title: "Odd clocks", snippet: "A <b>strange</b> clock." }] } });
    }) as never;
    const result = await searchWeb("odd clocks", { fetchImpl: fetchMock, lookupImpl: lookup, maxResults: 1 });
    expect(result.provider).toBe("wikipedia_api");
    expect(result.scope).toMatch(/encyclopedia only/i);
    expect(result.encyclopediaOnly).toBe(true);
    expect(result.results).toEqual([{ title: "Odd clocks", url: "https://en.wikipedia.org/?curid=42", snippet: "A strange clock." }]);
    expect(requested).toContain("srsearch=odd+clocks");
  });

  it("uses configured SearXNG before Wikipedia", async () => {
    const urls: string[] = [];
    const fetchMock = (async (url: string) => {
      urls.push(url);
      return jsonResponse({ results: [{ title: "Sear result", url: "https://example.com/sear", content: "from searx" }] });
    }) as never;
    const result = await searchWeb("tide pools", { searxngBaseUrl: "https://search.example/searxng", fetchImpl: fetchMock, lookupImpl: lookup });
    expect(result.provider).toBe("searxng");
    expect(result.results[0].snippet).toBe("from searx");
    expect(urls[0]).toContain("/searxng/search?");
  });

  it("falls back when native search fails", async () => {
    const result = await searchWeb("fallback", {
      nativeSearch: async () => { throw new Error("provider unavailable"); },
      fetchImpl: (async () => jsonResponse({ query: { search: [] } })) as never,
      lookupImpl: lookup,
    });
    expect(result.provider).toBe("wikipedia_api");
    expect(result.results).toEqual([]);
  });

  it("rejects empty and overlong queries", async () => {
    await expect(searchWeb("   ")).rejects.toThrow(/must not be empty/);
    await expect(searchWeb("x".repeat(257))).rejects.toThrow(/too long/);
  });
});
