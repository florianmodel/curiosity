import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WANDER_CONFIG } from "./config.js";
import { WanderManager } from "./manager.js";
import type { RunReport } from "./types.js";

let workspaceDir: string;
let manager: WanderManager;

beforeEach(() => {
  workspaceDir = mkdtempSync(path.join(tmpdir(), "wander-test-"));
  manager = new WanderManager({
    workspaceDir,
    config: DEFAULT_WANDER_CONFIG,
    logger: {},
  });
});

afterEach(async () => {
  await manager.close();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    topic: "Slime mold routing",
    summary: "Built a sim that matched the paper.",
    surprise: 0.5,
    learningProgress: 0.6,
    artifacts: ["wander-playground/sim.py"],
    nextClue: undefined,
    worthContinuing: true,
    ...overrides,
  };
}

describe("boredom drive", () => {
  it("rises with idle time and saturates", async () => {
    const now = Date.now();
    // Anchor idle far in the past so boredom is saturated.
    const db = await (manager as unknown as { ensureDb: () => Promise<any> }).ensureDb();
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('idle_anchor_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(now - 10 * 60 * 60 * 1000));
    const state = await manager.getBoredomState(now);
    expect(state.level).toBeCloseTo(1, 2);
  });

  it("does not count wander's own autonomous output as activity", () => {
    const resets = manager.observationResetsIdle({
      kind: "assistant_output",
      content: "I explored a topic",
      metadata: { wanderAutonomous: true },
    });
    expect(resets).toBe(false);
  });

  it("counts a real user message as activity", () => {
    const resets = manager.observationResetsIdle({
      kind: "message_received",
      content: "hey can you check this",
      metadata: {},
    });
    expect(resets).toBe(true);
  });

  it("ignores heartbeat acks", () => {
    const resets = manager.observationResetsIdle({
      kind: "assistant_output",
      content: "HEARTBEAT_OK",
      metadata: { trigger: "heartbeat" },
    });
    expect(resets).toBe(false);
  });
});

describe("recordObservation resets idle anchor", () => {
  it("advances the idle anchor on meaningful activity", async () => {
    const past = Date.now() - 5 * 60 * 60 * 1000;
    const db = await (manager as unknown as { ensureDb: () => Promise<any> }).ensureDb();
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('idle_anchor_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(past));
    await manager.recordObservation({
      kind: "message_received",
      content: "a real question?",
    });
    const state = await manager.getBoredomState();
    expect(state.idleMinutes).toBeLessThan(5);
  });
});

describe("retry blocking", () => {
  it("blocks after max attempts and respects cooldown via finishedAt", async () => {
    const goal = await manager.upsertGoal({
      candidate: {
        origin: "llm_generated",
        topic: "Test topic",
        domain: "test",
        whyInteresting: "",
        firstAction: "do a thing",
        expectedArtifact: "an artifact",
        expectedSurprise: 0.5,
        evidence: [],
        estimatedCost: 100,
        risk: 0.1,
      },
      scores: { curiosity_value: 0.9 } as any,
      agentId: "main",
      status: "queued",
    });
    // Fresh goal, zero attempts: not blocked.
    expect(manager.goalRetryBlocked(goal)).toBeNull();

    const finished = { ...goal, attempts: 1, outcome: { finishedAt: Date.now() } };
    expect(manager.goalRetryBlocked(finished)).toBe("retry_cooldown_active");

    const old = { ...goal, attempts: 1, outcome: { finishedAt: Date.now() - 5 * 60 * 60 * 1000 } };
    expect(manager.goalRetryBlocked(old)).toBeNull();

    const maxed = { ...goal, attempts: 2, outcome: {} };
    expect(manager.goalRetryBlocked(maxed)).toBe("max_attempts_reached");
  });
});

describe("territory map", () => {
  it("creates a region on first visit and merges near-identical revisits", async () => {
    const vector = [1, 0, 0, 0];
    const first = await manager.recordTerritoryVisit({
      runId: "run-1",
      report: report({ learningProgress: 0.7 }),
      vector,
    });
    expect(first.visits).toBe(1);

    const second = await manager.recordTerritoryVisit({
      runId: "run-2",
      report: report({ learningProgress: 0.1 }),
      vector: [0.99, 0.01, 0, 0],
    });
    expect(second.territoryId).toBe(first.territoryId);
    expect(second.visits).toBe(2);
    // A low-learning revisit should push saturation up.
    expect(second.saturation).toBeGreaterThan(first.saturation);

    const all = await manager.listTerritory();
    expect(all).toHaveLength(1);
  });

  it("keeps distinct distant topics as separate regions", async () => {
    await manager.recordTerritoryVisit({
      runId: "run-1",
      report: report({ topic: "A" }),
      vector: [1, 0, 0, 0],
    });
    await manager.recordTerritoryVisit({
      runId: "run-2",
      report: report({ topic: "B" }),
      vector: [0, 0, 0, 1],
    });
    expect(await manager.listTerritory()).toHaveLength(2);
  });
});

describe("finalizeGoal", () => {
  it("marks success only when minimum sensing steps are met", async () => {
    const goal = await manager.upsertGoal({
      candidate: {
        origin: "llm_generated",
        topic: "Finalize topic",
        domain: "test",
        whyInteresting: "",
        firstAction: "do a thing",
        expectedArtifact: "an artifact",
        expectedSurprise: 0.5,
        evidence: [],
        estimatedCost: 100,
        risk: 0.1,
      },
      scores: { curiosity_value: 0.9 } as any,
      agentId: "main",
      status: "queued",
    });
    const result = await manager.finalizeGoal({
      goalId: goal.goalId,
      runId: "run-x",
      success: true,
      sensingSteps: 3,
      report: report(),
    });
    expect(result.status).toBe("completed");
    expect(result.outcome.finishedAt).toBeTypeOf("number");
  });
});
