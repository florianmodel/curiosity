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
function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}
function average(values) {
    if (values.length === 0) {
        return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function jaccardDistance(left, right) {
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
export function extractKeywords(text) {
    return [...new Set(text
            .toLowerCase()
            .replace(/[^a-z0-9_\- ]+/g, " ")
            .split(/\s+/)
            .map((part) => part.trim())
            .filter((part) => part.length >= 4 && !STOPWORDS.has(part)))].slice(0, 8);
}
function buildKeywordFrequency(observations) {
    const frequency = new Map();
    for (const observation of observations) {
        const keywords = Array.isArray(observation.metadata.keywords) &&
            observation.metadata.keywords.every((value) => typeof value === "string")
            ? observation.metadata.keywords
            : extractKeywords(observation.content);
        for (const keyword of keywords) {
            frequency.set(keyword, (frequency.get(keyword) ?? 0) + 1);
        }
    }
    return frequency;
}
function computeRndNovelty(candidate, frequency) {
    if (candidate.keywords.length === 0) {
        return 0.35;
    }
    const rarity = candidate.keywords.map((keyword) => 1 - clamp((frequency.get(keyword) ?? 0) / 5));
    return clamp(average(rarity));
}
function computeReachability(candidate, observations) {
    const recentKeywordSets = observations.slice(0, 12).map((observation) => Array.isArray(observation.metadata.keywords) &&
        observation.metadata.keywords.every((value) => typeof value === "string")
        ? observation.metadata.keywords
        : extractKeywords(observation.content));
    if (recentKeywordSets.length === 0) {
        return 0.75;
    }
    const distances = recentKeywordSets.map((keywords) => jaccardDistance(candidate.keywords, keywords));
    return clamp(Math.max(...distances));
}
function computeUncertainty(candidate) {
    const text = `${candidate.title} ${candidate.evidence.join(" ")}`.toLowerCase();
    let score = 0.2;
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
function computeImpact(candidate, recentToolNames) {
    const repeatedToolBonus = typeof candidate.metadata.toolName === "string" &&
        recentToolNames.filter((toolName) => toolName === candidate.metadata.toolName).length >= 2
        ? 0.15
        : 0;
    const sourceWeights = {
        bootstrap_exploration: 0.68,
        unresolved_user_ask: 0.9,
        stale_open_question: 0.72,
        failed_tool_attempt: 0.84,
        new_entity: 0.58,
        low_coverage_surface: 0.63,
        skill_opportunity: 0.55,
        external_follow_up: 0.76,
        idle_boredom: 0.6,
    };
    return clamp(sourceWeights[candidate.source] + repeatedToolBonus);
}
function computeCurriculum(candidate) {
    let score = 0.25;
    if (candidate.source === "skill_opportunity") {
        score += 0.55;
    }
    if (candidate.source === "bootstrap_exploration") {
        score += 0.35;
    }
    if (candidate.source === "failed_tool_attempt") {
        score += 0.2;
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
function computeShadowRankings(params) {
    return {
        rnd_novelty: params.noveltyComposite,
        episodic_reachability: params.noveltyComposite,
        plan2explore_uncertainty: params.uncertainty,
        impact_progress: params.progress,
        llm_curriculum_reflection: params.curriculum,
    };
}
export function scoreCandidate(candidate, context, config) {
    const frequency = buildKeywordFrequency(context.observations);
    const rndNovelty = computeRndNovelty(candidate, frequency);
    const reachability = computeReachability(candidate, context.observations);
    const noveltyComposite = clamp((rndNovelty + reachability) / 2);
    const uncertainty = computeUncertainty(candidate);
    const progress = computeImpact(candidate, context.recentToolNames);
    const curriculum = computeCurriculum(candidate);
    const boredomDrive = clamp(context.boredomDrive ?? 0);
    const boredomBonus = boredomDrive * config.boredom.maxScoreBonus;
    const costPenalty = clamp(candidate.estimatedCost / 8000, 0, 0.15);
    const riskPenalty = clamp(candidate.risk, 0, 1) * 0.25;
    const activeEnsemble = clamp(noveltyComposite * config.ensembleWeights.novelty +
        uncertainty * config.ensembleWeights.uncertainty +
        progress * config.ensembleWeights.progress +
        curriculum * config.ensembleWeights.curriculum -
        costPenalty -
        riskPenalty +
        boredomBonus);
    return {
        rnd_novelty: clamp(rndNovelty),
        episodic_reachability: clamp(reachability),
        plan2explore_uncertainty: clamp(uncertainty),
        impact_progress: clamp(progress),
        llm_curriculum_reflection: clamp(curriculum),
        boredom_drive: boredomDrive,
        novelty_composite: noveltyComposite,
        cost_penalty: costPenalty,
        risk_penalty: riskPenalty,
        active_ensemble: activeEnsemble,
        shadow_rankings: computeShadowRankings({
            noveltyComposite,
            uncertainty,
            progress,
            curriculum,
        }),
    };
}
export function rankGoalsByScore(goals) {
    return [...goals].sort((left, right) => {
        return right.scoresByModel.active_ensemble - left.scoresByModel.active_ensemble;
    });
}
