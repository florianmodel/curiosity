import path from "node:path";
export const DEFAULT_SHADOW_MODELS = [
    "rnd_novelty",
    "episodic_reachability",
    "plan2explore_uncertainty",
    "impact_progress",
    "llm_curriculum_reflection",
];
export const DEFAULT_CURIOSITY_CONFIG = {
    budgets: {
        autonomousRunsPerDay: 48,
        autonomousTokensPerDay: 50_000,
        externalActionsPerDay: 24,
        externalActionsPerHour: 6,
    },
    goalSources: {
        bootstrapExploration: true,
        unresolvedUserAsks: true,
        staleOpenQuestions: true,
        failedToolAttempts: false,
        newlyDiscoveredEntities: true,
        lowCoverageSurfaces: true,
        skillOpportunities: false,
        externalFollowUps: true,
        frontierExploration: true,
    },
    ensembleWeights: {
        novelty: 0.3,
        uncertainty: 0.25,
        progress: 0.25,
        curriculum: 0.2,
    },
    thresholds: {
        act: 0.6,
        staleGoalHours: 24,
        recentObservationWindowHours: 72,
    },
    boredom: {
        enabled: true,
        idleStartMinutes: 2,
        saturationMinutes: 15,
        maxScoreBonus: 0.35,
        wakeLevel: 0.25,
        wakeCheckMinutes: 0.5,
        wakeMinIntervalMinutes: 5,
        satiationMinutes: 5,
    },
    shadowModels: [...DEFAULT_SHADOW_MODELS],
    frontier: {
        enabled: true,
        maxSeedProbes: 5,
        distanceWeight: 0.24,
        selfReferencePenalty: 0.28,
        actionAffordanceWeight: 0.12,
        recursionPenalty: 0.22,
    },
    logging: {
        retentionDays: 100,
        maxStorageBytes: 10 * 1024 * 1024 * 1024,
        verbose: false,
    },
    actionPolicy: {
        allowExternalActions: true,
        externalTargetPolicy: "any-configured-surface",
        disagreementFallback: "explore-anyway",
        activeHours: "always-on",
        minimumSensingSteps: 2,
        maxAttemptsPerGoal: 2,
        retryCooldownMinutes: 5,
    },
    notifications: {
        autonomousStart: {
            enabled: false,
            provider: "telegram",
            minIntervalMinutes: 0,
            includeEvidence: true,
            observatoryBaseUrl: undefined,
        },
    },
};
export const curiosityPluginConfigSchemaJson = {
    type: "object",
    additionalProperties: false,
    properties: {
        budgets: {
            type: "object",
            additionalProperties: false,
            properties: {
                autonomousRunsPerDay: { type: "integer", minimum: 1 },
                autonomousTokensPerDay: { type: "integer", minimum: 1 },
                externalActionsPerDay: { type: "integer", minimum: 0 },
                externalActionsPerHour: { type: "integer", minimum: 0 },
            },
        },
        goalSources: {
            type: "object",
            additionalProperties: false,
            properties: {
                unresolvedUserAsks: { type: "boolean" },
                staleOpenQuestions: { type: "boolean" },
                failedToolAttempts: { type: "boolean" },
                newlyDiscoveredEntities: { type: "boolean" },
                lowCoverageSurfaces: { type: "boolean" },
                skillOpportunities: { type: "boolean" },
                externalFollowUps: { type: "boolean" },
                frontierExploration: {
                    type: "boolean",
                    description: "Allow boredom to create abstract frontier-seeking candidates beyond recent self-context.",
                },
                bootstrapExploration: {
                    type: "boolean",
                    description: "Allow curiosity to create a first bounded orientation goal when it has no prior observations.",
                },
            },
        },
        ensembleWeights: {
            type: "object",
            additionalProperties: false,
            properties: {
                novelty: { type: "number", minimum: 0, maximum: 1 },
                uncertainty: { type: "number", minimum: 0, maximum: 1 },
                progress: { type: "number", minimum: 0, maximum: 1 },
                curriculum: { type: "number", minimum: 0, maximum: 1 },
            },
        },
        thresholds: {
            type: "object",
            additionalProperties: false,
            properties: {
                act: { type: "number", minimum: 0, maximum: 1 },
                staleGoalHours: { type: "number", minimum: 1 },
                recentObservationWindowHours: { type: "number", minimum: 1 },
            },
        },
        shadowModels: {
            type: "array",
            items: { type: "string" },
        },
        frontier: {
            type: "object",
            additionalProperties: false,
            properties: {
                enabled: {
                    type: "boolean",
                    description: "Enable abstract semantic-distance pressure for curiosity scoring.",
                },
                maxSeedProbes: {
                    type: "integer",
                    minimum: 1,
                    maximum: 20,
                    description: "Maximum reachable seed probes before a frontier run commits or reports that sampled seeds were boring.",
                },
                distanceWeight: { type: "number", minimum: 0, maximum: 1 },
                selfReferencePenalty: { type: "number", minimum: 0, maximum: 1 },
                actionAffordanceWeight: { type: "number", minimum: 0, maximum: 1 },
                recursionPenalty: { type: "number", minimum: 0, maximum: 1 },
            },
        },
        boredom: {
            type: "object",
            additionalProperties: false,
            properties: {
                enabled: { type: "boolean" },
                idleStartMinutes: {
                    type: "number",
                    minimum: 0,
                    description: "Minutes of no meaningful activity before boredom starts growing.",
                },
                saturationMinutes: {
                    type: "number",
                    minimum: 0.1,
                    description: "Minutes of no meaningful activity before boredom reaches full strength.",
                },
                maxScoreBonus: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                    description: "Maximum active score bonus contributed by full boredom.",
                },
                wakeLevel: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                    description: "Boredom level that can wake a self-authored curiosity run.",
                },
                wakeCheckMinutes: {
                    type: "number",
                    minimum: 0.1,
                    description: "Polling interval for checking whether boredom should wake the agent.",
                },
                wakeMinIntervalMinutes: {
                    type: "number",
                    minimum: 0,
                    description: "Minimum minutes between boredom-triggered wake requests.",
                },
                satiationMinutes: {
                    type: "number",
                    minimum: 0,
                    description: "Minutes after an autonomous curiosity run during which boredom is suppressed.",
                },
            },
        },
        logging: {
            type: "object",
            additionalProperties: false,
            properties: {
                retentionDays: { type: "integer", minimum: 1 },
                maxStorageBytes: { type: "integer", minimum: 1 },
                verbose: { type: "boolean" },
            },
        },
        actionPolicy: {
            type: "object",
            additionalProperties: false,
            properties: {
                allowExternalActions: { type: "boolean" },
                externalTargetPolicy: {
                    type: "string",
                    enum: ["any-configured-surface", "explicit-allowlist", "research-web-only"],
                },
                disagreementFallback: {
                    type: "string",
                    enum: ["explore-anyway", "defer", "ask"],
                },
                activeHours: {
                    type: "string",
                    enum: ["always-on", "configured-window"],
                },
                minimumSensingSteps: {
                    type: "integer",
                    minimum: 1,
                    description: "Minimum allowed tool or external-action steps before an autonomous run can count as successful.",
                },
                maxAttemptsPerGoal: {
                    type: "integer",
                    minimum: 1,
                    description: "Maximum autonomous attempts for one goal fingerprint before it stops being selected.",
                },
                retryCooldownMinutes: {
                    type: "number",
                    minimum: 0,
                    description: "Minutes to wait before retrying the same goal fingerprint after an attempt.",
                },
                activeWindow: {
                    type: "object",
                    additionalProperties: false,
                    required: ["start", "end"],
                    properties: {
                        start: {
                            type: "string",
                            pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
                            description: "Start time in HH:MM 24-hour format.",
                        },
                        end: {
                            type: "string",
                            pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
                            description: "End time in HH:MM 24-hour format.",
                        },
                        timeZone: {
                            type: "string",
                            minLength: 1,
                            description: "Optional IANA time zone, for example Europe/Berlin.",
                        },
                    },
                },
            },
        },
        notifications: {
            type: "object",
            additionalProperties: false,
            properties: {
                autonomousStart: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        enabled: {
                            type: "boolean",
                            description: "Send a human notification when curiosity starts an autonomous run.",
                        },
                        provider: {
                            type: "string",
                            enum: ["telegram"],
                            description: "Notification provider. Telegram is currently supported.",
                        },
                        minIntervalMinutes: {
                            type: "number",
                            minimum: 0,
                            description: "Minimum minutes between autonomous-start notifications.",
                        },
                        includeEvidence: {
                            type: "boolean",
                            description: "Include the selected goal evidence in the notification body.",
                        },
                        observatoryBaseUrl: {
                            type: "string",
                            description: "Optional absolute base URL used to link Telegram receipts to /curiosity run traces.",
                        },
                        telegram: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                botToken: {
                                    type: "string",
                                    minLength: 1,
                                    description: "Telegram bot token used only for curiosity start notifications.",
                                },
                                chatId: {
                                    type: "string",
                                    minLength: 1,
                                    description: "Telegram chat ID, user ID, group ID, or @channel target.",
                                },
                                apiBaseUrl: {
                                    type: "string",
                                    minLength: 1,
                                    description: "Optional Telegram API base URL; defaults to https://api.telegram.org.",
                                },
                                disableNotification: {
                                    type: "boolean",
                                    description: "Use Telegram silent delivery for the notification.",
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};
function numberOrDefault(value, fallback, options) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    if (typeof options?.min === "number" && value < options.min) {
        return fallback;
    }
    if (typeof options?.max === "number" && value > options.max) {
        return fallback;
    }
    return value;
}
function integerOrDefault(value, fallback, options) {
    return Math.trunc(numberOrDefault(value, fallback, options));
}
function booleanOrDefault(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}
function stringArrayOrDefault(value, fallback) {
    if (!Array.isArray(value)) {
        return [...fallback];
    }
    const normalized = value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean);
    return normalized.length > 0 ? [...new Set(normalized)] : [...fallback];
}
function clockTimeOrUndefined(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(normalized) ? normalized : undefined;
}
function activeWindowOrUndefined(value) {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const rawWindow = value;
    const start = clockTimeOrUndefined(rawWindow.start);
    const end = clockTimeOrUndefined(rawWindow.end);
    if (!start || !end) {
        return undefined;
    }
    const timeZone = typeof rawWindow.timeZone === "string" && rawWindow.timeZone.trim().length > 0
        ? rawWindow.timeZone.trim()
        : undefined;
    return timeZone ? { start, end, timeZone } : { start, end };
}
function stringOrUndefined(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function telegramNotificationOrUndefined(value) {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const record = value;
    const botToken = stringOrUndefined(record.botToken);
    const chatId = stringOrUndefined(record.chatId);
    const apiBaseUrl = stringOrUndefined(record.apiBaseUrl);
    const disableNotification = booleanOrDefault(record.disableNotification, false);
    return {
        ...(botToken ? { botToken } : {}),
        ...(chatId ? { chatId } : {}),
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(disableNotification ? { disableNotification } : {}),
    };
}
export function resolveCuriosityConfig(raw) {
    const root = typeof raw === "object" && raw !== null ? raw : {};
    const budgets = typeof root.budgets === "object" && root.budgets !== null
        ? root.budgets
        : {};
    const goalSources = typeof root.goalSources === "object" && root.goalSources !== null
        ? root.goalSources
        : {};
    const ensembleWeights = typeof root.ensembleWeights === "object" && root.ensembleWeights !== null
        ? root.ensembleWeights
        : {};
    const thresholds = typeof root.thresholds === "object" && root.thresholds !== null
        ? root.thresholds
        : {};
    const logging = typeof root.logging === "object" && root.logging !== null
        ? root.logging
        : {};
    const frontier = typeof root.frontier === "object" && root.frontier !== null
        ? root.frontier
        : {};
    const boredom = typeof root.boredom === "object" && root.boredom !== null
        ? root.boredom
        : {};
    const actionPolicy = typeof root.actionPolicy === "object" && root.actionPolicy !== null
        ? root.actionPolicy
        : {};
    const notifications = typeof root.notifications === "object" && root.notifications !== null
        ? root.notifications
        : {};
    const autonomousStart = typeof notifications.autonomousStart === "object" && notifications.autonomousStart !== null
        ? notifications.autonomousStart
        : {};
    const observatoryBaseUrl = typeof autonomousStart.observatoryBaseUrl === "string" &&
        autonomousStart.observatoryBaseUrl.trim().length > 0
        ? autonomousStart.observatoryBaseUrl.trim()
        : undefined;
    const activeWindow = activeWindowOrUndefined(actionPolicy.activeWindow);
    const activeHours = actionPolicy.activeHours === "configured-window" && activeWindow
        ? "configured-window"
        : DEFAULT_CURIOSITY_CONFIG.actionPolicy.activeHours;
    const autonomousStartTelegram = telegramNotificationOrUndefined(autonomousStart.telegram);
    return {
        budgets: {
            autonomousRunsPerDay: integerOrDefault(budgets.autonomousRunsPerDay, DEFAULT_CURIOSITY_CONFIG.budgets.autonomousRunsPerDay, { min: 1 }),
            autonomousTokensPerDay: integerOrDefault(budgets.autonomousTokensPerDay, DEFAULT_CURIOSITY_CONFIG.budgets.autonomousTokensPerDay, { min: 1 }),
            externalActionsPerDay: integerOrDefault(budgets.externalActionsPerDay, DEFAULT_CURIOSITY_CONFIG.budgets.externalActionsPerDay, { min: 0 }),
            externalActionsPerHour: integerOrDefault(budgets.externalActionsPerHour, DEFAULT_CURIOSITY_CONFIG.budgets.externalActionsPerHour, { min: 0 }),
        },
        goalSources: {
            bootstrapExploration: booleanOrDefault(goalSources.bootstrapExploration, DEFAULT_CURIOSITY_CONFIG.goalSources.bootstrapExploration),
            unresolvedUserAsks: booleanOrDefault(goalSources.unresolvedUserAsks, DEFAULT_CURIOSITY_CONFIG.goalSources.unresolvedUserAsks),
            staleOpenQuestions: booleanOrDefault(goalSources.staleOpenQuestions, DEFAULT_CURIOSITY_CONFIG.goalSources.staleOpenQuestions),
            failedToolAttempts: booleanOrDefault(goalSources.failedToolAttempts, DEFAULT_CURIOSITY_CONFIG.goalSources.failedToolAttempts),
            newlyDiscoveredEntities: booleanOrDefault(goalSources.newlyDiscoveredEntities, DEFAULT_CURIOSITY_CONFIG.goalSources.newlyDiscoveredEntities),
            lowCoverageSurfaces: booleanOrDefault(goalSources.lowCoverageSurfaces, DEFAULT_CURIOSITY_CONFIG.goalSources.lowCoverageSurfaces),
            skillOpportunities: booleanOrDefault(goalSources.skillOpportunities, DEFAULT_CURIOSITY_CONFIG.goalSources.skillOpportunities),
            externalFollowUps: booleanOrDefault(goalSources.externalFollowUps, DEFAULT_CURIOSITY_CONFIG.goalSources.externalFollowUps),
            frontierExploration: booleanOrDefault(goalSources.frontierExploration, DEFAULT_CURIOSITY_CONFIG.goalSources.frontierExploration),
        },
        ensembleWeights: {
            novelty: numberOrDefault(ensembleWeights.novelty, DEFAULT_CURIOSITY_CONFIG.ensembleWeights.novelty, { min: 0, max: 1 }),
            uncertainty: numberOrDefault(ensembleWeights.uncertainty, DEFAULT_CURIOSITY_CONFIG.ensembleWeights.uncertainty, { min: 0, max: 1 }),
            progress: numberOrDefault(ensembleWeights.progress, DEFAULT_CURIOSITY_CONFIG.ensembleWeights.progress, { min: 0, max: 1 }),
            curriculum: numberOrDefault(ensembleWeights.curriculum, DEFAULT_CURIOSITY_CONFIG.ensembleWeights.curriculum, { min: 0, max: 1 }),
        },
        thresholds: {
            act: numberOrDefault(thresholds.act, DEFAULT_CURIOSITY_CONFIG.thresholds.act, {
                min: 0,
                max: 1,
            }),
            staleGoalHours: numberOrDefault(thresholds.staleGoalHours, DEFAULT_CURIOSITY_CONFIG.thresholds.staleGoalHours, { min: 1 }),
            recentObservationWindowHours: numberOrDefault(thresholds.recentObservationWindowHours, DEFAULT_CURIOSITY_CONFIG.thresholds.recentObservationWindowHours, { min: 1 }),
        },
        boredom: (() => {
            const idleStartMinutes = numberOrDefault(boredom.idleStartMinutes, DEFAULT_CURIOSITY_CONFIG.boredom.idleStartMinutes, { min: 0 });
            const rawSaturationMinutes = numberOrDefault(boredom.saturationMinutes, DEFAULT_CURIOSITY_CONFIG.boredom.saturationMinutes, { min: 0.1 });
            const saturationMinutes = rawSaturationMinutes > idleStartMinutes
                ? rawSaturationMinutes
                : Math.max(idleStartMinutes + 1, DEFAULT_CURIOSITY_CONFIG.boredom.saturationMinutes);
            return {
                enabled: booleanOrDefault(boredom.enabled, DEFAULT_CURIOSITY_CONFIG.boredom.enabled),
                idleStartMinutes,
                saturationMinutes,
                maxScoreBonus: numberOrDefault(boredom.maxScoreBonus, DEFAULT_CURIOSITY_CONFIG.boredom.maxScoreBonus, { min: 0, max: 1 }),
                wakeLevel: numberOrDefault(boredom.wakeLevel, DEFAULT_CURIOSITY_CONFIG.boredom.wakeLevel, { min: 0, max: 1 }),
                wakeCheckMinutes: numberOrDefault(boredom.wakeCheckMinutes, DEFAULT_CURIOSITY_CONFIG.boredom.wakeCheckMinutes, { min: 0.1 }),
                wakeMinIntervalMinutes: numberOrDefault(boredom.wakeMinIntervalMinutes, DEFAULT_CURIOSITY_CONFIG.boredom.wakeMinIntervalMinutes, { min: 0 }),
                satiationMinutes: numberOrDefault(boredom.satiationMinutes, DEFAULT_CURIOSITY_CONFIG.boredom.satiationMinutes, { min: 0 }),
            };
        })(),
        shadowModels: stringArrayOrDefault(root.shadowModels, DEFAULT_CURIOSITY_CONFIG.shadowModels),
        frontier: {
            enabled: booleanOrDefault(frontier.enabled, DEFAULT_CURIOSITY_CONFIG.frontier.enabled),
            maxSeedProbes: integerOrDefault(frontier.maxSeedProbes, DEFAULT_CURIOSITY_CONFIG.frontier.maxSeedProbes, { min: 1, max: 20 }),
            distanceWeight: numberOrDefault(frontier.distanceWeight, DEFAULT_CURIOSITY_CONFIG.frontier.distanceWeight, { min: 0, max: 1 }),
            selfReferencePenalty: numberOrDefault(frontier.selfReferencePenalty, DEFAULT_CURIOSITY_CONFIG.frontier.selfReferencePenalty, { min: 0, max: 1 }),
            actionAffordanceWeight: numberOrDefault(frontier.actionAffordanceWeight, DEFAULT_CURIOSITY_CONFIG.frontier.actionAffordanceWeight, { min: 0, max: 1 }),
            recursionPenalty: numberOrDefault(frontier.recursionPenalty, DEFAULT_CURIOSITY_CONFIG.frontier.recursionPenalty, { min: 0, max: 1 }),
        },
        logging: {
            retentionDays: integerOrDefault(logging.retentionDays, DEFAULT_CURIOSITY_CONFIG.logging.retentionDays, { min: 1 }),
            maxStorageBytes: integerOrDefault(logging.maxStorageBytes, DEFAULT_CURIOSITY_CONFIG.logging.maxStorageBytes, { min: 1 }),
            verbose: booleanOrDefault(logging.verbose, DEFAULT_CURIOSITY_CONFIG.logging.verbose),
        },
        actionPolicy: {
            allowExternalActions: booleanOrDefault(actionPolicy.allowExternalActions, DEFAULT_CURIOSITY_CONFIG.actionPolicy.allowExternalActions),
            externalTargetPolicy: actionPolicy.externalTargetPolicy === "explicit-allowlist" ||
                actionPolicy.externalTargetPolicy === "research-web-only"
                ? actionPolicy.externalTargetPolicy
                : DEFAULT_CURIOSITY_CONFIG.actionPolicy.externalTargetPolicy,
            disagreementFallback: actionPolicy.disagreementFallback === "defer" || actionPolicy.disagreementFallback === "ask"
                ? actionPolicy.disagreementFallback
                : DEFAULT_CURIOSITY_CONFIG.actionPolicy.disagreementFallback,
            activeHours,
            ...(activeHours === "configured-window" ? { activeWindow } : {}),
            minimumSensingSteps: integerOrDefault(actionPolicy.minimumSensingSteps, DEFAULT_CURIOSITY_CONFIG.actionPolicy.minimumSensingSteps, { min: 1 }),
            maxAttemptsPerGoal: integerOrDefault(actionPolicy.maxAttemptsPerGoal, DEFAULT_CURIOSITY_CONFIG.actionPolicy.maxAttemptsPerGoal, { min: 1 }),
            retryCooldownMinutes: numberOrDefault(actionPolicy.retryCooldownMinutes, DEFAULT_CURIOSITY_CONFIG.actionPolicy.retryCooldownMinutes, { min: 0 }),
        },
        notifications: {
            autonomousStart: {
                enabled: booleanOrDefault(autonomousStart.enabled, DEFAULT_CURIOSITY_CONFIG.notifications.autonomousStart.enabled),
                provider: autonomousStart.provider === "telegram"
                    ? "telegram"
                    : DEFAULT_CURIOSITY_CONFIG.notifications.autonomousStart.provider,
                minIntervalMinutes: numberOrDefault(autonomousStart.minIntervalMinutes, DEFAULT_CURIOSITY_CONFIG.notifications.autonomousStart.minIntervalMinutes, { min: 0 }),
                includeEvidence: booleanOrDefault(autonomousStart.includeEvidence, DEFAULT_CURIOSITY_CONFIG.notifications.autonomousStart.includeEvidence),
                ...(observatoryBaseUrl ? { observatoryBaseUrl } : {}),
                ...(autonomousStartTelegram ? { telegram: autonomousStartTelegram } : {}),
            },
        },
    };
}
export function resolveCuriosityWorkspaceDir(workspaceDir) {
    return path.join(workspaceDir, ".openclaw", "curiosity");
}
export function parseWindowDuration(raw) {
    if (!raw) {
        return 24 * 60 * 60 * 1000;
    }
    const match = raw.trim().toLowerCase().match(/^(\d+)(m|h|d)$/);
    if (!match) {
        return 24 * 60 * 60 * 1000;
    }
    const value = Number.parseInt(match[1] ?? "24", 10);
    const unit = match[2];
    if (!Number.isFinite(value) || value <= 0) {
        return 24 * 60 * 60 * 1000;
    }
    if (unit === "m") {
        return value * 60 * 1000;
    }
    if (unit === "h") {
        return value * 60 * 60 * 1000;
    }
    return value * 24 * 60 * 60 * 1000;
}
