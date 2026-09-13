export const DEFAULT_CONFIG = {
    enabled: true, agentId: "main", stage: 0,
    wakeIntervalMinutes: 480, sessionMinutes: 8,
    maxAutonomousRunsPerDay: 3, maxAutonomousTokensPerDay: 50_000,
    maxSocialActionsPerDay: 3, maxDirectConversationsPerDay: 1,
    allowPublicParticipation: true, allowDirectConversations: true,
    allowSelfModification: true, allowWebFetch: true, allowNotes: true,
    allowSearch: true, allowProjects: true,
};
export function resolveConfig(value) {
    const input = value && typeof value === "object" ? value : {};
    const number = (key, fallback, minimum = 1) => Math.max(minimum, typeof input[key] === "number" && Number.isFinite(input[key]) ? Number(input[key]) : fallback);
    const boolean = (key, fallback) => typeof input[key] === "boolean" ? input[key] : fallback;
    const configured = input.mastodon;
    let mastodon;
    if (configured) {
        const url = new URL(String(configured.baseUrl ?? ""));
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
            throw new Error("mastodon.baseUrl must be an HTTPS instance origin without credentials or a path");
        }
        const accessTokenEnv = String(configured.accessTokenEnv ?? "CURIOSITY_MASTODON_TOKEN");
        if (!/^[A-Z_][A-Z0-9_]*$/.test(accessTokenEnv))
            throw new Error("Invalid Mastodon token environment variable name");
        mastodon = { baseUrl: url.origin, accessTokenEnv };
    }
    return {
        enabled: boolean("enabled", DEFAULT_CONFIG.enabled),
        agentId: typeof input.agentId === "string" && /^[a-zA-Z0-9_-]+$/.test(input.agentId) ? input.agentId : "main",
        stage: 0,
        wakeIntervalMinutes: number("wakeIntervalMinutes", DEFAULT_CONFIG.wakeIntervalMinutes),
        sessionMinutes: number("sessionMinutes", DEFAULT_CONFIG.sessionMinutes),
        maxAutonomousRunsPerDay: Math.trunc(number("maxAutonomousRunsPerDay", DEFAULT_CONFIG.maxAutonomousRunsPerDay)),
        maxAutonomousTokensPerDay: Math.trunc(number("maxAutonomousTokensPerDay", DEFAULT_CONFIG.maxAutonomousTokensPerDay)),
        maxSocialActionsPerDay: Math.trunc(number("maxSocialActionsPerDay", DEFAULT_CONFIG.maxSocialActionsPerDay, 0)),
        maxDirectConversationsPerDay: Math.trunc(number("maxDirectConversationsPerDay", DEFAULT_CONFIG.maxDirectConversationsPerDay, 0)),
        allowPublicParticipation: boolean("allowPublicParticipation", DEFAULT_CONFIG.allowPublicParticipation),
        allowDirectConversations: boolean("allowDirectConversations", DEFAULT_CONFIG.allowDirectConversations),
        allowSelfModification: boolean("allowSelfModification", DEFAULT_CONFIG.allowSelfModification),
        allowWebFetch: boolean("allowWebFetch", DEFAULT_CONFIG.allowWebFetch),
        allowNotes: boolean("allowNotes", DEFAULT_CONFIG.allowNotes),
        allowSearch: boolean("allowSearch", DEFAULT_CONFIG.allowSearch),
        allowProjects: boolean("allowProjects", DEFAULT_CONFIG.allowProjects),
        ...(mastodon ? { mastodon } : {}),
    };
}
