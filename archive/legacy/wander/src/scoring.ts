import { cosineDistance, lexicalDistance } from "./embeddings.js";
import type { Candidate, ScoreCard, TerritoryRecord, WanderConfig } from "./types.js";

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Raw cosine distances from text-embedding-3-small cluster roughly in
 * [0.3, 0.95] for short topical texts: ~0.3-0.5 for closely related topics,
 * ~0.75+ for unrelated domains. Map that band onto [0, 1] so radius values
 * in config are intuitive.
 */
const RAW_DISTANCE_FLOOR = 0.3;
const RAW_DISTANCE_SPAN = 0.55;

export function normalizeDistance(rawCosineDistance: number): number {
  return clamp((rawCosineDistance - RAW_DISTANCE_FLOOR) / RAW_DISTANCE_SPAN);
}

export function frontierRadius(boredomLevel: number, config: WanderConfig): number {
  const { minRadius, maxRadius } = config.frontier;
  return clamp(minRadius + clamp(boredomLevel) * (maxRadius - minRadius));
}

export function candidateText(candidate: Candidate): string {
  return [candidate.topic, candidate.domain, candidate.whyInteresting].filter(Boolean).join(". ");
}

/**
 * Penalize structurally recursive topics ("Re-evaluate: Re-evaluate: ...")
 * and near-verbatim repeats of recent goal topics. This is a shape penalty,
 * not a topic ban: it measures self-wrapping, not subject matter.
 */
export function recursionPenalty(candidate: Candidate, recentGoalTopics: string[]): number {
  const parts = candidate.topic
    .split(":")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  let penalty = 0;
  if (parts.length > 1) {
    let repeatedAdjacent = 0;
    for (let index = 1; index < parts.length; index += 1) {
      if (parts[index] === parts[index - 1]) {
        repeatedAdjacent += 1;
      }
    }
    const duplicateParts = parts.length - new Set(parts).size;
    penalty += repeatedAdjacent * 0.4 + duplicateParts * 0.2 + Math.max(0, parts.length - 3) * 0.15;
  }
  const normalizedTopic = candidate.topic.trim().toLowerCase();
  if (recentGoalTopics.some((topic) => topic.trim().toLowerCase() === normalizedTopic)) {
    penalty += 0.5;
  }
  return clamp(penalty);
}

/**
 * Penalize candidates that are too structureless to act on: no concrete first
 * action, no expected artifact, or a vague one-word topic. "Pure noise" in the
 * reward shape.
 */
export function noisePenalty(candidate: Candidate): number {
  let penalty = 0;
  if (candidate.topic.trim().length < 8) {
    penalty += 0.4;
  }
  if (candidate.firstAction.trim().length < 12) {
    penalty += 0.35;
  }
  if (candidate.expectedArtifact.trim().length < 8) {
    penalty += 0.25;
  }
  if (!/[a-z]/i.test(candidate.topic)) {
    penalty += 0.3;
  }
  return clamp(penalty);
}

export function actionAffordance(candidate: Candidate, config: WanderConfig): number {
  let score = 0.2;
  if (candidate.firstAction.trim().length >= 12) {
    score += 0.3;
  }
  if (candidate.expectedArtifact.trim().length >= 8) {
    score += 0.2;
  }
  if (
    /(build|create|write|test|compare|simulate|measure|visuali[sz]e|transform|prototype|experiment|compute|model|probe|fetch|search)/i.test(
      `${candidate.firstAction} ${candidate.expectedArtifact}`,
    )
  ) {
    score += 0.2;
  }
  if (
    !config.actionPolicy.allowExternalActions &&
    /(web|search|fetch|browse|online|internet)/i.test(candidate.firstAction)
  ) {
    score -= 0.4;
  }
  return clamp(score);
}

export type ScoringContext = {
  boredomLevel: number;
  /** Centroid embedding of recent activity + recently visited territory. */
  selfContextVector: number[] | null;
  /** Raw text fallback used when embeddings are unavailable. */
  selfContextText: string;
  territory: TerritoryRecord[];
  recentGoalTopics: string[];
};

export function scoreCandidate(
  candidate: Candidate,
  vector: number[] | null,
  context: ScoringContext,
  config: WanderConfig,
): ScoreCard {
  const degraded = vector === null || context.selfContextVector === null;
  const rawDistance =
    vector && context.selfContextVector
      ? cosineDistance(vector, context.selfContextVector)
      : lexicalDistance(candidateText(candidate), context.selfContextText) * RAW_DISTANCE_SPAN +
        RAW_DISTANCE_FLOOR;
  const semanticDistance = normalizeDistance(rawDistance);
  const selfSimilarity = 1 - semanticDistance;
  const radius = frontierRadius(context.boredomLevel, config);
  const fit = clamp(1 - Math.abs(semanticDistance - radius) / config.frontier.fitWidth);

  // Distance to the nearest explored territory region, plus what that region
  // already taught us. Unvisited space is novel; saturated regions push back.
  let nearestDistance = 1;
  let nearest: TerritoryRecord | null = null;
  for (const region of context.territory) {
    if (!region.vector || !vector) {
      continue;
    }
    const distance = normalizeDistance(cosineDistance(vector, region.vector));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = region;
    }
  }
  const territoryNovelty = context.territory.length === 0 ? 0.7 : clamp(nearestDistance);
  const nearSaturatedRegion = nearest !== null && nearestDistance < 0.25 && nearest.saturation > 0.6;
  const saturationPenalty = nearSaturatedRegion ? clamp(nearest!.saturation) : 0;
  // Revisiting a region that produced real learning and is not yet saturated
  // is worthwhile (learning progress); unknown space gets a neutral prior.
  const learningProgressPrior =
    nearest && nearestDistance < 0.35
      ? clamp(nearest.learningProgress * (1 - nearest.saturation))
      : 0.5;

  const affordance = actionAffordance(candidate, config);
  const recursion = recursionPenalty(candidate, context.recentGoalTopics);
  const noise = noisePenalty(candidate);
  const predictionError = clamp(
    clamp(candidate.expectedSurprise) * 0.55 + territoryNovelty * 0.45,
  );

  const costPenalty = clamp(candidate.estimatedCost / 8000, 0, 0.15);
  const riskPenalty = clamp(candidate.risk) * 0.25;

  const weights = config.weights;
  const curiosityValue = clamp(
    learningProgressPrior * weights.learningProgress +
      predictionError * weights.predictionError +
      affordance * weights.actionAffordance +
      fit * weights.frontierFit +
      territoryNovelty * weights.novelty -
      selfSimilarity * weights.selfSimilarityPenalty * clamp(context.boredomLevel, 0.25, 1) -
      recursion * weights.recursionPenalty -
      noise * weights.noisePenalty -
      saturationPenalty * 0.2 -
      costPenalty -
      riskPenalty,
  );

  return {
    semantic_distance: semanticDistance,
    frontier_radius: radius,
    frontier_fit: fit,
    self_similarity: selfSimilarity,
    territory_novelty: territoryNovelty,
    learning_progress_prior: learningProgressPrior,
    prediction_error_proxy: predictionError,
    action_affordance: affordance,
    recursion_penalty: recursion,
    noise_penalty: noise,
    saturation_penalty: saturationPenalty,
    cost_penalty: costPenalty,
    risk_penalty: riskPenalty,
    curiosity_value: curiosityValue,
    degraded_distance: degraded,
  };
}

export function rankByCuriosity<T extends { scores: ScoreCard }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.scores.curiosity_value - left.scores.curiosity_value);
}
