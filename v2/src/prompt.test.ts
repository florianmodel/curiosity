import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { renderDevelopmentPrompt } from "./prompt.js";

describe("development prompt", () => {
  it("preserves identity, economic, and self-modification boundaries without prescribing a topic", () => {
    const prompt = renderDevelopmentPrompt({ interests: [], projects: [], recentExperiences: [], relationships: [], artifacts: [], resourceRequests: [], selfModifications: [] }, DEFAULT_CONFIG);
    expect(prompt).toContain("answer truthfully");
    expect(prompt).toContain("Economic stage is 0");
    expect(prompt).toContain("Never remove or weaken the audit trail");
    expect(prompt).not.toMatch(/build a (website|game)/i);
  });
});
