import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DevelopmentStore } from "./store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe("DevelopmentStore", () => {
  it("keeps interests durable across store instances", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-")); dirs.push(dir);
    const first = new DevelopmentStore(dir);
    await first.put("interest", "interest-1", { interestId: "interest-1", name: "Odd clocks" }, "forming");
    const snapshot = await new DevelopmentStore(dir).snapshot();
    expect(snapshot.interests).toEqual([{ interestId: "interest-1", name: "Odd clocks" }]);
  });

  it("counts successes and in-flight runs toward the ceiling; failures never block", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-")); dirs.push(dir);
    const store = new DevelopmentStore(dir);
    for (let index = 0; index < 3; index++) {
      await store.recordRunStart(`ok-${index}`);
      await store.recordRunEnd(`ok-${index}`, true, 100 + index);
    }
    for (let index = 0; index < 5; index++) {
      await store.recordRunStart(`failed-${index}`, Date.now() - index * 1000);
      await store.recordRunEnd(`failed-${index}`, false);
    }
    await store.recordRunStart("in-flight");
    let usage = await store.usage24h();
    expect(usage.runs).toBe(4);
    expect(usage.tokens).toBe(303);
    await store.recordRunEnd("in-flight", false, 50);
    usage = await store.usage24h();
    expect(usage.runs).toBe(3);
    expect(usage.tokens).toBe(303);
  });

  it("computes due hooks from overdue interests and projects", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-")); dirs.push(dir);
    const store = new DevelopmentStore(dir);
    await store.put("interest", "i1", { interestId: "i1", name: "Old tide tables", state: "active", openQuestions: ["why do they drift?"], nextReturnAt: Date.now() - 5000 }, "active");
    await store.put("project", "p1", { projectId: "p1", name: "Clock garden", state: "active", nextMove: "add the pendulum", nextReturnAt: Date.now() + 86_400_000 }, "active");
    await store.put("interest", "i2", { interestId: "i2", name: "Future thing", state: "active", nextReturnAt: Date.now() + 86_400_000 }, "active");
    const snapshot = await store.snapshot();
    expect(snapshot.dueHooks.map(hook => hook.refId)).toEqual(["i1"]);
    expect(snapshot.dueHooks[0].hint).toBe("why do they drift?");
  });

  it("records and lists turn reports", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-")); dirs.push(dir);
    const store = new DevelopmentStore(dir);
    await store.put("turn", "t1", { turnId: "t1", mode: "wander", action: { kind: "web_fetch", target: "https://example.com", outcome: "read about lighthouses" } });
    const snapshot = await store.snapshot();
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0].action?.kind).toBe("web_fetch");
  });
});
