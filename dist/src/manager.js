import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCuriosityWorkspaceDir } from "./config.js";
import { renderAwarenessPrompt } from "./prompt.js";
import { rankGoalsByScore, extractKeywords, scoreCandidate } from "./scoring.js";
import { sendAutonomousStartNotice } from "./notifications.js";
import { openCuriosityDatabase } from "./sqlite.js";
const POLICY_NAME = "balanced_ensemble_v1";
const IDLE_ANCHOR_META_KEY = "idle_anchor_at";
const BOREDOM_SATIATED_UNTIL_META_KEY = "boredom_satiated_until";
const LAST_BOREDOM_WAKE_META_KEY = "last_boredom_wake_requested_at";
const AUTONOMOUS_START_NOTICE_META_KEY = "autonomous_start_notice_sent_at";
const NO_SENSING_AFFORDANCE_TOKEN = "NO_SENSING_AFFORDANCE";
const SELF_AUTHORED_PROPOSED_ACTION = "Author one bounded intention from the available context, choose the topic by neutral opportunity rather than by the drive label, use available tools before narrating, produce one concrete reversible outcome or evidenced blocker, and stop.";
const SAFE_LOCAL_TOOLS = new Set([
    "read",
    "write",
    "edit",
    "process",
    "exec",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "memory_search",
    "memory_get",
    "curiosity_inspect",
]);
function clampContent(text, maxChars = 1600) {
    const normalized = text.trim().replace(/\s+/g, " ");
    if (normalized.length <= maxChars) {
        return normalized;
    }
    return `${normalized.slice(0, maxChars - 1)}…`;
}
function isHeartbeatAckText(text) {
    const normalized = text.trim();
    if (!normalized) {
        return true;
    }
    return /^HEARTBEAT_OK\b/.test(normalized) || /\bHEARTBEAT_OK$/.test(normalized);
}
function isInfrastructureFailureText(text) {
    return /(?:unknown agent id|invalid agent params|gateway closed|service restart|gateway agent request timed out|timed out after|connection refused|econnrefused|websocket|socket hang up)/i.test(text);
}
function stableFingerprint(input) {
    return [input.source, input.targetSurface.toLowerCase(), input.title.toLowerCase()]
        .map((value) => value.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
        .join("|");
}
function uniq(values) {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
function toJson(value) {
    return JSON.stringify(value ?? {});
}
function parseJsonObject(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return {};
    }
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === "object" && parsed !== null ? parsed : {};
    }
    catch {
        return {};
    }
}
function parseJsonArray(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((entry) => typeof entry === "string")
            : [];
    }
    catch {
        return [];
    }
}
function numberFromRecord(record, key) {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function parseScoreCard(value) {
    const record = parseJsonObject(value);
    const shadowRankings = parseJsonObject(record.shadow_rankings);
    return {
        rnd_novelty: numberFromRecord(record, "rnd_novelty"),
        episodic_reachability: numberFromRecord(record, "episodic_reachability"),
        plan2explore_uncertainty: numberFromRecord(record, "plan2explore_uncertainty"),
        impact_progress: numberFromRecord(record, "impact_progress"),
        llm_curriculum_reflection: numberFromRecord(record, "llm_curriculum_reflection"),
        boredom_drive: numberFromRecord(record, "boredom_drive"),
        novelty_composite: numberFromRecord(record, "novelty_composite"),
        cost_penalty: numberFromRecord(record, "cost_penalty"),
        risk_penalty: numberFromRecord(record, "risk_penalty"),
        active_ensemble: numberFromRecord(record, "active_ensemble"),
        shadow_rankings: Object.fromEntries(Object.entries(shadowRankings).filter((entry) => {
            return typeof entry[1] === "number" && Number.isFinite(entry[1]);
        })),
    };
}
function asString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function clampNumber(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}
function isResearchWebTool(toolName) {
    return /(?:web|search|fetch|browser|crawl|scrape|tavily|firecrawl|exa|duckduckgo|brave|perplexity)/i.test(toolName);
}
function parseClockMinutes(value) {
    const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
        return null;
    }
    return Number(match[1]) * 60 + Number(match[2]);
}
function getClockMinutes(now, timeZone) {
    const date = new Date(now);
    if (timeZone) {
        try {
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone,
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
            }).formatToParts(date);
            const hour = Number(parts.find((part) => part.type === "hour")?.value);
            const minute = Number(parts.find((part) => part.type === "minute")?.value);
            if (Number.isFinite(hour) && Number.isFinite(minute)) {
                return hour * 60 + minute;
            }
        }
        catch {
            // Fall through to local time if the configured time zone is not supported.
        }
    }
    return date.getHours() * 60 + date.getMinutes();
}
export function isWithinActiveWindow(config, now = Date.now()) {
    if (config.actionPolicy.activeHours !== "configured-window") {
        return true;
    }
    const window = config.actionPolicy.activeWindow;
    if (!window) {
        return true;
    }
    const start = parseClockMinutes(window.start);
    const end = parseClockMinutes(window.end);
    if (start === null || end === null || start === end) {
        return true;
    }
    const current = getClockMinutes(now, window.timeZone);
    if (start < end) {
        return current >= start && current < end;
    }
    return current >= start || current < end;
}
export class CuriosityManager {
    workspaceDir;
    curiosityDir;
    dbPath;
    logger;
    config;
    configuredSurfaceSet;
    db = null;
    constructor(params) {
        this.workspaceDir = params.workspaceDir;
        this.curiosityDir = resolveCuriosityWorkspaceDir(params.workspaceDir);
        this.dbPath = path.join(this.curiosityDir, "curiosity.db");
        this.config = params.config;
        this.configuredSurfaceSet = new Set((params.configuredSurfaces ?? [])
            .map((surface) => surface.trim().toLowerCase())
            .filter(Boolean));
        this.logger = params.logger;
    }
    updateConfig(config) {
        this.config = config;
    }
    setConfiguredSurfaces(configuredSurfaces) {
        this.configuredSurfaceSet = new Set(configuredSurfaces.map((surface) => surface.trim().toLowerCase()).filter(Boolean));
    }
    async close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
    async ensureDb() {
        if (this.db) {
            return this.db;
        }
        this.db = await openCuriosityDatabase(this.dbPath);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        goal_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        proposed_action TEXT NOT NULL,
        target_surface TEXT NOT NULL,
        scores_json TEXT NOT NULL,
        selected_by_policy TEXT NOT NULL,
        estimated_cost REAL NOT NULL,
        risk REAL NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_run_id TEXT,
        outcome_json TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        run_id TEXT,
        agent_id TEXT,
        session_key TEXT,
        channel_id TEXT,
        tool_name TEXT,
        success INTEGER,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        goal_id TEXT,
        run_id TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_usage (
        run_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        autonomous INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        success INTEGER,
        duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
        return this.db;
    }
    async pruneRetention(now = Date.now()) {
        const db = await this.ensureDb();
        const cutoff = now - this.config.logging.retentionDays * 24 * 60 * 60 * 1000;
        db.prepare(`DELETE FROM events WHERE ts < ?`).run(cutoff);
        db.prepare(`DELETE FROM observations WHERE created_at < ?`).run(cutoff);
        db.prepare(`DELETE FROM run_usage WHERE started_at < ?`).run(cutoff);
        db.prepare(`DELETE FROM goals
       WHERE updated_at < ?
         AND status IN ('completed', 'failed')`).run(cutoff);
        try {
            const files = await fs.readdir(this.curiosityDir, { withFileTypes: true });
            await Promise.all(files
                .filter((entry) => entry.isFile() && /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
                .map(async (entry) => {
                const rawDate = entry.name.slice("events-".length, "events-YYYY-MM-DD".length);
                const fileTs = Date.parse(`${rawDate}T00:00:00.000Z`);
                if (Number.isFinite(fileTs) && fileTs < cutoff) {
                    await fs.unlink(path.join(this.curiosityDir, entry.name));
                }
            }));
        }
        catch (error) {
            this.logger.warn?.(`curiosity: retention prune skipped (${String(error)})`);
        }
    }
    async appendAuditEvent(params) {
        const db = await this.ensureDb();
        const ts = params.ts ?? Date.now();
        const payload = params.payload ?? {};
        db.prepare(`INSERT INTO events (ts, event_type, goal_id, run_id, payload_json)
       VALUES (?, ?, ?, ?, ?)`).run(ts, params.eventType, params.goalId ?? null, params.runId ?? null, toJson(payload));
        await fs.mkdir(this.curiosityDir, { recursive: true });
        const date = new Date(ts).toISOString().slice(0, 10);
        const eventPath = path.join(this.curiosityDir, `events-${date}.jsonl`);
        const line = JSON.stringify({
            ts,
            eventType: params.eventType,
            goalId: params.goalId,
            runId: params.runId,
            payload,
        });
        await fs.appendFile(eventPath, `${line}\n`, "utf8");
    }
    async setPaused(paused) {
        const db = await this.ensureDb();
        db.prepare(`INSERT INTO meta (key, value) VALUES ('paused', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(paused ? "1" : "0");
        await this.appendAuditEvent({
            eventType: paused ? "paused" : "resumed",
            payload: { paused },
        });
    }
    async isPaused() {
        const db = await this.ensureDb();
        const row = db.prepare(`SELECT value FROM meta WHERE key = 'paused'`).get();
        return row?.value === "1";
    }
    readStoredIdleAnchor(db) {
        const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(IDLE_ANCHOR_META_KEY);
        const parsed = Number(row?.value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    writeIdleAnchor(db, ts) {
        db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(IDLE_ANCHOR_META_KEY, String(Math.trunc(ts)));
    }
    readNumericMeta(db, key) {
        const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
        const parsed = Number(row?.value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    writeNumericMeta(db, key, value) {
        db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(Math.trunc(value)));
    }
    observationResetsIdle(input) {
        const trigger = typeof input.metadata?.trigger === "string" ? input.metadata.trigger : "";
        if (trigger === "heartbeat" && isHeartbeatAckText(input.content ?? "")) {
            return false;
        }
        if (input.kind === "assistant_output") {
            return trigger !== "heartbeat" && !isHeartbeatAckText(input.content ?? "");
        }
        if (input.kind === "tool_success" || input.kind === "tool_failure") {
            if (input.kind === "tool_failure" && isInfrastructureFailureText(input.content ?? "")) {
                return false;
            }
            return input.toolName !== "curiosity_inspect";
        }
        if (input.kind === "message_received") {
            return true;
        }
        if (input.kind === "message_sending" || input.kind === "message_sent") {
            return trigger !== "heartbeat";
        }
        return false;
    }
    async resolveIdleAnchor(now) {
        const db = await this.ensureDb();
        const stored = this.readStoredIdleAnchor(db);
        if (stored !== null) {
            return stored;
        }
        const observationRows = db
            .prepare(`SELECT * FROM observations ORDER BY created_at DESC LIMIT 200`)
            .all();
        const runRow = db
            .prepare(`SELECT MAX(COALESCE(ended_at, started_at)) AS ts
         FROM run_usage
         WHERE autonomous = 0 AND trigger != 'heartbeat'`)
            .get();
        const meaningfulObservationTimes = observationRows
            .map((row) => this.parseObservationRow(row))
            .filter((observation) => this.observationResetsIdle({
            kind: observation.kind,
            content: observation.content,
            toolName: observation.toolName,
            metadata: observation.metadata,
            success: observation.success,
        }))
            .map((observation) => observation.createdAt);
        const candidates = [...meaningfulObservationTimes, runRow.ts].filter((ts) => typeof ts === "number" && Number.isFinite(ts) && ts > 0);
        const anchor = candidates.length > 0 ? Math.max(...candidates) : now;
        this.writeIdleAnchor(db, anchor);
        return anchor;
    }
    async markActivity(ts = Date.now()) {
        if (!Number.isFinite(ts) || ts <= 0) {
            return;
        }
        const db = await this.ensureDb();
        const stored = this.readStoredIdleAnchor(db);
        if (stored !== null && stored > ts) {
            return;
        }
        this.writeIdleAnchor(db, ts);
    }
    async getBoredomState(now = Date.now()) {
        const db = await this.ensureDb();
        const idleSince = await this.resolveIdleAnchor(now);
        const idleMs = Math.max(0, now - idleSince);
        const startsAfterMs = this.config.boredom.idleStartMinutes * 60 * 1000;
        const saturatesAfterMs = this.config.boredom.saturationMinutes * 60 * 1000;
        const growthWindowMs = Math.max(1, saturatesAfterMs - startsAfterMs);
        const rawLevel = this.config.boredom.enabled
            ? clampNumber((idleMs - startsAfterMs) / growthWindowMs)
            : 0;
        const satiatedUntil = this.readNumericMeta(db, BOREDOM_SATIATED_UNTIL_META_KEY) ?? undefined;
        const level = satiatedUntil && now < satiatedUntil ? 0 : rawLevel;
        return {
            enabled: this.config.boredom.enabled,
            idleSince,
            idleMs,
            idleMinutes: idleMs / 60_000,
            rawLevel,
            level,
            scoreBonus: level * this.config.boredom.maxScoreBonus,
            startsAfterMs,
            saturatesAfterMs,
            ...(satiatedUntil ? { satiatedUntil } : {}),
        };
    }
    async recordObservation(input) {
        const db = await this.ensureDb();
        const createdAt = input.createdAt ?? Date.now();
        const content = clampContent(input.content ?? "");
        const keywords = extractKeywords(content);
        const metadata = {
            ...(input.metadata ?? {}),
            keywords,
        };
        db.prepare(`INSERT INTO observations (
         kind, created_at, run_id, agent_id, session_key, channel_id, tool_name, success, content, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.kind, createdAt, input.runId ?? null, input.agentId ?? null, input.sessionKey ?? null, input.channelId ?? null, input.toolName ?? null, input.success == null ? null : input.success ? 1 : 0, content, toJson(metadata));
        if (this.observationResetsIdle({
            kind: input.kind,
            content,
            toolName: input.toolName,
            metadata,
            success: input.success,
        })) {
            await this.markActivity(createdAt);
        }
    }
    async recordRunUsage(input) {
        const db = await this.ensureDb();
        db.prepare(`INSERT INTO run_usage (
         run_id, agent_id, trigger, autonomous, started_at, ended_at, success, duration_ms, input_tokens, output_tokens, total_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         trigger = excluded.trigger,
         autonomous = excluded.autonomous,
         started_at = COALESCE(run_usage.started_at, excluded.started_at),
         ended_at = COALESCE(excluded.ended_at, run_usage.ended_at),
         success = COALESCE(excluded.success, run_usage.success),
         duration_ms = COALESCE(excluded.duration_ms, run_usage.duration_ms),
         input_tokens = COALESCE(excluded.input_tokens, run_usage.input_tokens),
         output_tokens = COALESCE(excluded.output_tokens, run_usage.output_tokens),
         total_tokens = COALESCE(excluded.total_tokens, run_usage.total_tokens)`).run(input.runId, input.agentId, input.trigger, input.autonomous ? 1 : 0, input.startedAt ?? Date.now(), input.endedAt ?? null, input.success == null ? null : input.success ? 1 : 0, input.durationMs ?? null, input.inputTokens ?? null, input.outputTokens ?? null, input.totalTokens ?? null);
        if (!input.autonomous && input.trigger !== "heartbeat") {
            await this.markActivity(input.endedAt ?? input.startedAt ?? Date.now());
        }
    }
    async getBudgetUsage(now = Date.now()) {
        const db = await this.ensureDb();
        const since24h = now - 24 * 60 * 60 * 1000;
        const since1h = now - 60 * 60 * 1000;
        const runsRow = db
            .prepare(`SELECT COUNT(*) AS count FROM events WHERE event_type = 'goal_selected' AND ts >= ?`)
            .get(since24h);
        const tokensRow = db
            .prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS total
         FROM run_usage
         WHERE autonomous = 1 AND started_at >= ?`)
            .get(since24h);
        const external24hRow = db
            .prepare(`SELECT COUNT(*) AS count FROM events WHERE event_type = 'external_action' AND ts >= ?`)
            .get(since24h);
        const external1hRow = db
            .prepare(`SELECT COUNT(*) AS count FROM events WHERE event_type = 'external_action' AND ts >= ?`)
            .get(since1h);
        return {
            autonomousRuns24h: runsRow.count ?? 0,
            autonomousTokens24h: tokensRow.total ?? 0,
            externalActions24h: external24hRow.count ?? 0,
            externalActions1h: external1hRow.count ?? 0,
        };
    }
    async shouldRequestBoredomWake(now = Date.now()) {
        const [paused, budgetUsage, boredom] = await Promise.all([
            this.isPaused(),
            this.getBudgetUsage(now),
            this.getBoredomState(now),
        ]);
        if (paused) {
            return { shouldWake: false, reason: "paused", boredom, budgetUsage };
        }
        if (!isWithinActiveWindow(this.config, now)) {
            return { shouldWake: false, reason: "outside_active_hours", boredom, budgetUsage };
        }
        if (budgetUsage.autonomousRuns24h >= this.config.budgets.autonomousRunsPerDay ||
            budgetUsage.autonomousTokens24h >= this.config.budgets.autonomousTokensPerDay) {
            return { shouldWake: false, reason: "budget_exhausted", boredom, budgetUsage };
        }
        if (!this.config.boredom.enabled || boredom.level < this.config.boredom.wakeLevel) {
            return { shouldWake: false, reason: "boredom_below_wake_level", boredom, budgetUsage };
        }
        const db = await this.ensureDb();
        const lastWake = this.readNumericMeta(db, LAST_BOREDOM_WAKE_META_KEY);
        const minIntervalMs = this.config.boredom.wakeMinIntervalMinutes * 60 * 1000;
        if (lastWake !== null && now - lastWake < minIntervalMs) {
            return { shouldWake: false, reason: "wake_interval_active", boredom, budgetUsage };
        }
        return { shouldWake: true, reason: "boredom_ready", boredom, budgetUsage };
    }
    async markBoredomWakeRequested(params) {
        const now = params.now ?? Date.now();
        const db = await this.ensureDb();
        this.writeNumericMeta(db, LAST_BOREDOM_WAKE_META_KEY, now);
        await this.appendAuditEvent({
            ts: now,
            eventType: "boredom_wake_requested",
            payload: {
                runReason: params.runReason,
                agentId: params.agentId,
                sessionKey: params.sessionKey,
                boredom: params.boredom,
            },
        });
    }
    async getGoalIdForRun(runId) {
        const db = await this.ensureDb();
        const row = db
            .prepare(`SELECT goal_id FROM goals WHERE last_run_id = ? LIMIT 1`)
            .get(runId);
        return asString(row?.goal_id);
    }
    async markRunGoalInProgress(runId) {
        const goalId = await this.getGoalIdForRun(runId);
        if (!goalId) {
            return;
        }
        const db = await this.ensureDb();
        db.prepare(`UPDATE goals
       SET status = CASE WHEN status = 'selected' THEN 'in_progress' ELSE status END,
           updated_at = ?
       WHERE goal_id = ?`).run(Date.now(), goalId);
    }
    isSurfaceAllowed(surface) {
        const normalized = surface.trim().toLowerCase();
        if (!normalized) {
            return true;
        }
        if (!this.config.actionPolicy.allowExternalActions) {
            return false;
        }
        if (this.config.actionPolicy.externalTargetPolicy === "any-configured-surface") {
            return this.configuredSurfaceSet.size === 0 || this.configuredSurfaceSet.has(normalized);
        }
        if (this.config.actionPolicy.externalTargetPolicy === "research-web-only") {
            return normalized === "web" || normalized === "browser" || normalized === "search";
        }
        return this.configuredSurfaceSet.has(normalized);
    }
    async canUseTool(runId, toolName) {
        const goalId = await this.getGoalIdForRun(runId);
        const usage = await this.getBudgetUsage();
        if (usage.autonomousTokens24h >= this.config.budgets.autonomousTokensPerDay) {
            return { allowed: false, reason: "autonomous token budget exhausted", goalId };
        }
        const normalizedToolName = toolName.trim().toLowerCase();
        const safeLocalTool = SAFE_LOCAL_TOOLS.has(normalizedToolName);
        if (!safeLocalTool) {
            if (!this.config.actionPolicy.allowExternalActions) {
                return { allowed: false, reason: "external actions are disabled by policy", goalId };
            }
            if (this.config.actionPolicy.externalTargetPolicy === "research-web-only" &&
                !isResearchWebTool(toolName)) {
                return { allowed: false, reason: "policy only allows research-web tools", goalId };
            }
            if (usage.externalActions24h >= this.config.budgets.externalActionsPerDay) {
                return { allowed: false, reason: "external action budget exhausted for the last 24h", goalId };
            }
            if (usage.externalActions1h >= this.config.budgets.externalActionsPerHour) {
                return { allowed: false, reason: "external action hourly budget exhausted", goalId };
            }
        }
        await this.markRunGoalInProgress(runId);
        await this.appendAuditEvent({
            eventType: safeLocalTool ? "tool_allowed" : "external_action",
            goalId,
            runId,
            payload: {
                toolName,
                safeLocalTool,
            },
        });
        return { allowed: true, goalId };
    }
    async canSendMessage(runId, surface, to) {
        const goalId = await this.getGoalIdForRun(runId);
        const usage = await this.getBudgetUsage();
        if (!this.config.actionPolicy.allowExternalActions) {
            return { allowed: false, reason: "external actions are disabled by policy", goalId };
        }
        if (!this.isSurfaceAllowed(surface)) {
            return {
                allowed: false,
                reason: `surface "${surface}" is outside the configured curiosity policy`,
                goalId,
            };
        }
        if (usage.externalActions24h >= this.config.budgets.externalActionsPerDay) {
            return { allowed: false, reason: "external action budget exhausted for the last 24h", goalId };
        }
        if (usage.externalActions1h >= this.config.budgets.externalActionsPerHour) {
            return { allowed: false, reason: "external action hourly budget exhausted", goalId };
        }
        await this.markRunGoalInProgress(runId);
        await this.appendAuditEvent({
            eventType: "external_action",
            goalId,
            runId,
            payload: {
                target: to,
                surface,
            },
        });
        return { allowed: true, goalId };
    }
    parseGoalRow(row) {
        return {
            goalId: String(row.goal_id),
            fingerprint: String(row.fingerprint),
            agentId: String(row.agent_id),
            createdAt: Number(row.created_at),
            source: row.source,
            title: String(row.title),
            evidence: parseJsonArray(row.evidence_json),
            proposedAction: String(row.proposed_action),
            targetSurface: String(row.target_surface),
            scoresByModel: parseScoreCard(row.scores_json),
            selectedByPolicy: String(row.selected_by_policy),
            estimatedCost: Number(row.estimated_cost),
            risk: Number(row.risk),
            status: row.status,
            attempts: Number(row.attempts),
            lastRunId: asString(row.last_run_id),
            outcome: parseJsonObject(row.outcome_json),
            updatedAt: Number(row.updated_at),
        };
    }
    parseObservationRow(row) {
        return {
            id: Number(row.id),
            kind: row.kind,
            createdAt: Number(row.created_at),
            runId: asString(row.run_id),
            agentId: asString(row.agent_id),
            sessionKey: asString(row.session_key),
            channelId: asString(row.channel_id),
            toolName: asString(row.tool_name),
            success: typeof row.success === "number"
                ? Number(row.success) === 1
                : typeof row.success === "boolean"
                    ? row.success
                    : undefined,
            content: String(row.content ?? ""),
            metadata: parseJsonObject(row.metadata_json),
        };
    }
    async listGoalsByStatus(statuses, limit = 20) {
        const db = await this.ensureDb();
        if (statuses.length === 0) {
            return [];
        }
        const placeholders = statuses.map(() => "?").join(", ");
        const rows = db
            .prepare(`SELECT * FROM goals WHERE status IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`)
            .all(...statuses, limit);
        return rows.map((row) => this.parseGoalRow(row));
    }
    async listRecentCompletedGoals(limit = 10) {
        return this.listGoalsByStatus(["completed", "failed"], limit);
    }
    async markGoalInProgress(params) {
        const db = await this.ensureDb();
        const now = params.now ?? Date.now();
        if (params.agentId) {
            db.prepare(`UPDATE goals SET status = ?, agent_id = ?, last_run_id = ?, updated_at = ? WHERE goal_id = ?`).run("in_progress", params.agentId, params.runId, now, params.goalId);
        }
        else {
            db.prepare(`UPDATE goals SET status = ?, last_run_id = ?, updated_at = ? WHERE goal_id = ?`).run("in_progress", params.runId, now, params.goalId);
        }
        await this.appendAuditEvent({
            ts: now,
            eventType: "goal_in_progress",
            goalId: params.goalId,
            runId: params.runId,
            payload: {
                agentId: params.agentId,
            },
        });
    }
    async listRecentObservations(limit = 100) {
        const db = await this.ensureDb();
        const rows = db
            .prepare(`SELECT * FROM observations ORDER BY created_at DESC LIMIT ?`)
            .all(limit);
        return rows.map((row) => this.parseObservationRow(row));
    }
    configuredSurfaces() {
        return [...this.configuredSurfaceSet];
    }
    isCandidateAllowedByDrive(candidate, boredom) {
        if (candidate.source === "unresolved_user_ask") {
            return true;
        }
        return boredom.level >= this.config.boredom.wakeLevel;
    }
    goalRetryBlocked(goal, now) {
        if (goal.source === "unresolved_user_ask") {
            return null;
        }
        if (goal.attempts >= this.config.actionPolicy.maxAttemptsPerGoal) {
            return "max_attempts_reached";
        }
        const retryCooldownMs = this.config.actionPolicy.retryCooldownMinutes * 60 * 1000;
        if (goal.attempts > 0 && retryCooldownMs > 0 && now - goal.updatedAt < retryCooldownMs) {
            return "retry_cooldown_active";
        }
        return null;
    }
    buildLowCoverageCandidates(observations) {
        const candidates = [];
        const recentChannels = new Set(observations
            .map((observation) => observation.channelId?.trim().toLowerCase())
            .filter((value) => Boolean(value)));
        for (const surface of this.configuredSurfaces()) {
            const seenCount = observations.filter((observation) => observation.channelId?.trim().toLowerCase() === surface).length;
            if (seenCount <= 1 || !recentChannels.has(surface)) {
                candidates.push({
                    source: "low_coverage_surface",
                    title: `Self-author on underexplored surface: ${surface}`,
                    evidence: [
                        recentChannels.has(surface)
                            ? `Only ${seenCount} recent observation(s) mention ${surface}.`
                            : `Configured surface "${surface}" has not been explored recently.`,
                    ],
                    proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
                    targetSurface: surface,
                    estimatedCost: 320,
                    risk: 0.24,
                    keywords: extractKeywords(surface),
                    metadata: {
                        surface,
                        seenCount,
                    },
                });
            }
        }
        return candidates;
    }
    buildBootstrapCandidates(params) {
        if (!this.config.goalSources.bootstrapExploration) {
            return [];
        }
        if (params.boredom.level < this.config.boredom.wakeLevel ||
            params.observations.length > 0 ||
            params.openGoals.length > 0 ||
            params.recentCompleted.length > 0) {
            return [];
        }
        return [
            {
                source: "self_authored_intention",
                title: "Self-authored curiosity from an empty state",
                evidence: [
                    "No recent observations, open goals, or prior curiosity outcomes exist for this workspace.",
                    `Boredom level is ${params.boredom.level.toFixed(2)} after ${Math.round(params.boredom.idleMinutes * 10) / 10} idle minutes.`,
                ],
                proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
                targetSurface: "workspace",
                estimatedCost: 220,
                risk: 0.04,
                keywords: extractKeywords("self authored empty state curiosity drive"),
                metadata: {
                    emptyState: true,
                    externalActionsAllowed: false,
                },
            },
        ];
    }
    async buildCandidates(params) {
        const now = Date.now();
        const candidates = [];
        const toolNames = params.observations
            .map((observation) => observation.toolName)
            .filter((toolName) => Boolean(toolName));
        candidates.push(...this.buildBootstrapCandidates({
            observations: params.observations,
            openGoals: params.openGoals,
            recentCompleted: params.recentCompleted,
            boredom: params.boredom,
        }));
        if (this.config.boredom.enabled && params.boredom.level >= this.config.boredom.wakeLevel) {
            const idleMinutes = Math.round(params.boredom.idleMinutes * 10) / 10;
            candidates.push({
                source: "self_authored_intention",
                title: "Use idle time for one concrete autonomous outcome",
                evidence: [
                    `No meaningful external activity has been observed since ${new Date(params.boredom.idleSince).toISOString()}.`,
                    `Boredom level is ${params.boredom.level.toFixed(2)} after ${idleMinutes} idle minutes.`,
                ],
                proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
                targetSurface: "workspace",
                estimatedCost: 160,
                risk: 0.06,
                keywords: extractKeywords("self authored boredom drive curiosity"),
                metadata: {
                    idleSince: params.boredom.idleSince,
                    idleMs: params.boredom.idleMs,
                    boredomLevel: params.boredom.level,
                    scoreBonus: params.boredom.scoreBonus,
                },
            });
        }
        if (this.config.goalSources.unresolvedUserAsks) {
            for (const observation of params.observations.filter((item) => item.kind === "message_received").slice(0, 10)) {
                if (!/[?]/.test(observation.content) && !/^(please|can you|could you|check|look|find|review|investigate)/i.test(observation.content)) {
                    continue;
                }
                const title = `Resolve user ask: ${clampContent(observation.content, 90)}`;
                candidates.push({
                    source: "unresolved_user_ask",
                    title,
                    evidence: [observation.content],
                    proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
                    targetSurface: observation.channelId ?? "workspace",
                    estimatedCost: 350,
                    risk: 0.15,
                    keywords: extractKeywords(observation.content),
                    metadata: {
                        observationId: observation.id,
                        channelId: observation.channelId,
                    },
                });
            }
        }
        if (this.config.goalSources.staleOpenQuestions) {
            const staleCutoff = now - this.config.thresholds.staleGoalHours * 60 * 60 * 1000;
            for (const goal of params.openGoals.filter((goal) => goal.updatedAt < staleCutoff).slice(0, 5)) {
                candidates.push({
                    source: "stale_open_question",
                    title: `Re-evaluate stale goal: ${goal.title}`,
                    evidence: goal.evidence,
                    proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
                    targetSurface: goal.targetSurface,
                    estimatedCost: 220,
                    risk: 0.2,
                    keywords: uniq([...extractKeywords(goal.title), ...goal.evidence.flatMap((entry) => extractKeywords(entry))]),
                    metadata: {
                        priorGoalId: goal.goalId,
                    },
                });
            }
        }
        if (this.config.goalSources.failedToolAttempts) {
            for (const observation of params.observations
                .filter((item) => item.kind === "tool_failure")
                .filter((item) => !isInfrastructureFailureText(item.content))
                .slice(0, 4)) {
                const toolName = observation.toolName ?? "tool";
                candidates.push({
                    source: "failed_tool_attempt",
                    title: `Recover from failed ${toolName} attempt`,
                    evidence: [observation.content || `Recent ${toolName} call failed.`],
                    proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
                    targetSurface: toolName,
                    estimatedCost: 400,
                    risk: 0.28,
                    keywords: extractKeywords(`${toolName} ${observation.content}`),
                    metadata: {
                        toolName,
                        observationId: observation.id,
                    },
                });
            }
        }
        if (this.config.goalSources.newlyDiscoveredEntities) {
            const keywordFrequency = new Map();
            const entityObservations = params.observations
                .filter((observation) => observation.kind === "message_received")
                .slice(0, 40);
            for (const observation of entityObservations) {
                const keywords = Array.isArray(observation.metadata.keywords) &&
                    observation.metadata.keywords.every((value) => typeof value === "string")
                    ? observation.metadata.keywords
                    : extractKeywords(observation.content);
                for (const keyword of keywords) {
                    keywordFrequency.set(keyword, (keywordFrequency.get(keyword) ?? 0) + 1);
                }
            }
            for (const [keyword, frequency] of [...keywordFrequency.entries()].filter(([, count]) => count === 1).slice(0, 5)) {
                candidates.push({
                    source: "new_entity",
                    title: `Attend to newly surfaced topic: ${keyword}`,
                    evidence: [`Topic "${keyword}" appeared recently but has not been explored yet.`],
                    proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
                    targetSurface: "web",
                    estimatedCost: 280,
                    risk: 0.12,
                    keywords: [keyword],
                    metadata: {
                        keyword,
                    },
                });
            }
        }
        if (this.config.goalSources.skillOpportunities) {
            const repeatedTools = new Map();
            for (const toolName of toolNames) {
                repeatedTools.set(toolName, (repeatedTools.get(toolName) ?? 0) + 1);
            }
            for (const [toolName, count] of [...repeatedTools.entries()].filter(([, count]) => count >= 2).slice(0, 4)) {
                candidates.push({
                    source: "skill_opportunity",
                    title: `Capture a reusable workflow for ${toolName}`,
                    evidence: [`${toolName} appeared ${count} times in recent activity.`],
                    proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
                    targetSurface: "workspace",
                    estimatedCost: 180,
                    risk: 0.1,
                    keywords: extractKeywords(`${toolName} workflow pattern memory`),
                    metadata: {
                        toolName,
                        count,
                    },
                });
            }
        }
        if (this.config.goalSources.externalFollowUps) {
            for (const goal of params.recentCompleted.slice(0, 4)) {
                if (goal.targetSurface === "workspace") {
                    continue;
                }
                candidates.push({
                    source: "external_follow_up",
                    title: `Follow up on autonomous goal: ${goal.title}`,
                    evidence: goal.evidence,
                    proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
                    targetSurface: goal.targetSurface,
                    estimatedCost: 260,
                    risk: 0.22,
                    keywords: extractKeywords(goal.title),
                    metadata: {
                        priorGoalId: goal.goalId,
                    },
                });
            }
        }
        if (this.config.goalSources.lowCoverageSurfaces) {
            candidates.push(...this.buildLowCoverageCandidates(params.observations).slice(0, 4));
        }
        const deduped = new Map();
        for (const candidate of candidates.filter((candidate) => this.isCandidateAllowedByDrive(candidate, params.boredom))) {
            const fingerprint = stableFingerprint({
                source: candidate.source,
                title: candidate.title,
                targetSurface: candidate.targetSurface,
            });
            if (!deduped.has(fingerprint)) {
                deduped.set(fingerprint, candidate);
            }
        }
        return [...deduped.values()];
    }
    async upsertGoal(params) {
        const db = await this.ensureDb();
        const fingerprint = stableFingerprint({
            source: params.candidate.source,
            title: params.candidate.title,
            targetSurface: params.candidate.targetSurface,
        });
        const existing = db
            .prepare(`SELECT * FROM goals WHERE fingerprint = ? LIMIT 1`)
            .get(fingerprint);
        if (existing) {
            const current = this.parseGoalRow(existing);
            const evidence = uniq([...current.evidence, ...params.candidate.evidence]).slice(0, 6);
            const nextStatus = current.status === "completed" || current.status === "failed" ? "queued" : current.status;
            db.prepare(`UPDATE goals
         SET title = ?, evidence_json = ?, proposed_action = ?, target_surface = ?, scores_json = ?,
             selected_by_policy = ?, estimated_cost = ?, risk = ?, status = ?, updated_at = ?
         WHERE goal_id = ?`).run(params.candidate.title, toJson(evidence), params.candidate.proposedAction, params.candidate.targetSurface, toJson(params.scoreCard), current.selectedByPolicy || POLICY_NAME, params.candidate.estimatedCost, params.candidate.risk, nextStatus, params.now, current.goalId);
            const refreshed = db
                .prepare(`SELECT * FROM goals WHERE goal_id = ? LIMIT 1`)
                .get(current.goalId);
            return this.parseGoalRow(refreshed);
        }
        const goalId = randomUUID();
        db.prepare(`INSERT INTO goals (
         goal_id, fingerprint, agent_id, created_at, source, title, evidence_json,
         proposed_action, target_surface, scores_json, selected_by_policy,
         estimated_cost, risk, status, attempts, last_run_id, outcome_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(goalId, fingerprint, params.agentId, params.now, params.candidate.source, params.candidate.title, toJson(params.candidate.evidence), params.candidate.proposedAction, params.candidate.targetSurface, toJson(params.scoreCard), POLICY_NAME, params.candidate.estimatedCost, params.candidate.risk, "queued", 0, null, null, params.now);
        const inserted = db
            .prepare(`SELECT * FROM goals WHERE goal_id = ? LIMIT 1`)
            .get(goalId);
        return this.parseGoalRow(inserted);
    }
    async selectGoalForRun(params) {
        const now = Date.now();
        await this.pruneRetention(now);
        const budgetUsage = await this.getBudgetUsage(now);
        if (await this.isPaused()) {
            await this.appendAuditEvent({
                eventType: "selection_skipped",
                runId: params.runId,
                payload: { reason: "paused" },
            });
            return { selected: false, reason: "paused", budgetUsage, candidateCount: 0 };
        }
        if (!isWithinActiveWindow(this.config, now)) {
            await this.appendAuditEvent({
                eventType: "selection_skipped",
                runId: params.runId,
                payload: {
                    reason: "outside_active_hours",
                    activeWindow: this.config.actionPolicy.activeWindow,
                },
            });
            return { selected: false, reason: "outside_active_hours", budgetUsage, candidateCount: 0 };
        }
        if (budgetUsage.autonomousRuns24h >= this.config.budgets.autonomousRunsPerDay ||
            budgetUsage.autonomousTokens24h >= this.config.budgets.autonomousTokensPerDay) {
            await this.appendAuditEvent({
                eventType: "selection_skipped",
                runId: params.runId,
                payload: { reason: "budget_exhausted", budgetUsage },
            });
            return { selected: false, reason: "budget_exhausted", budgetUsage, candidateCount: 0 };
        }
        const boredom = await this.getBoredomState(now);
        const recentObservationCutoff = now - this.config.thresholds.recentObservationWindowHours * 60 * 60 * 1000;
        const observations = (await this.listRecentObservations(200)).filter((observation) => observation.createdAt >= recentObservationCutoff);
        const openGoals = await this.listGoalsByStatus(["queued", "selected", "in_progress"], 30);
        const recentCompleted = await this.listRecentCompletedGoals(12);
        const candidates = await this.buildCandidates({
            agentId: params.agentId,
            observations,
            openGoals,
            recentCompleted,
            boredom,
        });
        if (candidates.length === 0) {
            await this.appendAuditEvent({
                eventType: "selection_skipped",
                runId: params.runId,
                payload: { reason: "no_candidates", boredom },
            });
            return { selected: false, reason: "no_candidates", budgetUsage, candidateCount: 0 };
        }
        const recentToolNames = observations
            .map((observation) => observation.toolName)
            .filter((toolName) => Boolean(toolName));
        const scoredGoals = [];
        for (const candidate of candidates) {
            const scoreCard = scoreCandidate(candidate, { observations, openGoals, recentToolNames, boredomDrive: boredom.level }, this.config);
            const goal = await this.upsertGoal({
                candidate,
                scoreCard,
                agentId: params.agentId,
                now,
            });
            scoredGoals.push(goal);
            await this.appendAuditEvent({
                eventType: "goal_scored",
                goalId: goal.goalId,
                runId: params.runId,
                payload: {
                    title: goal.title,
                    source: goal.source,
                    scores: goal.scoresByModel,
                    boredom,
                },
            });
        }
        const ranked = rankGoalsByScore(scoredGoals);
        const blockedGoals = [];
        const selected = ranked.find((goal) => {
            if (goal.scoresByModel.active_ensemble < this.config.thresholds.act) {
                return false;
            }
            const blockedReason = this.goalRetryBlocked(goal, now);
            if (blockedReason) {
                blockedGoals.push({ goalId: goal.goalId, title: goal.title, reason: blockedReason });
                return false;
            }
            return true;
        });
        if (!selected) {
            await this.appendAuditEvent({
                eventType: "selection_skipped",
                runId: params.runId,
                payload: {
                    reason: blockedGoals.length > 0 ? "retry_blocked" : "below_threshold",
                    candidateCount: candidates.length,
                    boredom,
                    blockedGoals,
                },
            });
            return {
                selected: false,
                reason: "below_threshold",
                budgetUsage,
                candidateCount: candidates.length,
            };
        }
        const db = await this.ensureDb();
        db.prepare(`UPDATE goals
       SET status = ?, attempts = attempts + 1, last_run_id = ?, selected_by_policy = ?, updated_at = ?
       WHERE goal_id = ?`).run("selected", params.runId, POLICY_NAME, now, selected.goalId);
        await this.recordRunUsage({
            runId: params.runId,
            agentId: params.agentId,
            trigger: params.trigger,
            autonomous: true,
            startedAt: now,
        });
        await this.appendAuditEvent({
            eventType: "goal_selected",
            goalId: selected.goalId,
            runId: params.runId,
            payload: {
                title: selected.title,
                threshold: this.config.thresholds.act,
                scores: selected.scoresByModel,
                boredom,
            },
        });
        const refreshed = db
            .prepare(`SELECT * FROM goals WHERE goal_id = ? LIMIT 1`)
            .get(selected.goalId);
        return {
            selected: true,
            goal: this.parseGoalRow(refreshed),
            budgetUsage,
            candidateCount: candidates.length,
        };
    }
    async finalizeAutonomousRun(params) {
        const db = await this.ensureDb();
        const sensingSteps = this.countAutonomousSensingSteps(db, params.runId);
        const metMinimumAction = sensingSteps >= this.config.actionPolicy.minimumSensingSteps ||
            this.autonomousRunReportedNoSensingAffordance(db, params.runId);
        const success = params.success && metMinimumAction;
        const status = success ? "completed" : "failed";
        const now = Date.now();
        const satiatedUntil = now + this.config.boredom.satiationMinutes * 60 * 1000;
        if (this.config.boredom.satiationMinutes > 0) {
            this.writeNumericMeta(db, BOREDOM_SATIATED_UNTIL_META_KEY, satiatedUntil);
        }
        const outcome = {
            success,
            error: metMinimumAction
                ? params.error
                : `autonomous curiosity ended before taking ${this.config.actionPolicy.minimumSensingSteps} qualifying tool-backed step(s) or declaring no safe tool affordance`,
            durationMs: params.durationMs,
            minimumActionSatisfied: metMinimumAction,
            sensingSteps,
            requiredSensingSteps: this.config.actionPolicy.minimumSensingSteps,
            finishedAt: now,
            ...(this.config.boredom.satiationMinutes > 0 ? { satiatedUntil } : {}),
        };
        db.prepare(`UPDATE goals SET status = ?, outcome_json = ?, updated_at = ? WHERE goal_id = ?`).run(status, toJson(outcome), now, params.goalId);
        await this.recordRunUsage({
            runId: params.runId,
            agentId: params.agentId,
            trigger: params.trigger,
            autonomous: true,
            endedAt: now,
            success,
            durationMs: params.durationMs,
        });
        await this.appendAuditEvent({
            eventType: success ? "goal_completed" : "goal_failed",
            goalId: params.goalId,
            runId: params.runId,
            payload: outcome,
        });
    }
    countAutonomousSensingSteps(db, runId) {
        const eventRows = db
            .prepare(`SELECT event_type, payload_json
         FROM events
         WHERE run_id = ? AND event_type IN ('tool_allowed', 'external_action')`)
            .all(runId);
        return eventRows.filter((row) => {
            if (row.event_type === "external_action") {
                return true;
            }
            const payload = parseJsonObject(row.payload_json);
            const toolName = String(payload.toolName ?? "").trim().toLowerCase();
            return row.event_type === "tool_allowed" && toolName !== "curiosity_inspect";
        }).length;
    }
    autonomousRunReportedNoSensingAffordance(db, runId) {
        const assistantRows = db
            .prepare(`SELECT content
         FROM observations
         WHERE run_id = ? AND kind = 'assistant_output'
         ORDER BY created_at DESC LIMIT 5`)
            .all(runId);
        return assistantRows.some((row) => String(row.content ?? "").includes(NO_SENSING_AFFORDANCE_TOKEN));
    }
    async notifyAutonomousStart(params) {
        const db = await this.ensureDb();
        const now = params.now ?? Date.now();
        const result = await sendAutonomousStartNotice({
            config: this.config.notifications.autonomousStart,
            goal: params.goal,
            agentId: params.agentId,
            runId: params.runId,
            workspaceDir: this.workspaceDir,
            now,
            lastSentAt: this.readNumericMeta(db, AUTONOMOUS_START_NOTICE_META_KEY),
            fetchFn: params.fetchFn,
            logger: this.logger,
        });
        if (result.sent) {
            this.writeNumericMeta(db, AUTONOMOUS_START_NOTICE_META_KEY, now);
        }
        await this.appendAuditEvent({
            ts: now,
            eventType: result.sent ? "autonomous_start_notification_sent" : "autonomous_start_notification_skipped",
            goalId: params.goal.goalId,
            runId: params.runId,
            payload: result,
        });
        return result;
    }
    async updateRunTokens(params) {
        await this.recordRunUsage({
            runId: params.runId,
            agentId: params.agentId,
            trigger: params.trigger,
            autonomous: Boolean(params.goalId),
            inputTokens: params.inputTokens,
            outputTokens: params.outputTokens,
            totalTokens: params.totalTokens,
        });
        await this.appendAuditEvent({
            eventType: "llm_usage",
            goalId: params.goalId,
            runId: params.runId,
            payload: {
                inputTokens: params.inputTokens,
                outputTokens: params.outputTokens,
                totalTokens: params.totalTokens,
            },
        });
    }
    async queueSnapshot(limit = 20) {
        const [paused, budgetUsage, boredom, goals] = await Promise.all([
            this.isPaused(),
            this.getBudgetUsage(),
            this.getBoredomState(),
            this.listGoalsByStatus(["queued", "selected", "in_progress", "completed", "failed"], limit),
        ]);
        return { paused, budgetUsage, boredom, goals };
    }
    async inspectIdentifier(identifier) {
        const db = await this.ensureDb();
        const goalRow = db
            .prepare(`SELECT * FROM goals WHERE goal_id = ? OR last_run_id = ? LIMIT 1`)
            .get(identifier, identifier);
        const goalId = asString(goalRow?.goal_id) ?? "";
        const runRow = db
            .prepare(`SELECT * FROM run_usage WHERE run_id = ? LIMIT 1`)
            .get(identifier);
        const events = db
            .prepare(`SELECT * FROM events WHERE goal_id = ? OR run_id = ? ORDER BY ts DESC LIMIT 50`)
            .all(goalId, identifier);
        return {
            goal: goalRow ? this.parseGoalRow(goalRow) : null,
            runUsage: runRow
                ? {
                    runId: runRow.run_id,
                    agentId: runRow.agent_id,
                    trigger: runRow.trigger,
                    autonomous: Number(runRow.autonomous) === 1,
                    startedAt: runRow.started_at,
                    endedAt: runRow.ended_at,
                    success: runRow.success,
                    durationMs: runRow.duration_ms,
                    inputTokens: runRow.input_tokens,
                    outputTokens: runRow.output_tokens,
                    totalTokens: runRow.total_tokens,
                }
                : null,
            events: events.map((event) => ({
                ts: event.ts,
                eventType: event.event_type,
                goalId: event.goal_id,
                runId: event.run_id,
                payload: parseJsonObject(event.payload_json),
            })),
        };
    }
    async compareWindow(windowMs) {
        const db = await this.ensureDb();
        const since = Date.now() - windowMs;
        const goals = db
            .prepare(`SELECT * FROM goals WHERE created_at >= ? ORDER BY created_at DESC`)
            .all(since).map((row) => this.parseGoalRow(row));
        const events = db
            .prepare(`SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC`)
            .all(since);
        const observations = db
            .prepare(`SELECT * FROM observations WHERE created_at >= ? ORDER BY created_at DESC`)
            .all(since).map((row) => this.parseObservationRow(row));
        const runUsageRows = db
            .prepare(`SELECT * FROM run_usage WHERE started_at >= ?`)
            .all(since);
        const selectedCount = events.filter((event) => event.event_type === "goal_selected").length;
        const externalAttempts = events.filter((event) => event.event_type === "external_action").length;
        const externalSuccess = observations.filter((observation) => observation.kind === "message_sent" && observation.success === true).length;
        const completedGoals = goals.filter((goal) => goal.status === "completed");
        const failedGoals = goals.filter((goal) => goal.status === "failed");
        const scoreKeys = [
            "rnd_novelty",
            "episodic_reachability",
            "plan2explore_uncertainty",
            "impact_progress",
            "llm_curriculum_reflection",
            "boredom_drive",
            "novelty_composite",
            "cost_penalty",
            "risk_penalty",
            "active_ensemble",
        ];
        const averageScores = {};
        for (const key of scoreKeys) {
            averageScores[key] =
                goals.length === 0
                    ? 0
                    : goals.reduce((sum, goal) => sum + Number(goal.scoresByModel[key] ?? 0), 0) /
                        goals.length;
        }
        const autonomousRuns = runUsageRows.filter((row) => Number(row.autonomous) === 1);
        const interventionSignals = autonomousRuns.filter((run) => observations.some((observation) => {
            return (observation.kind === "message_received" &&
                observation.createdAt >= Number(run.ended_at ?? run.started_at) &&
                observation.createdAt <= Number(run.ended_at ?? run.started_at) + 30 * 60 * 1000);
        })).length;
        return {
            windowMs,
            candidateCount: goals.length,
            selectedCount,
            completedCount: completedGoals.length,
            failedCount: failedGoals.length,
            selectionRate: goals.length === 0 ? 0 : selectedCount / goals.length,
            realizedNovelty: completedGoals.length === 0
                ? 0
                : completedGoals.reduce((sum, goal) => sum + goal.scoresByModel.novelty_composite, 0) /
                    completedGoals.length,
            uncertaintyReduced: completedGoals.length === 0
                ? 0
                : completedGoals.reduce((sum, goal) => sum + goal.scoresByModel.plan2explore_uncertainty, 0) / completedGoals.length,
            progressRealized: selectedCount === 0 ? 0 : completedGoals.length / selectedCount,
            externalActionSuccess: externalAttempts === 0 ? 0 : externalSuccess / externalAttempts,
            reversalsFailures: failedGoals.length,
            humanInterventionRate: autonomousRuns.length === 0 ? 0 : interventionSignals / autonomousRuns.length,
            totalTokens: runUsageRows.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0),
            averageScores,
        };
    }
    async buildAwarenessContext() {
        const [activeGoals, recentFindings] = await Promise.all([
            this.listGoalsByStatus(["queued", "selected", "in_progress"], 5),
            this.listRecentCompletedGoals(5),
        ]);
        return renderAwarenessPrompt({ activeGoals, recentFindings });
    }
}
