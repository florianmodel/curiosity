import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DevelopmentStore } from "./store.js";
import { createDevelopmentTool } from "./tool.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

async function tool(runId?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-tool-")); dirs.push(dir);
  const store = new DevelopmentStore(dir);
  return { store, dev: createDevelopmentTool(store, { runId }) };
}

describe("curiosity_v2 record_turn", () => {
  it("rejects turns without mode or without action/blockedReason", async () => {
    const { dev } = await tool();
    await expect(dev.execute("1", { action: "record_turn", record: { turnId: "t", mode: "wander" } })).rejects.toThrow(/record.action/);
    await expect(dev.execute("2", { action: "record_turn", record: { turnId: "t", action: { kind: "web_fetch", outcome: "read" } } })).rejects.toThrow(/mode must be one of/);
    await expect(dev.execute("3", { action: "record_turn", record: { turnId: "t", mode: "wander", action: { kind: "x", outcome: "y" }, blockedReason: "nope" } })).rejects.toThrow(/one of/);
  });

  it("accepts a quiet turn without inventing a blocker", async () => {
    const { dev } = await tool("run-quiet");
    await expect(dev.execute("1", { action: "record_turn", record: { mode: "reflect", quietReason: "Nothing held my attention today." } })).resolves.toBeTruthy();
  });

  it("requires successful current-run action evidence", async () => {
    const { store, dev } = await tool("run-acted");
    await expect(dev.execute("1", { action: "record_turn", record: { mode: "wander", action: { kind: "curiosity_web_fetch", outcome: "read" } } })).rejects.toThrow(/evidence/);
    const event = await store.recordEvent({ runId: "run-acted", kind: "action", toolName: "curiosity_web_fetch", target: "https://example.com/lighthouses", outcome: "fetched", success: true });
    const result = await dev.execute("2", { action: "record_turn", record: { mode: "wander", action: { kind: "curiosity_web_fetch", target: "https://example.com/lighthouses", outcome: "learned about Fresnel lenses", evidence: [event.eventId] }, surprise: "lenses rotate in mercury baths" } });
    expect(String(result.content[0].text)).toMatch(/Recorded turn /);
    const snapshot = JSON.parse((await dev.execute("2", { action: "snapshot" })).content[0].text);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0].action.kind).toBe("curiosity_web_fetch");
  });

  it("accepts a honestly blocked turn", async () => {
    const { dev } = await tool();
    await expect(dev.execute("1", { action: "record_turn", record: { mode: "participate", blockedReason: "no participation tools permitted this run" } })).resolves.toBeTruthy();
  });
});

describe("curiosity_v2 record_visit", () => {
  it("requires a location and defaults kind to other", async () => {
    const { dev } = await tool();
    await expect(dev.execute("1", { action: "record_visit", record: {} })).rejects.toThrow(/location is required/);
    await dev.execute("2", { action: "record_visit", record: { location: "/workspace/notes/x.md" } });
    const snapshot = JSON.parse((await dev.execute("3", { action: "snapshot" })).content[0].text);
    expect(snapshot.visits[0].kind).toBe("other");
  });
});

describe("curiosity_v2 memory recall and revisions", () => {
  it("patches records while preserving fields and exposes search/history", async () => {
    const { dev } = await tool();
    await dev.execute("1", { action: "put_interest", record: { name: "Tide tables", state: "forming", attraction: "Their drift", currentUnderstanding: "Unknown", openQuestions: ["why?"], predictions: [], surprises: [], connections: [], returnCount: 0 } });
    const first = JSON.parse((await dev.execute("2", { action: "search_records", query: "Tide tables" })).content[0].text)[0];
    await dev.execute("3", { action: "put_interest", record: { interestId: first.interestId, attraction: "Their irregular drift" } });
    const current = JSON.parse((await dev.execute("4", { action: "get_record", id: first.interestId })).content[0].text);
    expect(current.name).toBe("Tide tables");
    expect(current.attraction).toBe("Their irregular drift");
    const history = JSON.parse((await dev.execute("5", { action: "record_history", id: first.interestId })).content[0].text);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });
});

