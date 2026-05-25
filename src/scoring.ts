import type { CandidateGoal, CuriosityConfig, GoalRecord, ObservationRecord, ScoreCard } from "./types.js";

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "agent",
  "allow",
  "also",
  "because",
  "been",
  "before",
  "being",
  "between",
  "could",
  "does",
  "from",
  "have",
  "into",
  "just",
  "like",
  "need",
  "nothing",
  "onto",
  "other",
  "over",
  "should",
  "still",
  "such",
  "than",
  "that",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "through",
  "under",
  "until",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
]);

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function jaccardDistance(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
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

export function extractKeywords(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\- ]+/g, " ")
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4 && !STOPWORDS.has(part)),
  )].slice(0, 8);
}

export type ScoringContext = {
  observations: ObservationRecord[];
  openGoals: GoalRecord[];
  recentCompletedGoals?: GoalRecord[];
  recentToolNames: string[];
  boredomDrive?: number;
  selfContextKeywords?: string[];
};

function buildKeywordFrequency(observations: ObservationRecord[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const observation of observations) {
    const keywords =
      Array.isArray(observation.metadata.keywords) &&
      observation.metadata.keywords.every((value) => typeof value === "string")
        ? (observation.metadata.keywords as string[])
        : extractKeywords(observation.content);
    for (const keyword of keywords) {
      frequency.set(keyword, (frequency.get(keyword) ?? 0) + 1);
    }
  }
  return frequency;
}

function computeRndNovelty(candidate: CandidateGoal, frequency: Map<string, number>): number {
  if (candidate.keywords.length === 0) {
    return 0.35;
  }
  const rarity = candidate.keywords.map((keyword) => 1 - clamp((frequency.get(keyword) ?? 0) / 5));
  return clamp(average(rarity));
}

function goalKeywords(goal: GoalRecord): string[] {
  return [
    ...extractKeywords(goal.title),
    ...goal.evidence.flatMap((entry) => extractKeywords(entry)),
    ...goal.proposedAction.split(/\s+/).flatMap((entry) => extractKeywords(entry)),
  ];
}

function buildSelfContextKeywords(context: ScoringContext): string[] {
  if (context.selfContextKeywords && context.selfContextKeywords.length > 0) {
    return [...new Set(context.selfContextKeywords)];
  }
  return [
    ...context.observations.flatMap((observation) =>
      Array.isArray(observation.metadata.keywords) &&
      observation.metadata.keywords.every((value) => typeof value === "string")
        ? (observation.metadata.keywords as string[])
        : extractKeywords(observation.content),
    ),
    ...context.openGoals.flatMap(goalKeywords),
    ...(context.recentCompletedGoals ?? []).flatMap(goalKeywords),
    ...context.recentToolNames.flatMap((toolName) => extractKeywords(toolName)),
  ].slice(0, 240);
}

function computeSemanticDistance(candidate: CandidateGoal, selfContextKeywords: string[]): number {
  if (selfContextKeywords.length === 0) {
    return 0.75;
  }
  return clamp(jaccardDistance(candidate.keywords, selfContextKeywords));
}

function computeSelfReferenceDensity(candidate: CandidateGoal, selfContextKeywords: string[]): number {
  if (candidate.keywords.length === 0 || selfContextKeywords.length === 0) {
    return 0;
  }
  const selfSet = new Set(selfContextKeywords);
  const overlap = candidate.keywords.filter((keyword) => selfSet.has(keyword)).length;
  return clamp(overlap / candidate.keywords.length);
}

function computeFrontierRadius(boredomDrive: number): number {
  return clamp(0.35 + boredomDrive * 0.45);
}

function computeFrontierFit(distance: number, radius: number): number {
  return clamp(1 - Math.abs(distance - radius) / 0.45);
}

function computeActionAffordance(candidate: CandidateGoal, config: CuriosityConfig): number {
  let score = 0.45;
  if (candidate.source === "frontier_exploration") {
    score += 0.25;
  }
  if (candidate.targetSurface === "web" || candidate.targetSurface === "search" || candidate.targetSurface === "browser") {
    score += config.actionPolicy.allowExternalActions ? 0.25 : -0.25;
  }
  if (candidate.targetSurface === "workspace") {
    score += 0.1;
  }
  if (candidate.metadata.forced === true) {
    score += 0.05;
  }
  if (/(build|create|test|compare|simulate|visuali[sz]e|transform|artifact|experiment|probe)/i.test(candidate.proposedAction)) {
    score += 0.15;
  }
  return clamp(score);
}

