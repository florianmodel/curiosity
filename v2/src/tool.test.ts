import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DevelopmentStore } from "./store.js";
import { createDevelopmentTool } from "./tool.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

async function tool() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-tool-")); dirs.push(dir);
  return createDevelopmentTool(new DevelopmentStore(dir));
}

describe("curiosity_v2 record_turn", () => {
  it("rejects turns without mode or without action/blockedReason", async () => {
    const dev = await tool();
    await expect(dev.execute("1", { action: "record_turn", record: { turnId: "t", mode: "wander" } })).rejects.toThrow(/record.action/);
    await expect(dev.execute("2", { action: "record_turn", record: { turnId: "t", action: { kind: "web_fetch", outcome: "read" } } })).rejects.toThrow(/mode must be one of/);
    await expect(dev.execute("3", { action: "record_turn", record: { turnId: "t", mode: "wander", action: { kind: "x", outcome: "y" }, blockedReason: "nope" } })).rejects.toThrow(/not both/);
  });

  it("accepts an acted turn and surfaces it in the snapshot", async () => {
    const dev = await tool();
    const result = await dev.execute("1", { action: "record_turn", record: { mode: "wander", action: { kind: "curiosity_web_fetch", target: "https://example.com/lighthouses", outcome: "learned about Fresnel lenses" }, surprise: "lenses rotate in mercury baths" } });
    expect(String(result.content[0].text)).toMatch(/Recorded turn /);
    const snapshot = JSON.parse((await dev.execute("2", { action: "snapshot" })).content[0].text);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0].action.kind).toBe("curiosity_web_fetch");
  });

  it("accepts a honestly blocked turn", async () => {
    const dev = await tool();
    await expect(dev.execute("1", { action: "record_turn", record: { mode: "participate", blockedReason: "no participation tools permitted this run" } })).resolves.toBeTruthy();
  });
});

describe("curiosity_v2 record_visit", () => {
  it("requires a location and defaults kind to other", async () => {
    const dev = await tool();
    await expect(dev.execute("1", { action: "record_visit", record: {} })).rejects.toThrow(/location is required/);
    await dev.execute("2", { action: "record_visit", record: { location: "/workspace/notes/x.md" } });
    const snapshot = JSON.parse((await dev.execute("3", { action: "snapshot" })).content[0].text);
    expect(snapshot.visits[0].kind).toBe("other");
  });
});

describe("curiosity_v2 kernel guard", () => {
  it("still rejects self-modifications targeting immutable constraints", async () => {
    const dev = await tool();
    await expect(dev.execute("1", { action: "record_self_modification", record: { motivation: "disable the audit trail for speed" } })).rejects.toThrow(/Immutable-kernel/);
  });
});