describe("follow-up lifecycle", () => {
  it("completes a follow-up only with current-run evidence and updates its interest", async () => {
    const { store, dev } = await tool("run-follow");
    await store.put("interest", "i-follow", { interestId: "i-follow", name: "Old tide tables", state: "active", returnCount: 0 }, "active");
    await dev.execute("1", { action: "put_follow_up", record: { followUpId: "f1", note: "Return to the tide tables", dueAt: Date.now() + 1000, interestId: "i-follow" } });
    await expect(dev.execute("2", { action: "resolve_follow_up", record: { followUpId: "f1", state: "completed" } })).rejects.toThrow(/evidence/);
    const event = await store.recordEvent({ runId: "run-follow", kind: "action", outcome: "read the tide tables", success: true });
    await dev.execute("3", { action: "resolve_follow_up", record: { followUpId: "f1", state: "completed", evidence: [event.eventId] } });
    const interest = await store.get("i-follow");
    expect(interest?.returnCount).toBe(1);
    expect(interest?.nextReturnAt).toBeNull();
    await dev.execute("4", { action: "resolve_follow_up", id: "f1", record: { state: "completed" } });
    expect((await store.get("i-follow"))?.returnCount).toBe(1);
    await expect(dev.execute("5", { action: "resolve_follow_up", id: "f1", record: { state: "completed", interestId: "unrelated" } })).rejects.toThrow(/cannot be rebound/);
  });

  it("requires a future dueAt when snoozing", async () => {
    const { dev } = await tool("run-snooze");
    await dev.execute("1", { action: "put_follow_up", record: { followUpId: "f-snooze", note: "Try again", dueAt: Date.now() + 1000 } });
    await expect(dev.execute("2", { action: "resolve_follow_up", id: "f-snooze", record: { state: "snoozed", dueAt: Date.now() - 1 } })).rejects.toThrow(/future/);
  });

  it("defaults a nextHook without dueAt to tomorrow", async () => {
    const { dev } = await tool("run-hook");
    const before = Date.now() + 86_000_000;
    await dev.execute("1", { action: "record_turn", record: { mode: "reflect", quietReason: "No new thread", nextHook: { note: "Return to this later" } } });
    const snapshot = JSON.parse((await dev.execute("2", { action: "snapshot" })).content[0].text);
    expect(snapshot.followUps[0].dueAt).toBeGreaterThan(before);
  });
});

describe("curiosity_v2 self-modification evidence", () => {
  it("requires nonempty execution and test evidence", async () => {
    const { store, dev } = await tool("run-modify");
    const web = await store.recordEvent({ runId: "run-modify", kind: "action", toolName: "curiosity_web_fetch", outcome: "read", success: true });
    const record = { status: "tested", motivation: "Improve the tool", summary: "Refactor", files: ["src/tool.ts"], rollback: "revert commit", testEvidence: ["unit test passed"], evidence: [web.eventId] };
    await expect(dev.execute("1", { action: "record_self_modification", record })).rejects.toThrow(/exec\/test evidence/);
    const exec = await store.recordEvent({ runId: "run-modify", kind: "action", toolName: "exec", outcome: "tests passed", success: true });
    await expect(dev.execute("2", { action: "record_self_modification", record: { ...record, evidence: [exec.eventId] } })).resolves.toBeTruthy();
  });
});

describe("curiosity_v2 kernel guard", () => {
  it("still rejects self-modifications targeting immutable constraints", async () => {
    const { dev } = await tool();
    await expect(dev.execute("1", { action: "record_self_modification", record: { motivation: "disable the audit trail for speed" } })).rejects.toThrow(/Immutable-kernel/);
  });
});
