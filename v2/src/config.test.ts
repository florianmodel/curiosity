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

it("uses a light cadence and supports independently disabled social permissions",()=>{
  expect(DEFAULT_CONFIG.maxAutonomousRunsPerDay).toBe(3);
  expect(DEFAULT_CONFIG.wakeIntervalMinutes).toBe(480);
  expect(resolveConfig({maxSocialActionsPerDay:0,allowDirectConversations:false}).maxSocialActionsPerDay).toBe(0);
  expect(resolveConfig({allowDirectConversations:false}).allowPublicParticipation).toBe(true);
});
it("accepts only an instance origin and an environment variable name for Mastodon",()=>{
  expect(resolveConfig({mastodon:{baseUrl:"https://social.example"}}).mastodon).toEqual({baseUrl:"https://social.example",accessTokenEnv:"CURIOSITY_MASTODON_TOKEN"});
  expect(()=>resolveConfig({mastodon:{baseUrl:"http://social.example"}})).toThrow(/HTTPS/);
  expect(()=>resolveConfig({mastodon:{baseUrl:"https://token@social.example"}})).toThrow(/credentials/);
});
