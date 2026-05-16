import { describe, expect, it } from "vitest";
import { DEFAULT_CURIOSITY_CONFIG, parseWindowDuration, resolveCuriosityConfig } from "./config.js";

describe("resolveCuriosityConfig", () => {
  it("returns defaults when config is missing", () => {
    expect(resolveCuriosityConfig(undefined)).toEqual(DEFAULT_CURIOSITY_CONFIG);
  });

  it("defaults external budgets high enough for a multi-step web pass", () => {
    const resolved = resolveCuriosityConfig(undefined);

    expect(resolved.budgets.externalActionsPerHour).toBeGreaterThanOrEqual(
      resolved.actionPolicy.minimumSensingSteps,
    );
  });

  it("merges valid overrides", () => {
    const resolved = resolveCuriosityConfig({
      budgets: { autonomousRunsPerDay: 5 },
      thresholds: { act: 0.7 },
      boredom: {
        idleStartMinutes: 2,
        saturationMinutes: 20,
        maxScoreBonus: 0.4,
        wakeLevel: 0.8,
        wakeCheckMinutes: 3,
        wakeMinIntervalMinutes: 7,
        satiationMinutes: 11,
      },
      actionPolicy: {
        externalTargetPolicy: "research-web-only",
        minimumSensingSteps: 3,
        maxAttemptsPerGoal: 4,
        retryCooldownMinutes: 30,
      },
      notifications: {
        autonomousStart: {
          enabled: true,
          provider: "telegram",
          telegram: { botToken: "token", chatId: "123", disableNotification: true },
          minIntervalMinutes: 15,
          includeEvidence: false,
        },
      },
    });

    expect(resolved.budgets.autonomousRunsPerDay).toBe(5);
    expect(resolved.thresholds.act).toBe(0.7);
    expect(resolved.boredom).toEqual({
      enabled: true,
      idleStartMinutes: 2,
      saturationMinutes: 20,
      maxScoreBonus: 0.4,
      wakeLevel: 0.8,
      wakeCheckMinutes: 3,
      wakeMinIntervalMinutes: 7,
      satiationMinutes: 11,
    });
    expect(resolved.actionPolicy.externalTargetPolicy).toBe("research-web-only");
    expect(resolved.actionPolicy.minimumSensingSteps).toBe(3);
    expect(resolved.actionPolicy.maxAttemptsPerGoal).toBe(4);
    expect(resolved.actionPolicy.retryCooldownMinutes).toBe(30);
    expect(resolved.budgets.externalActionsPerDay).toBe(
      DEFAULT_CURIOSITY_CONFIG.budgets.externalActionsPerDay,
    );
    expect(resolved.notifications.autonomousStart).toEqual({
      enabled: true,
      provider: "telegram",
      telegram: { botToken: "token", chatId: "123", disableNotification: true },
      minIntervalMinutes: 15,
      includeEvidence: false,
    });
  });

  it("keeps boredom saturation after the start point", () => {
    const resolved = resolveCuriosityConfig({
      boredom: { idleStartMinutes: 10, saturationMinutes: 3 },
    });

    expect(resolved.boredom.idleStartMinutes).toBe(10);
    expect(resolved.boredom.saturationMinutes).toBeGreaterThan(10);
  });

  it("requires a valid window before enabling configured active hours", () => {
    const resolved = resolveCuriosityConfig({
      actionPolicy: { activeHours: "configured-window" },
    });

    expect(resolved.actionPolicy.activeHours).toBe("always-on");
    expect(resolved.actionPolicy.activeWindow).toBeUndefined();
  });

  it("parses configured active windows", () => {
    const resolved = resolveCuriosityConfig({
      actionPolicy: {
        activeHours: "configured-window",
        activeWindow: {
          start: "09:30",
          end: "17:45",
          timeZone: "Europe/Berlin",
        },
      },
    });

    expect(resolved.actionPolicy.activeHours).toBe("configured-window");
    expect(resolved.actionPolicy.activeWindow).toEqual({
      start: "09:30",
      end: "17:45",
      timeZone: "Europe/Berlin",
    });
  });
});

describe("parseWindowDuration", () => {
  it("parses duration strings", () => {
    expect(parseWindowDuration("30m")).toBe(30 * 60 * 1000);
    expect(parseWindowDuration("6h")).toBe(6 * 60 * 60 * 1000);
    expect(parseWindowDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
