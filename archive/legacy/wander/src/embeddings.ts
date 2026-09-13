import { createHash } from "node:crypto";
import type { WanderConfig } from "./types.js";

export type EmbeddingCache = {
  get: (hash: string) => number[] | null;
  set: (hash: string, textPreview: string, model: string, vector: number[]) => void;
};

export type Embedder = {
  /** Returns one vector per input text, or null per text when embedding is unavailable. */
  embed: (texts: string[]) => Promise<Array<number[] | null>>;
  available: () => boolean;
  model: string;
};

export function textHash(text: string, model: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function cosineDistance(left: number[], right: number[]): number {
  return 1 - cosineSimilarity(left, right);
}

export function centroid(vectors: number[][]): number[] | null {
  if (vectors.length === 0) {
    return null;
  }
  const length = vectors[0].length;
  const sum = new Array<number>(length).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < length; index += 1) {
      sum[index] += vector[index] ?? 0;
    }
  }
  return sum.map((value) => value / vectors.length);
}

type LoggerLike = {
  warn?: (message: string) => void;
};

const MAX_EMBED_CHARS = 4000;
const MAX_BATCH_SIZE = 64;

export function createOpenAiEmbedder(params: {
  config: WanderConfig["embeddings"];
  cache: EmbeddingCache;
  logger?: LoggerLike;
  fetchImpl?: typeof fetch;
}): Embedder {
  const { config, cache, logger } = params;
  const fetchImpl = params.fetchImpl ?? fetch;
  let warnedMissingKey = false;
  const apiKey = () => process.env[config.apiKeyEnv]?.trim() || "";

  const available = () => apiKey().length > 0;

  const requestBatch = async (texts: string[]): Promise<Array<number[] | null>> => {
    const key = apiKey();
    if (!key) {
      if (!warnedMissingKey) {
        warnedMissingKey = true;
        logger?.warn?.(
          `wander: embedding API key missing (env ${config.apiKeyEnv}); falling back to lexical distance`,
        );
      }
      return texts.map(() => null);
    }
    try {
      const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model: config.model, input: texts }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        logger?.warn?.(
          `wander: embedding request failed (${response.status}): ${body.slice(0, 300)}`,
        );
        return texts.map(() => null);
      }
      const payload = (await response.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
      };
      const results: Array<number[] | null> = texts.map(() => null);
      for (const entry of payload.data ?? []) {
        if (
          typeof entry.index === "number" &&
          Array.isArray(entry.embedding) &&
          entry.embedding.every((value) => typeof value === "number")
        ) {
          results[entry.index] = entry.embedding;
        }
      }
      return results;
    } catch (error) {
      logger?.warn?.(`wander: embedding request error (${String(error)})`);
      return texts.map(() => null);
    }
  };

  const embed = async (texts: string[]): Promise<Array<number[] | null>> => {
    const normalized = texts.map((text) => text.trim().slice(0, MAX_EMBED_CHARS));
    const results: Array<number[] | null> = normalized.map(() => null);
    const misses: Array<{ index: number; text: string; hash: string }> = [];
    for (let index = 0; index < normalized.length; index += 1) {
      const text = normalized[index];
      if (!text) {
        continue;
      }
      const hash = textHash(text, config.model);
      const cached = cache.get(hash);
      if (cached) {
        results[index] = cached;
      } else {
        misses.push({ index, text, hash });
      }
    }
    for (let offset = 0; offset < misses.length; offset += MAX_BATCH_SIZE) {
      const batch = misses.slice(offset, offset + MAX_BATCH_SIZE);
      const vectors = await requestBatch(batch.map((miss) => miss.text));
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
        const vector = vectors[batchIndex];
        if (!vector) {
          continue;
        }
        const miss = batch[batchIndex];
        results[miss.index] = vector;
        cache.set(miss.hash, miss.text.slice(0, 120), config.model, vector);
      }
    }
    return results;
  };

  return { embed, available, model: config.model };
}

/**
 * Lexical fallback distance for when no embedding API is available. Far weaker
 * than embeddings; scoring marks results as degraded so logs stay honest.
 */
export function lexicalDistance(left: string, right: string): number {
  const tokens = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((part) => part.length >= 4),
    );
  const leftSet = tokens(left);
  const rightSet = tokens(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const value of union) {
    if (leftSet.has(value) && rightSet.has(value)) {
      intersection += 1;
    }
  }
  return 1 - intersection / union.size;
}
