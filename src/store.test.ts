import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    expect(snapshot.interests).toEqual([expect.objectContaining({ interestId: "interest-1", name: "Odd clocks" })]);
  });

  it("counts successes and in-flight runs toward the ceiling; failed tokens remain auditable", async () => {
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
    expect(usage.tokens).toBe(353);
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

describe("DevelopmentStore continuity schema", () => {
  it("migrates an old database without losing records and backfills revision history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-migration-")); dirs.push(dir);
    const dbDir = path.join(dir, ".openclaw", "curiosity-v2"); await fs.mkdir(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "development.db");
    const oldDb = new DatabaseSync(dbPath);
    oldDb.exec("CREATE TABLE records (kind TEXT NOT NULL, id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, state TEXT, body_json TEXT NOT NULL)");
    oldDb.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run("interest", "legacy-interest", 10, 20, "active", JSON.stringify({ interestId: "legacy-interest", name: "Legacy clocks" }));
    oldDb.close();
    const store = new DevelopmentStore(dir);
    expect((await store.get("legacy-interest"))?.name).toBe("Legacy clocks");
    expect((await store.history("legacy-interest"))).toHaveLength(1);
    await store.put("interest", "legacy-interest", { attraction: "Their strange drift" });
    expect((await store.history("legacy-interest"))).toHaveLength(2);
  });

  it("keeps timeline events append-only across restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-events-")); dirs.push(dir);
    const store = new DevelopmentStore(dir);
    const event = await store.recordEvent({ runId: "run-1", kind: "action", toolName: "web", outcome: "read", success: true });
    await store.put("interest", "revision-1", { interestId: "revision-1", name: "Append-only" });
    await store.close();
    const dbPath = path.join(dir, ".openclaw", "curiosity-v2", "development.db");
    const db = new DatabaseSync(dbPath);
    expect(() => db.prepare("UPDATE events SET body_json=? WHERE event_id=?").run("{}", event.eventId)).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM events WHERE event_id=?").run(event.eventId)).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE revisions SET body_json=? WHERE record_id=?").run("{}", "revision-1")).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM revisions WHERE record_id=?").run("revision-1")).toThrow(/append-only/);
    db.close();
    const reopened = new DevelopmentStore(dir);
    expect((await reopened.event(event.eventId))?.outcome).toBe("read");
  });

  it("computes due hooks from all relevant interests beyond the snapshot page", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-due-")); dirs.push(dir);
    const store = new DevelopmentStore(dir);
    for (let index = 0; index < 105; index++) {
      await store.put("interest", `due-${index}`, { interestId: `due-${index}`, name: `Due ${index}`, state: "active", nextReturnAt: index + 1 }, "active");
    }
    const snapshot = await store.snapshot();
    expect(snapshot.interests).toHaveLength(30);
    expect(snapshot.dueHooks).toHaveLength(105);
    expect(snapshot.dueHooks.some(hook => hook.refId === "due-0")).toBe(true);
  });

  it("atomically reserves no more than the configured concurrent run limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-reserve-")); dirs.push(dir);
    const store = new DevelopmentStore(dir);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => store.reserveRun(`run-${index}`, { maxRuns: 2, maxTokens: 1000 }, 1_000)));
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it("recovers expired leases before admitting a new run", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-lease-")); dirs.push(dir);
    const store = new DevelopmentStore(dir);
    expect(await store.reserveRun("expired", { maxRuns: 1, maxTokens: 1000, leaseMs: 10 }, 1000)).toBe(true);
    expect(await store.reserveRun("replacement", { maxRuns: 1, maxTokens: 1000, leaseMs: 10 }, 1011)).toBe(true);
    expect((await store.usage24h(1011)).runs).toBe(1);
  });

  it("persists external idempotency, quotas, and contact blocks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-external-")); dirs.push(dir);
    const options = { maxPerDay: 1, maxDirect: 1, direct: true, target: "@quiet@example.social" };
    const first = new DevelopmentStore(dir);
    expect((await first.reserveExternal("op-1", "fingerprint-1", options, 86_400_000 + 1000)).reserved).toBe(true);
    await first.finishExternal("op-1", { id: "post-1" });
    await first.close();
    const reopened = new DevelopmentStore(dir);
    expect(await reopened.reserveExternal("op-1", "fingerprint-1", options, 86_400_000 + 2000)).toEqual({ reserved: false, cached: { id: "post-1" } });
    await expect(reopened.reserveExternal("op-2", "fingerprint-2", options, 86_400_000 + 3000)).rejects.toThrow(/Daily social action limit/);
    await reopened.blockContact("@blocked@example.social", "opted out");
    await reopened.close();
    const finalStore = new DevelopmentStore(dir);
    expect(await finalStore.isContactBlocked("@blocked@example.social")).toBe(true);
    await expect(finalStore.reserveExternal("op-3", "fingerprint-3", { ...options, target: "@blocked@example.social" }, 172_800_000 + 1000)).rejects.toThrow(/opted out/);
  });
});
