import { describe, expect, it } from "vitest";
import { DEFAULT_WANDER_CONFIG } from "./config.js";
import {
  actionAffordance,
  frontierRadius,
  noisePenalty,
  normalizeDistance,
  rankByCuriosity,
  recursionPenalty,
  scoreCandidate,
} from "./scoring.js";
import type { Candidate, ScoreCard, TerritoryRecord } from "./types.js";
import type { ScoringContext } from "./scoring.js";

const config = DEFAULT_WANDER_CONFIG;

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    origin: "llm_generated",
    topic: "How slime molds solve maze routing problems",
    domain: "biology",
    whyInteresting: "A brainless organism approximates shortest paths; the mechanism is unclear.",
    firstAction: "Search for the Nakagaki slime mold maze experiment and its replication data",
    expectedArtifact: "A small simulation comparing slime-mold routing to Dijkstra",
    expectedSurprise: 0.6,
    evidence: [],
    estimatedCost: 500,
    risk: 0.1,
    ...overrides,
  };
}

function context(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    boredomLevel: 0.8,
    selfContextVector: null,
    selfContextText: "openclaw plugin retry state dashboard tool logs",
    territory: [],
    recentGoalTopics: [],
    ...overrides,
  };
}

describe("normalizeDistance", () => {
  it("maps the raw cosine band onto [0,1]", () => {
    expect(normalizeDistance(0.3)).toBeCloseTo(0, 5);
    expect(normalizeDistance(0.85)).toBeCloseTo(1, 5);
    expect(normalizeDistance(0.1)).toBe(0);
    expect(normalizeDistance(1)).toBe(1);
  });
});

describe("frontierRadius", () => {
  it("expands with boredom", () => {
    expect(frontierRadius(0, config)).toBeCloseTo(config.frontier.minRadius, 5);
    expect(frontierRadius(1, config)).toBeCloseTo(config.frontier.maxRadius, 5);
    expect(frontierRadius(0.5, config)).toBeGreaterThan(frontierRadius(0.2, config));
  });
});

describe("recursionPenalty", () => {
  it("penalizes self-wrapping titles", () => {
    const wrapped = candidate({
      topic: "Re-evaluate stale goal: Re-evaluate stale goal: follow up",
    });
    expect(recursionPenalty(wrapped, [])).toBeGreaterThan(0.3);
  });

  it("penalizes verbatim repeats of recent goals", () => {
    const c = candidate({ topic: "Tides on Europa" });
    expect(recursionPenalty(c, ["Tides on Europa"])).toBeGreaterThanOrEqual(0.5);
    expect(recursionPenalty(c, ["Something else"])).toBe(0);
  });
});

describe("noisePenalty", () => {
  it("punishes structureless candidates", () => {
    const vague = candidate({ topic: "x", firstAction: "", expectedArtifact: "" });
    expect(noisePenalty(vague)).toBeGreaterThan(0.5);
    expect(noisePenalty(candidate())).toBe(0);
  });
});

describe("actionAffordance", () => {
  it("rewards concrete buildable actions", () => {
    expect(actionAffordance(candidate(), config)).toBeGreaterThan(0.6);
  });

  it("penalizes web actions when external actions are disabled", () => {
    const localOnly = { ...config, actionPolicy: { ...config.actionPolicy, allowExternalActions: false } };
    const webCandidate = candidate({ firstAction: "Search online for papers about it" });
    expect(actionAffordance(webCandidate, localOnly)).toBeLessThan(
      actionAffordance(webCandidate, config),
    );
  });
});

describe("scoreCandidate", () => {
  it("marks results degraded when no embeddings are available", () => {
    const card = scoreCandidate(candidate(), null, context(), config);
    expect(card.degraded_distance).toBe(true);
    expect(card.curiosity_value).toBeGreaterThanOrEqual(0);
    expect(card.curiosity_value).toBeLessThanOrEqual(1);
  });

  it("prefers a candidate near the frontier radius over one hugging self-context", () => {
    const selfVector = [1, 0, 0, 0];
    const distantVector = [0, 0, 0, 1];
    const ctx = context({ boredomLevel: 1, selfContextVector: selfVector });
    const near = scoreCandidate(candidate(), [0.98, 0.02, 0, 0], ctx, config);
    const far = scoreCandidate(candidate(), distantVector, ctx, config);
    expect(far.semantic_distance).toBeGreaterThan(near.semantic_distance);
    expect(far.curiosity_value).toBeGreaterThan(near.curiosity_value);
  });

  it("penalizes proximity to saturated territory", () => {
    const territoryVector = [0, 1, 0, 0];
    const region: TerritoryRecord = {
      territoryId: "t1",
      topic: "saturated topic",
      summary: "",
      domain: "",
      vector: territoryVector,
      visits: 5,
      firstVisitedAt: 0,
      lastVisitedAt: Date.now(),
      learningProgress: 0.1,
      saturation: 0.9,
      artifacts: [],
      runIds: [],
    };
    const ctx = context({ selfContextVector: [1, 0, 0, 0], territory: [region] });
    const onSaturated = scoreCandidate(candidate(), territoryVector, ctx, config);
    expect(onSaturated.saturation_penalty).toBeGreaterThan(0);
  });
});

describe("rankByCuriosity", () => {
  it("sorts descending by curiosity value", () => {
    const items: Array<{ scores: ScoreCard }> = [
      { scores: { curiosity_value: 0.2 } as ScoreCard },
      { scores: { curiosity_value: 0.9 } as ScoreCard },
      { scores: { curiosity_value: 0.5 } as ScoreCard },
    ];
    const ranked = rankByCuriosity(items);
    expect(ranked.map((item) => item.scores.curiosity_value)).toEqual([0.9, 0.5, 0.2]);
  });
});