function computeStructuralRecursionPenalty(candidate: CandidateGoal): number {
  const parts = candidate.title
    .split(":")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length <= 1) {
    return 0;
  }
  let repeatedAdjacent = 0;
  for (let index = 1; index < parts.length; index += 1) {
    if (parts[index] === parts[index - 1]) {
      repeatedAdjacent += 1;
    }
  }
  const duplicateParts = parts.length - new Set(parts).size;
  const nestingPressure = Math.max(0, parts.length - 3) * 0.12;
  return clamp(repeatedAdjacent * 0.35 + duplicateParts * 0.18 + nestingPressure);
}

function computeReachability(candidate: CandidateGoal, observations: ObservationRecord[]): number {
  const recentKeywordSets = observations.slice(0, 12).map((observation) =>
    Array.isArray(observation.metadata.keywords) &&
    observation.metadata.keywords.every((value) => typeof value === "string")
      ? (observation.metadata.keywords as string[])
      : extractKeywords(observation.content),
  );
  if (recentKeywordSets.length === 0) {
    return 0.75;
  }
  const distances = recentKeywordSets.map((keywords) => jaccardDistance(candidate.keywords, keywords));
  return clamp(Math.max(...distances));
}

function computeUncertainty(candidate: CandidateGoal): number {
  const text = `${candidate.title} ${candidate.evidence.join(" ")}`.toLowerCase();
  let score = 0.2;
  if (candidate.source === "self_authored_intention") {
    score += 0.45;
  }
  if (candidate.source === "unresolved_user_ask") {
    score += 0.5;
  }
  if (candidate.source === "bootstrap_exploration") {
    score += 0.35;
  }
  if (candidate.source === "failed_tool_attempt") {
    score += 0.4;
  }
  if (candidate.source === "external_follow_up") {
    score += 0.2;
  }
  if (candidate.source === "frontier_exploration") {
    score += 0.5;
  }
  if (candidate.source === "idle_boredom") {
    score += 0.2;
  }
  if (/[?]/.test(text)) {
    score += 0.15;
  }
  if (/(error|unknown|unclear|failed|retry|broken)/.test(text)) {
    score += 0.15;
  }
  return clamp(score);
}

function computeImpact(candidate: CandidateGoal, recentToolNames: string[]): number {
  const repeatedToolBonus =
    typeof candidate.metadata.toolName === "string" &&
    recentToolNames.filter((toolName) => toolName === candidate.metadata.toolName).length >= 2
      ? 0.15
      : 0;
  const sourceWeights: Record<CandidateGoal["source"], number> = {
    self_authored_intention: 0.8,
    bootstrap_exploration: 0.68,
    unresolved_user_ask: 0.9,
    stale_open_question: 0.72,
    failed_tool_attempt: 0.84,
    new_entity: 0.58,
    low_coverage_surface: 0.63,
    skill_opportunity: 0.55,
    external_follow_up: 0.76,
    frontier_exploration: 0.78,
    idle_boredom: 0.6,
  };
  return clamp(sourceWeights[candidate.source] + repeatedToolBonus);
}

function computeCurriculum(candidate: CandidateGoal): number {
  let score = 0.25;
  if (candidate.source === "self_authored_intention") {
    score += 0.45;
  }
  if (candidate.source === "skill_opportunity") {
    score += 0.55;
  }
  if (candidate.source === "bootstrap_exploration") {
    score += 0.35;
  }
  if (candidate.source === "failed_tool_attempt") {
    score += 0.2;
  }
  if (candidate.source === "frontier_exploration") {
    score += 0.35;
  }
  if (candidate.source === "idle_boredom") {
    score += 0.2;
  }
  if (candidate.keywords.some((keyword) => /(workflow|pattern|process|tool|memory|skill)/.test(keyword))) {
    score += 0.15;
  }
  if (candidate.targetSurface === "workspace") {
    score += 0.1;
  }
  return clamp(score);
}

function computeShadowRankings(params: {
  noveltyComposite: number;
  uncertainty: number;
  progress: number;
  curriculum: number;
  frontierFit: number;
}): Record<string, number> {
  return {
    rnd_novelty: params.noveltyComposite,
    episodic_reachability: params.noveltyComposite,
    plan2explore_uncertainty: params.uncertainty,
    impact_progress: params.progress,
    llm_curriculum_reflection: params.curriculum,
    frontier_distance: params.frontierFit,
  };
}

