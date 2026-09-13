import { describe, expect, it } from "vitest";
import {
  centroid,
  cosineDistance,
  cosineSimilarity,
  createOpenAiEmbedder,
  lexicalDistance,
  textHash,
} from "./embeddings.js";
import { DEFAULT_WANDER_CONFIG } from "./config.js";
import type { EmbeddingCache } from "./embeddings.js";

describe("vector math", () => {
  it("computes cosine similarity and distance", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 5);
  });

  it("averages vectors into a centroid", () => {
    expect(centroid([[0, 0], [2, 4]])).toEqual([1, 2]);
    expect(centroid([])).toBeNull();
  });
});

describe("lexicalDistance", () => {
  it("is low for overlapping text and high for disjoint text", () => {
    expect(lexicalDistance("slime mold maze routing", "slime mold maze experiment")).toBeLessThan(0.7);
    expect(lexicalDistance("slime mold maze", "quantum chromodynamics lattice")).toBeCloseTo(1, 5);
  });
});

describe("createOpenAiEmbedder", () => {
  function memoryCache(): EmbeddingCache {
    const store = new Map<string, number[]>();
    return {
      get: (hash) => store.get(hash) ?? null,
      set: (hash, _preview, _model, vector) => {
        store.set(hash, vector);
      },
    };
  }

  it("reports unavailable and returns nulls without an API key", async () => {
    const prev = process.env.WANDER_TEST_KEY;
    delete process.env.WANDER_TEST_KEY;
    const embedder = createOpenAiEmbedder({
      config: { ...DEFAULT_WANDER_CONFIG.embeddings, apiKeyEnv: "WANDER_TEST_KEY" },
      cache: memoryCache(),
    });
    expect(embedder.available()).toBe(false);
    expect(await embedder.embed(["hello"])).toEqual([null]);
    if (prev !== undefined) {
      process.env.WANDER_TEST_KEY = prev;
    }
  });

  it("batches, parses, and caches successful responses", async () => {
    process.env.WANDER_TEST_KEY = "sk-test";
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return {
        ok: true,
        json: async () => ({
          data: body.input.map((_text, index) => ({ index, embedding: [index + 1, 0, 0] })),
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const cache = memoryCache();
    const embedder = createOpenAiEmbedder({
      config: { ...DEFAULT_WANDER_CONFIG.embeddings, apiKeyEnv: "WANDER_TEST_KEY" },
      cache,
      fetchImpl,
    });
    const first = await embedder.embed(["a", "b"]);
    expect(first[0]).toEqual([1, 0, 0]);
    expect(first[1]).toEqual([2, 0, 0]);
    // Second call for the same texts should hit cache, not the network.
    const second = await embedder.embed(["a", "b"]);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    delete process.env.WANDER_TEST_KEY;
  });

  it("returns nulls on a non-ok response", async () => {
    process.env.WANDER_TEST_KEY = "sk-test";
    const fetchImpl = (async () =>
      ({ ok: false, status: 429, text: async () => "rate limited" }) as unknown as Response) as typeof fetch;
    const embedder = createOpenAiEmbedder({
      config: { ...DEFAULT_WANDER_CONFIG.embeddings, apiKeyEnv: "WANDER_TEST_KEY" },
      cache: memoryCache(),
      fetchImpl,
    });
    expect(await embedder.embed(["x"])).toEqual([null]);
    delete process.env.WANDER_TEST_KEY;
  });
});

describe("textHash", () => {
  it("is stable and model-scoped", () => {
    expect(textHash("hello", "m1")).toBe(textHash("hello", "m1"));
    expect(textHash("hello", "m1")).not.toBe(textHash("hello", "m2"));
  });
});
