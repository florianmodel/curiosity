import type { Candidate, GoalRecord, RunReport, TerritoryRecord } from "./types.js";

function clampNumber(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function radiusDescriptor(radius: number): string {
  if (radius < 0.35) {
    return "stay fairly close to recent context";
  }
  if (radius < 0.6) {
    return "move clearly outward from recent context";
  }
  if (radius < 0.8) {
    return "go far afield into unfamiliar domains";
  }
  return "go very far afield, into domains with no overlap with recent context";
}

export function renderTerritorySummary(territory: TerritoryRecord[], maxItems: number): string[] {
  return territory
    .slice(0, maxItems)
    .map(
      (region) =>
        `- ${region.topic} (visits=${region.visits}, learning=${region.learningProgress.toFixed(2)}, saturation=${region.saturation.toFixed(2)})`,
    );
}

export function renderGenerationPrompt(params: {
  candidateCount: number;
  boredomLevel: number;
  radius: number;
  activitySummary: string[];
  territorySummary: string[];
  allowExternalActions: boolean;
}): string {
  const lines = [
    "## Curiosity Candidate Generation",
    "You are generating candidate curiosities for your own future autonomous exploration time.",
    "This is a generation step only: do NOT use any tools, do NOT explore yet, reply with JSON only.",
    "",
    `Drive state: boredom=${params.boredomLevel.toFixed(2)}, target exploration radius=${params.radius.toFixed(2)} (${radiusDescriptor(params.radius)}).`,
    "",
    "Recent activity context (your current semantic neighborhood):",
    ...(params.activitySummary.length > 0 ? params.activitySummary : ["- (no recent activity)"]),
    "",
    "Explored territory so far (regions you have already visited):",
    ...(params.territorySummary.length > 0 ? params.territorySummary : ["- (nothing explored yet)"]),
    "",
    "Selection pressure you are generating against (be honest with yourself about it):",
    "- Candidates semantically close to the recent activity context score poorly unless they promise unusually strong learning progress.",
    "- Candidates near already-saturated territory score poorly.",
    "- Candidates score well when they sit near the target radius: far enough to surprise, structured enough to act on.",
    "- Candidates with a concrete first action and a concrete expected artifact score well; vague observation-only ideas score poorly.",
    "- Building, testing, comparing, simulating, and creating beat passive reading.",
    "",
    `Generate exactly ${params.candidateCount} candidate curiosities. Spread them across genuinely different domains and different distances from the current context. Each candidate must name a real, specific topic in the world (a phenomenon, technique, dataset, system, culture, organism, algorithm, historical event, etc.), not a meta-task about yourself, unless that meta-task honestly promises exceptional learning progress.`,
    params.allowExternalActions
      ? "Web research tools will be available during the run, so candidates may rely on browsing or searching."
      : "Only local workspace tools will be available during the run (no web access), so every candidate must be actionable with local file and code tools alone.",
    "",
    "Reply with ONLY a JSON array, no prose before or after, matching this schema:",
    `[
  {
    "topic": "specific subject to explore",
    "domain": "one-or-two-word domain label",
    "why_interesting": "what is unknown or surprising here, and why it seems learnable",
    "first_action": "the concrete first tool-backed step you would take",
    "expected_artifact": "the concrete reversible artifact, observation, or experiment result the run should leave behind",
    "expected_surprise": 0.0
  }
]`,
    "expected_surprise is your own 0..1 estimate of prediction error: how much you expect reality to differ from what you currently believe.",
  ];
  return lines.join("\n");
}

export function renderRunPrompt(params: {
  goal: GoalRecord;
  playgroundDir: string;
  minimumSensingSteps: number;
  allowExternalActions: boolean;
}): string {
  const { goal } = params;
  return [
    "## Autonomous Wander Run",
    "You chose this curiosity yourself during candidate generation. Now act on it.",
    "",
    `Run goal id: ${goal.goalId}`,
    `Topic: ${goal.topic}`,
    `Domain: ${goal.domain}`,
    `Why it seemed interesting: ${goal.whyInteresting}`,
    `Planned first action: ${goal.firstAction}`,
    `Expected artifact: ${goal.expectedArtifact}`,
    "",
    "Constraints:",
    `- Start with the planned first action (or a better tool-backed first step) immediately; do not narrate a plan first.`,
    `- Take at least ${params.minimumSensingSteps} tool-backed steps before concluding.`,
    "- Observation alone is not enough: build, transform, compare, test, simulate, or otherwise create something concrete.",
    `- Your playground directory is: ${params.playgroundDir}`,
    "- You may create files freely inside the playground directory and nowhere else. Put every artifact you produce there.",
    "- If the topic turns out to be boring or unreachable, say so honestly and stop early; do not pad the run.",
    "- If no safe tool affordance exists at all, reply NO_SENSING_AFFORDANCE followed by the blocker.",
    params.allowExternalActions
      ? "- Web research tools are allowed."
      : "- Web access is not allowed in this run; use local tools only.",
    "- Stay within existing OpenClaw safety, approvals, and tool policies.",
    "- Do one bounded pass and stop.",
    "",
    "End your final message with a fenced block exactly like this (valid JSON inside):",
    "```wander-report",
    `{
  "topic": "what you actually explored",
  "summary": "2-4 sentences: what you did, what you found, what surprised you",
  "surprise": 0.0,
  "learning_progress": 0.0,
  "artifacts": ["paths of files you created in the playground, if any"],
  "next_clue": "the most promising follow-up direction, or null",
  "worth_continuing": false
}`,
    "```",
    "surprise: 0..1, how much reality differed from what you expected. learning_progress: 0..1, how much more predictable this territory became because of this run.",
  ].join("\n");
}

function extractJsonArray(text: string): unknown[] | null {
  const fenced = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  const source = fenced?.[1] ?? text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  if (!source || source.indexOf("[") !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseGeneratedCandidates(text: string): Candidate[] {
  const entries = extractJsonArray(text);
  if (!entries) {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const topic = typeof record.topic === "string" ? record.topic.trim() : "";
    if (!topic) {
      continue;
    }
    const surprise =
      typeof record.expected_surprise === "number" && Number.isFinite(record.expected_surprise)
        ? clampNumber(record.expected_surprise)
        : 0.5;
    candidates.push({
      origin: "llm_generated",
      topic,
      domain: typeof record.domain === "string" ? record.domain.trim() : "",
      whyInteresting:
        typeof record.why_interesting === "string" ? record.why_interesting.trim() : "",
      firstAction: typeof record.first_action === "string" ? record.first_action.trim() : "",
      expectedArtifact:
        typeof record.expected_artifact === "string" ? record.expected_artifact.trim() : "",
      expectedSurprise: surprise,
      evidence: [],
      estimatedCost: 500,
      risk: 0.12,
    });
  }
  return candidates;
}

export function parseRunReport(text: string): RunReport | null {
  const fenced = text.match(/```wander-report\s*([\s\S]*?)```/);
  const fallback = fenced
    ? null
    : text.match(/\{[\s\S]*"learning_progress"[\s\S]*\}/);
  const source = fenced?.[1] ?? fallback?.[0];
  if (!source) {
    return null;
  }
  try {
    const parsed = JSON.parse(source.trim()) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const artifacts = Array.isArray(parsed.artifacts)
      ? parsed.artifacts.filter((value): value is string => typeof value === "string")
      : [];
    return {
      topic: typeof parsed.topic === "string" ? parsed.topic.trim() : "",
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      surprise:
        typeof parsed.surprise === "number" && Number.isFinite(parsed.surprise)
          ? clampNumber(parsed.surprise)
          : 0,
      learningProgress:
        typeof parsed.learning_progress === "number" && Number.isFinite(parsed.learning_progress)
          ? clampNumber(parsed.learning_progress)
          : 0,
      artifacts,
      nextClue: typeof parsed.next_clue === "string" ? parsed.next_clue.trim() : undefined,
      worthContinuing: parsed.worth_continuing === true,
    };
  } catch {
    return null;
  }
}

export const NO_SENSING_AFFORDANCE_TOKEN = "NO_SENSING_AFFORDANCE";

export function reportedNoSensingAffordance(text: string): boolean {
  return text.includes(NO_SENSING_AFFORDANCE_TOKEN);
}