export function scoreCandidate(
  candidate: CandidateGoal,
  context: ScoringContext,
  config: CuriosityConfig,
): ScoreCard {
  const frequency = buildKeywordFrequency(context.observations);
  const selfContextKeywords = buildSelfContextKeywords(context);
  const rndNovelty = computeRndNovelty(candidate, frequency);
  const reachability = computeReachability(candidate, context.observations);
  const semanticDistance = computeSemanticDistance(candidate, selfContextKeywords);
  const selfReferenceDensity = computeSelfReferenceDensity(candidate, selfContextKeywords);
  const uncertainty = computeUncertainty(candidate);
  const progress = computeImpact(candidate, context.recentToolNames);
  const curriculum = computeCurriculum(candidate);
  const boredomDrive = clamp(context.boredomDrive ?? 0);
  const frontierRadius = computeFrontierRadius(boredomDrive);
  const frontierFit = config.frontier.enabled ? computeFrontierFit(semanticDistance, frontierRadius) : 0;
  const actionAffordance = computeActionAffordance(candidate, config);
  const structuralRecursionPenalty = computeStructuralRecursionPenalty(candidate);
  const predictionErrorProxy = clamp(uncertainty * 0.45 + semanticDistance * 0.35 + rndNovelty * 0.2);
  const learningProgressGuess = clamp(progress * 0.45 + curriculum * 0.3 + actionAffordance * 0.25);
  const noveltyComposite = clamp(
    rndNovelty * 0.35 +
      reachability * 0.25 +
      semanticDistance * 0.3 +
      frontierFit * 0.1 -
      selfReferenceDensity * 0.2 -
      structuralRecursionPenalty * 0.25,
  );
  const boredomBonus = boredomDrive * config.boredom.maxScoreBonus;
  const costPenalty = clamp(candidate.estimatedCost / 8000, 0, 0.15);
  const riskPenalty = clamp(candidate.risk, 0, 1) * 0.25;
  const frontierBonus =
    config.frontier.enabled && boredomDrive > 0
      ? frontierFit * config.frontier.distanceWeight * boredomDrive
      : 0;
  const selfReferencePenalty =
    config.frontier.enabled ? selfReferenceDensity * config.frontier.selfReferencePenalty * boredomDrive : 0;
  const actionBonus =
    config.frontier.enabled ? actionAffordance * config.frontier.actionAffordanceWeight : 0;
  const recursionPenalty =
    config.frontier.enabled ? structuralRecursionPenalty * config.frontier.recursionPenalty : 0;
  const activeEnsemble = clamp(
    noveltyComposite * config.ensembleWeights.novelty +
      uncertainty * config.ensembleWeights.uncertainty +
      progress * config.ensembleWeights.progress +
      curriculum * config.ensembleWeights.curriculum -
      costPenalty -
      riskPenalty +
      boredomBonus +
      frontierBonus +
      actionBonus -
      selfReferencePenalty -
      recursionPenalty,
  );

  return {
    rnd_novelty: clamp(rndNovelty),
    episodic_reachability: clamp(reachability),
    plan2explore_uncertainty: clamp(uncertainty),
    impact_progress: clamp(progress),
    llm_curriculum_reflection: clamp(curriculum),
    boredom_drive: boredomDrive,
    semantic_distance: semanticDistance,
    self_reference_density: selfReferenceDensity,
    frontier_radius: frontierRadius,
    frontier_fit: frontierFit,
    prediction_error_proxy: predictionErrorProxy,
    learning_progress_guess: learningProgressGuess,
    action_affordance: actionAffordance,
    structural_recursion_penalty: structuralRecursionPenalty,
    novelty_composite: noveltyComposite,
    cost_penalty: costPenalty,
    risk_penalty: riskPenalty,
    active_ensemble: activeEnsemble,
    shadow_rankings: computeShadowRankings({
      noveltyComposite,
      uncertainty,
      progress,
      curriculum,
      frontierFit,
    }),
  };
}

export function rankGoalsByScore<T extends { scoresByModel: ScoreCard }>(goals: T[]): T[] {
  return [...goals].sort((left, right) => {
    return right.scoresByModel.active_ensemble - left.scoresByModel.active_ensemble;
  });
}
