import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NoteWriter } from "./notewrite.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

async function writer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-notes-")); dirs.push(dir);
  return new NoteWriter(dir);
}

describe("NoteWriter", () => {
  it("writes markdown under creations/<month> with a title header", async () => {
    const notes = await writer();
    const result = await notes.write({ slug: "Tide-Pool Notes", title: "Tide pool hypotheses", content: "First observations." });
    expect(result.path).toMatch(/creations\/\d{4}-\d{2}\/tide-pool-notes\.md$/);
    const file = await fs.readFile(result.path, "utf8");
    expect(file).toContain("# Tide pool hypotheses");
    expect(file).toContain("First observations.");
  });

  it("jails writes inside the workspace and rejects escapes", async () => {
    const notes = await writer();
    await expect(notes.write({ slug: "../../etc/hosts", content: "nope" })).rejects.toThrow(/Invalid slug|escaped/);
  });

  it("restricts extensions", async () => {
    const notes = await writer();
    await expect(notes.write({ slug: "shell", content: "#!/bin/sh", extension: "sh" })).rejects.toThrow(/not allowed/);
    await expect(notes.write({ slug: "data", content: "a,b\n1,2", extension: "csv" })).resolves.toBeTruthy();
  });

  it("refuses silent overwrite but allows deliberate overwrite", async () => {
    const notes = await writer();
    await notes.write({ slug: "journal", content: "day one" });
    await expect(notes.write({ slug: "journal", content: "day two" })).rejects.toThrow(/already exists/);
    await notes.write({ slug: "journal", content: "day two", overwrite: true });
    const file = await fs.readFile(path.join(notes.rootDir, "creations", (await fs.readdir(path.join(notes.rootDir, "creations")))[0], "journal.md"), "utf8");
    expect(file).toContain("day two");
  });
});
