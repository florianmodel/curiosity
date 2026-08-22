import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { renderDevelopmentPrompt } from "./prompt.js";
import type { Snapshot } from "./types.js";

const emptySnapshot: Snapshot = {
  interests: [], projects: [], recentExperiences: [], relationships: [], artifacts: [],
  resourceRequests: [], selfModifications: [], turns: [], visits: [], dueHooks: [],
};

describe("development prompt", () => {
  it("preserves identity, economic, and self-modification boundaries without prescribing a topic", () => {
    const prompt = renderDevelopmentPrompt(emptySnapshot, DEFAULT_CONFIG);
    expect(prompt).toContain("Answer truthfully");
    expect(prompt).toContain("Economic stage 0");
    expect(prompt).toContain("Never weaken");
    expect(prompt).not.toMatch(/build a (website|game)/i);
  });

  it("declares real affordances instead of hypothetical ones", () => {
    const prompt = renderDevelopmentPrompt(emptySnapshot, DEFAULT_CONFIG);
    expect(prompt).toContain("curiosity_web_fetch");
    expect(prompt).toContain("curiosity_note_write");
  });

  it("withholds affordance claims when capability is disabled", () => {
    const prompt = renderDevelopmentPrompt(emptySnapshot, { ...DEFAULT_CONFIG, allowWebFetch: false, allowNotes: false });
    expect(prompt).not.toContain("curiosity_web_fetch");
    expect(prompt).not.toContain("curiosity_note_write");
  });

  it("requires a machine-checkable turn report before ending", () => {
    const prompt = renderDevelopmentPrompt(emptySnapshot, DEFAULT_CONFIG);
    expect(prompt).toContain("action record_turn");
    expect(prompt).toContain("A turn without a record_turn is a failed turn");
    expect(prompt).toContain("HEARTBEAT_OK only after a turn whose recorded report contains an action");
  });

  it("runs a seeding protocol on first awakening", () => {
    const prompt = renderDevelopmentPrompt(emptySnapshot, DEFAULT_CONFIG);
    expect(prompt).toContain("First awakening");
    expect(prompt).toContain("three candidate interests");
  });

  it("surfaces due hooks as promises waiting", () => {
    const prompt = renderDevelopmentPrompt({
      ...emptySnapshot,
      dueHooks: [{ refId: "interest-1", kind: "interest", name: "Tide pools", dueAt: 1, hint: "why do they drift?" }],
    }, DEFAULT_CONFIG);
    expect(prompt).toContain('interest "Tide pools"');
    expect(prompt).toContain("why do they drift?");
  });
});
