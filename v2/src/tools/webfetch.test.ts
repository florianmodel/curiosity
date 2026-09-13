import { describe, expect, it } from "vitest";
import { extractText, isBlockedUrl, readPage, readResponseText, type LookupLike } from "./webfetch.js";

function fakeResponse(body: string, init: { status?: number; statusText?: string; headers?: Record<string, string>; stream?: boolean } = {}) {
  const headers = new Map(Object.entries(init.headers ?? {}));
  const bytes = new TextEncoder().encode(body);
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: init.statusText ?? "",
    headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null },
    body: init.stream ? new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) : null,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  } as unknown as Response;
}

const fetcher = (response: Response) => (async () => response) as never;
const publicLookup: LookupLike = async () => [{ address: "93.184.216.34", family: 4 }];

describe("isBlockedUrl", () => {
  it("blocks local, private, link-local, and metadata targets", () => {
    for (const url of ["http://localhost/x", "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.0.4/", "http://172.16.5.5/", "http://169.254.169.254/latest/meta-data", "http://100.64.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://224.0.0.1/", "http://[fd00::1]/", "file:///etc/passwd", "ftp://example.com/", "not a url"]) {
      expect(isBlockedUrl(url), url).toBeDefined();
    }
  });

  it("allows public http(s) targets and rejects embedded credentials", () => {
    expect(isBlockedUrl("https://example.com/page")).toBeUndefined();
    expect(isBlockedUrl("http://example.com:8080/api")).toBeUndefined();
    expect(isBlockedUrl("https://user:pass@example.com/private")).toMatch(/credentials/);
  });
});

describe("readPage", () => {
  it("extracts title, readable text, and resolved usable links", async () => {
    const page = await readPage("https://example.com/a", fetcher(fakeResponse("<html><head><title>Odd Clocks</title></head><body><nav><a href=\"/menu\">Menu</a></nav><script>x()</script><p>Hello <b>world</b>.</p><a href=\"/next#part\">Next</a><a href=\"mailto:x@y\">Mail</a></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } })), publicLookup);
    expect(page.title).toBe("Odd Clocks");
    expect(page.text).toContain("Hello world");
    expect(page.text).not.toContain("x()");
    expect(page.links).toEqual(["https://example.com/next"]);
  });

  it("caps extracted links", async () => {
    const links = Array.from({ length: 60 }, (_, index) => `<a href=\"/link-${index}\">${index}</a>`).join("");
    const page = await readPage("https://example.com/links", fetcher(fakeResponse(links, { headers: { "content-type": "text/html" } })), publicLookup);
    expect(page.links).toHaveLength(50);
  });

  it("truncates oversized text with a marker", async () => {
    const huge = "<p>" + "word ".repeat(4000) + "</p>";
    const page = await readPage("https://example.com/big", fetcher(fakeResponse(huge, { headers: { "content-type": "text/html" } })), publicLookup);
    expect(page.text.length).toBeLessThan(7000);
    expect(page.text).toContain("[... truncated");
  });

  it("rejects non-text content types", async () => {
    await expect(readPage("https://example.com/bin", fetcher(fakeResponse("MZIP...", { headers: { "content-type": "application/octet-stream" } })), publicLookup)).rejects.toThrow(/Unsupported content-type/);
  });

  it("refuses redirects into private address space", async () => {
    const redirect = fakeResponse("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    await expect(readPage("https://example.com/open", fetcher(redirect), publicLookup)).rejects.toThrow(/private|Blocked/i);
  });

  it("reports HTTP failures even when the server returns a body", async () => {
    await expect(readPage("https://example.com/missing", fetcher(fakeResponse("not found", { status: 404, statusText: "Not Found", headers: { "content-type": "text/plain" } })), publicLookup)).rejects.toThrow(/HTTP 404 Not Found/);
  });

  it("rejects hostnames resolving to private addresses before fetching", async () => {
    let called = false;
    const fetchMock = (async () => { called = true; return fakeResponse("ok", { headers: { "content-type": "text/plain" } }); }) as never;
    await expect(readPage("https://public.example/", fetchMock, async () => [{ address: "127.0.0.1", family: 4 }])).rejects.toThrow(/private address/);
    expect(called).toBe(false);
  });
});

describe("extractText and bounded response reads", () => {
  it("decodes common HTML entities", () => {
    const { text } = extractText("<p>Tom &amp; Jerry &lt;3 &#39;quotes&#39;</p>");
    expect(text).toContain("Tom & Jerry <3 'quotes'");
  });

  it("bounds streamed response reads and cancels after the cap", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(10)); },
      cancel() { cancelled = true; },
    });
    const result = await readResponseText({ body: stream } as unknown as Response, 16);
    expect(result.text.length).toBe(16);
    expect(result.truncated).toBe(true);
    expect(cancelled).toBe(true);
  });
});
