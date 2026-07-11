import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  it("enforces economic Stage 0", () => {
    expect(resolveConfig({ stage: 99 }).stage).toBe(0);
  });
  it("uses safe developmental defaults", () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });
});
