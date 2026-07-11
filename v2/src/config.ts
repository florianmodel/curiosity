import type { V2Config } from "./types.js";

export const DEFAULT_CONFIG: V2Config = {
  enabled: true,
  stage: 0,
  wakeIntervalMinutes: 30,
  maxAutonomousRunsPerDay: 12,
  maxAutonomousTokensPerDay: 50_000,
  allowPublicParticipation: true,
  allowDirectConversations: true,
  allowSelfModification: true,
};

export function resolveConfig(value: unknown): V2Config {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const number = (key: keyof V2Config, fallback: number) =>
    typeof input[key] === "number" && Number.isFinite(input[key]) ? Number(input[key]) : fallback;
  const boolean = (key: keyof V2Config, fallback: boolean) =>
    typeof input[key] === "boolean" ? Boolean(input[key]) : fallback;
  return {
    enabled: boolean("enabled", DEFAULT_CONFIG.enabled),
    stage: 0,
    wakeIntervalMinutes: Math.max(1, number("wakeIntervalMinutes", DEFAULT_CONFIG.wakeIntervalMinutes)),
    maxAutonomousRunsPerDay: Math.max(1, Math.trunc(number("maxAutonomousRunsPerDay", DEFAULT_CONFIG.maxAutonomousRunsPerDay))),
    maxAutonomousTokensPerDay: Math.max(1, Math.trunc(number("maxAutonomousTokensPerDay", DEFAULT_CONFIG.maxAutonomousTokensPerDay))),
    allowPublicParticipation: boolean("allowPublicParticipation", DEFAULT_CONFIG.allowPublicParticipation),
    allowDirectConversations: boolean("allowDirectConversations", DEFAULT_CONFIG.allowDirectConversations),
    allowSelfModification: boolean("allowSelfModification", DEFAULT_CONFIG.allowSelfModification),
  };
}
