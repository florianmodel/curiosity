import { describe, expect, it } from "vitest";
import {
  parseGeneratedCandidates,
  parseRunReport,
  reportedNoSensingAffordance,
} from "./prompts.js";

describe("parseGeneratedCandidates", () => {
  it("parses a fenced JSON array", () => {
    const text = [
      "Here are my candidates:",
      "```json",
      JSON.stringify([
        {
          topic: "Tidal heating on Io",
          domain: "planetary science",
          why_interesting: "I do not know how the heat budget balances.",
          first_action: "Fetch the moment-of-inertia data and compute dissipation",
          expected_artifact: "A short notebook estimating tidal power",
          expected_surprise: 0.7,
        },
      ]),
      "```",
    ].join("\n");
    const candidates = parseGeneratedCandidates(text);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].topic).toBe("Tidal heating on Io");
    expect(candidates[0].origin).toBe("llm_generated");
    expect(candidates[0].expectedSurprise).toBeCloseTo(0.7, 5);
  });

  it("parses a bare array and skips entries without a topic", () => {
    const text = JSON.stringify([
      { domain: "x", first_action: "do something" },
      { topic: "Mycelium signal networks", first_action: "build a model" },
    ]);
    const candidates = parseGeneratedCandidates(text);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].topic).toBe("Mycelium signal networks");
    expect(candidates[0].expectedSurprise).toBe(0.5);
  });

  it("returns empty on non-JSON", () => {
    expect(parseGeneratedCandidates("I could not produce JSON.")).toEqual([]);
  });
});

describe("parseRunReport", () => {
  it("parses a fenced wander-report block", () => {
    const text = [
      "I explored the topic and built a thing.",
      "```wander-report",
      JSON.stringify({
        topic: "Slime mold routing",
        summary: "Built a sim; it matched the paper within 8%.",
        surprise: 0.4,
        learning_progress: 0.6,
        artifacts: ["wander-playground/2026-06-10-slime/sim.py"],
        next_clue: "Try weighted edges",
        worth_continuing: true,
      }),
      "```",
    ].join("\n");
    const report = parseRunReport(text);
    expect(report).not.toBeNull();
    expect(report?.topic).toBe("Slime mold routing");
    expect(report?.learningProgress).toBeCloseTo(0.6, 5);
    expect(report?.worthContinuing).toBe(true);
    expect(report?.artifacts).toHaveLength(1);
  });

  it("returns null when no report block is present", () => {
    expect(parseRunReport("I did some stuff and stopped.")).toBeNull();
  });
});

describe("reportedNoSensingAffordance", () => {
  it("detects the affordance token", () => {
    expect(reportedNoSensingAffordance("NO_SENSING_AFFORDANCE no web tools")).toBe(true);
    expect(reportedNoSensingAffordance("all good")).toBe(false);
  });
});
