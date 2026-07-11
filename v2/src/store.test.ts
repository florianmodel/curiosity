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
});
