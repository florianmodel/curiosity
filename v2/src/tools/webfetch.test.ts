import { describe, expect, it } from "vitest";
import { extractText, isBlockedUrl, readPage } from "./webfetch.js";

function fakeResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  const headers = new Map(Object.entries(init.headers ?? {}));
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  } as unknown as Response;
}

const fetcher = (response: Response) => (async () => response) as never;

describe("isBlockedUrl", () => {
  it("blocks local, private, link-local, and metadata targets", () => {
    for (const url of ["http://localhost/x", "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.0.4/", "http://172.16.5.5/", "http://169.254.169.254/latest/meta-data", "http://100.64.0.1/", "http://[::1]/", "http://[fd00::1]/", "file:///etc/passwd", "ftp://example.com/", "not a url"]) {
      expect(isBlockedUrl(url), url).toBeDefined();
    }
  });

  it("allows public http(s) targets", () => {
    expect(isBlockedUrl("https://example.com/page")).toBeUndefined();
    expect(isBlockedUrl("http://example.com:8080/api")).toBeUndefined();
  });
});

describe("readPage", () => {
  it("extracts title and readable text from html", async () => {
    const page = await readPage("https://example.com/a", fetcher(fakeResponse("<html><head><title>Odd Clocks</title></head><body><script>x()</script><p>Hello <b>world</b>.</p></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } })));
    expect(page.title).toBe("Odd Clocks");
    expect(page.text).toContain("Hello world");
    expect(page.text).not.toContain("x()");
  });

  it("truncates oversized text with a marker", async () => {
    const huge = "<p>" + "word ".repeat(4000) + "</p>";
    const page = await readPage("https://example.com/big", fetcher(fakeResponse(huge, { headers: { "content-type": "text/html" } })));
    expect(page.text.length).toBeLessThan(7000);
    expect(page.text).toContain("[... truncated");
  });

  it("rejects non-text content types", async () => {
    await expect(readPage("https://example.com/bin", fetcher(fakeResponse("MZIP...", { headers: { "content-type": "application/octet-stream" } })))).rejects.toThrow(/Unsupported content-type/);
  });

  it("refuses redirects into private address space", async () => {
    const redirect = fakeResponse("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    await expect(readPage("https://example.com/open", (async () => redirect) as never)).rejects.toThrow(/private|Blocked/i);
  });
});

describe("extractText entities", () => {
  it("decodes common html entities", () => {
    const { text } = extractText("<p>Tom &amp; Jerry &lt;3 &#39;quotes&#39;</p>");
    expect(text).toContain("Tom & Jerry <3 'quotes'");
  });
});
