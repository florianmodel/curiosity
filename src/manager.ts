import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveCuriosityWorkspaceDir } from "./config.js";
import { renderAwarenessPrompt } from "./prompt.js";
import { rankGoalsByScore, extractKeywords, scoreCandidate } from "./scoring.js";
import { sendAutonomousResultNotice, sendAutonomousStartNotice } from "./notifications.js";
import { openCuriosityDatabase } from "./sqlite.js";
import type {
  BudgetUsage,
  AuditEventRecord,
  BoredomState,
  CandidateGoal,
  CompareSnapshot,
  GoalRecord,
  GoalSelectionDecision,
  GoalSource,
  GoalStatus,
  ObservationKind,
  ObservationRecord,
  ObservatoryRunDetail,
  ObservatorySnapshot,
  QueueSnapshot,
  RunUsageRecord,
  ScoreCard,
  CuriosityConfig,
} from "./types.js";

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type RecordObservationInput = {
  kind: ObservationKind;
  createdAt?: number;
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  channelId?: string;
  toolName?: string;
  success?: boolean;
  content?: string;
  metadata?: Record<string, unknown>;
};

type RecordRunUsageInput = {
  runId: string;
  agentId: string;
  trigger: string;
  autonomous: boolean;
  startedAt?: number;
  endedAt?: number;
  success?: boolean;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

type ToolRunResolution = {
  goalId?: string;
  runId: string;
  originalRunId: string;
  correlated: boolean;
};

type GoalCandidateRow = CandidateGoal & {
  scoresByModel: ScoreCard;
};

const POLICY_NAME = "balanced_ensemble_v1";
const IDLE_ANCHOR_META_KEY = "idle_anchor_at";
const BOREDOM_SATIATED_UNTIL_META_KEY = "boredom_satiated_until";
const LAST_BOREDOM_WAKE_META_KEY = "last_boredom_wake_requested_at";
const AUTONOMOUS_START_NOTICE_META_KEY = "autonomous_start_notice_sent_at";
const NO_SENSING_AFFORDANCE_TOKEN = "NO_SENSING_AFFORDANCE";
const SELF_AUTHORED_PROPOSED_ACTION =
  "Author one bounded intention from the available context, choose the topic by neutral opportunity rather than by the drive label, use available tools before narrating, produce one concrete reversible outcome or evidenced blocker, and stop.";
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

function clampContent(text: string, maxChars = 1600): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function safePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "unknown";
}

function isHeartbeatAckText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }
  return /^HEARTBEAT_OK\b/.test(normalized) || /\bHEARTBEAT_OK$/.test(normalized);
}

function isInfrastructureFailureText(text: string): boolean {
  return /(?:unknown agent id|invalid agent params|gateway closed|service restart|gateway agent request timed out|timed out after|connection refused|econnrefused|websocket|socket hang up)/i.test(
    text,
  );
}

function stableFingerprint(input: {
  source: GoalSource;
  title: string;
  targetSurface: string;
}): string {
  return [input.source, input.targetSurface.toLowerCase(), input.title.toLowerCase()]
    .map((value) => value.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .join("|");
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function numberFromRecord(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseScoreCard(value: unknown): ScoreCard {
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
    shadow_rankings: Object.fromEntries(
      Object.entries(shadowRankings).filter((entry): entry is [string, number] => {
        return typeof entry[1] === "number" && Number.isFinite(entry[1]);
      }),
    ),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function clampNumber(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function isResearchWebTool(toolName: string): boolean {
  return /(?:web|search|fetch|browser|crawl|scrape|tavily|firecrawl|exa|duckduckgo|brave|perplexity)/i.test(
    toolName,
  );
}

function parseClockMinutes(value: string): number | null {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function getClockMinutes(now: number, timeZone: string | undefined): number {
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
    } catch {
      // Fall through to local time if the configured time zone is not supported.
    }
  }
  return date.getHours() * 60 + date.getMinutes();
}

export function isWithinActiveWindow(config: CuriosityConfig, now = Date.now()): boolean {
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
  readonly workspaceDir: string;
  readonly curiosityDir: string;
  readonly dbPath: string;
  readonly logger: LoggerLike;
  private config: CuriosityConfig;
  private configuredSurfaceSet: Set<string>;
  private db: DatabaseSync | null = null;

  constructor(params: {
    workspaceDir: string;
    config: CuriosityConfig;
    configuredSurfaces?: string[];
    logger: LoggerLike;
  }) {
    this.workspaceDir = params.workspaceDir;
    this.curiosityDir = resolveCuriosityWorkspaceDir(params.workspaceDir);
    this.dbPath = path.join(this.curiosityDir, "curiosity.db");
    this.config = params.config;
    this.configuredSurfaceSet = new Set(
      (params.configuredSurfaces ?? [])
        .map((surface) => surface.trim().toLowerCase())
        .filter(Boolean),
    );
    this.logger = params.logger;
  }

  updateConfig(config: CuriosityConfig) {
    this.config = config;
  }

  setConfiguredSurfaces(configuredSurfaces: string[]) {
    this.configuredSurfaceSet = new Set(
      configuredSurfaces.map((surface) => surface.trim().toLowerCase()).filter(Boolean),
    );
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private async ensureDb(): Promise<DatabaseSync> {
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
    db.prepare(
      `DELETE FROM goals
       WHERE updated_at < ?
         AND status IN ('completed', 'failed')`,
    ).run(cutoff);

    try {
      const files = await fs.readdir(this.curiosityDir, { withFileTypes: true });
      await Promise.all(
        files
          .filter((entry) => entry.isFile() && /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
          .map(async (entry) => {
            const rawDate = entry.name.slice("events-".length, "events-YYYY-MM-DD".length);
            const fileTs = Date.parse(`${rawDate}T00:00:00.000Z`);
            if (Number.isFinite(fileTs) && fileTs < cutoff) {
              await fs.unlink(path.join(this.curiosityDir, entry.name));
            }
          }),
      );
    } catch (error) {
      this.logger.warn?.(`curiosity: retention prune skipped (${String(error)})`);
    }
    await this.pruneStorageBudget();
  }

  private async pruneStorageBudget() {
    const maxBytes = this.config.logging.maxStorageBytes;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      return;
    }
    const size = await this.directorySize(this.curiosityDir);
    if (size <= maxBytes) {
      return;
    }

    const candidates = await this.listPrunableFiles(this.curiosityDir);
    let currentSize = size;
    for (const candidate of candidates) {
      if (currentSize <= maxBytes) {
        break;
      }
      try {
        await fs.rm(candidate.path, { force: true });
        currentSize -= candidate.size;
      } catch {
        // Best-effort retention pruning should never interrupt the curiosity loop.
      }
    }
  }

  private async directorySize(dir: string): Promise<number> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          total += await this.directorySize(fullPath);
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          total += stat.size;
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  private async listPrunableFiles(dir: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await this.listPrunableFiles(fullPath)));
          continue;
        }
        if (!entry.isFile() || entry.name === "curiosity.db") {
          continue;
        }
        const stat = await fs.stat(fullPath);
        files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    } catch {
      return [];
    }
  }

  private async appendAuditEvent(params: {
    ts?: number;
    eventType: string;
    goalId?: string;
    runId?: string;
    payload?: Record<string, unknown>;
  }) {
    const db = await this.ensureDb();
    const ts = params.ts ?? Date.now();
    const payload = params.payload ?? {};
    db.prepare(
      `INSERT INTO events (ts, event_type, goal_id, run_id, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(ts, params.eventType, params.goalId ?? null, params.runId ?? null, toJson(payload));

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

  async setPaused(paused: boolean) {
    const db = await this.ensureDb();
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('paused', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(paused ? "1" : "0");
    await this.appendAuditEvent({
      eventType: paused ? "paused" : "resumed",
      payload: { paused },
    });
  }

  async isPaused(): Promise<boolean> {
    const db = await this.ensureDb();
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'paused'`).get() as
      | { value?: string }
      | undefined;
    return row?.value === "1";
  }

  private readStoredIdleAnchor(db: DatabaseSync): number | null {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(IDLE_ANCHOR_META_KEY) as
      | { value?: string }
      | undefined;
    const parsed = Number(row?.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private writeIdleAnchor(db: DatabaseSync, ts: number) {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(IDLE_ANCHOR_META_KEY, String(Math.trunc(ts)));
  }

  private readNumericMeta(db: DatabaseSync, key: string): number | null {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined;
    const parsed = Number(row?.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private writeNumericMeta(db: DatabaseSync, key: string, value: number) {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, String(Math.trunc(value)));
  }

  private observationResetsIdle(input: {
    kind: ObservationKind;
    content?: string;
    toolName?: string;
    metadata?: Record<string, unknown>;
    success?: boolean;
  }): boolean {
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

  private async resolveIdleAnchor(now: number): Promise<number> {
    const db = await this.ensureDb();
    const stored = this.readStoredIdleAnchor(db);
    if (stored !== null) {
      return stored;
    }

    const observationRows = db
      .prepare(`SELECT * FROM observations ORDER BY created_at DESC LIMIT 200`)
      .all() as Record<string, unknown>[];
    const runRow = db
      .prepare(
        `SELECT MAX(COALESCE(ended_at, started_at)) AS ts
         FROM run_usage
         WHERE autonomous = 0 AND trigger != 'heartbeat'`,
      )
      .get() as { ts?: number | null };
    const meaningfulObservationTimes = observationRows
      .map((row) => this.parseObservationRow(row))
      .filter((observation) =>
        this.observationResetsIdle({
          kind: observation.kind,
          content: observation.content,
          toolName: observation.toolName,
          metadata: observation.metadata,
          success: observation.success,
        }),
      )
      .map((observation) => observation.createdAt);
    const candidates = [...meaningfulObservationTimes, runRow.ts].filter(
      (ts): ts is number => typeof ts === "number" && Number.isFinite(ts) && ts > 0,
    );
    const anchor = candidates.length > 0 ? Math.max(...candidates) : now;
    this.writeIdleAnchor(db, anchor);
    return anchor;
  }

  private async markActivity(ts = Date.now()) {
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

  async getBoredomState(now = Date.now()): Promise<BoredomState> {
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

  private async writeRawObservationContent(input: {
    kind: ObservationKind;
    createdAt: number;
    runId?: string;
    content: string;
  }): Promise<Record<string, unknown>> {
    if (input.content.length === 0) {
      return {};
    }
    const date = new Date(input.createdAt).toISOString().slice(0, 10);
    const runSegment = safePathSegment(input.runId ?? "unscoped");
    const rawDir = path.join(this.curiosityDir, "raw", date, runSegment);
    const filename = `${input.createdAt}-${safePathSegment(input.kind)}-${randomUUID()}.txt`;
    const rawPath = path.join(rawDir, filename);
    try {
      await fs.mkdir(rawDir, { recursive: true });
      await fs.writeFile(rawPath, input.content, "utf8");
    } catch (error) {
      this.logger.warn?.(`curiosity: raw observation write skipped (${String(error)})`);
      return {};
    }
    return {
      rawContentPath: rawPath,
      rawContentRelativePath: path.relative(this.curiosityDir, rawPath),
      rawContentChars: input.content.length,
    };
  }

  async recordObservation(input: RecordObservationInput) {
    const db = await this.ensureDb();
    const createdAt = input.createdAt ?? Date.now();
    const rawContent = input.content ?? "";
    const rawMetadata = await this.writeRawObservationContent({
      kind: input.kind,
      createdAt,
      runId: input.runId,
      content: rawContent,
    });
    const content = clampContent(rawContent);
    const keywords = extractKeywords(content);
    const metadata = {
      ...(input.metadata ?? {}),
      ...rawMetadata,
      keywords,
    };
    db.prepare(
      `INSERT INTO observations (
         kind, created_at, run_id, agent_id, session_key, channel_id, tool_name, success, content, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.kind,
      createdAt,
      input.runId ?? null,
      input.agentId ?? null,
      input.sessionKey ?? null,
      input.channelId ?? null,
      input.toolName ?? null,
      input.success == null ? null : input.success ? 1 : 0,
      content,
      toJson(metadata),
    );
    if (
      this.observationResetsIdle({
        kind: input.kind,
        content,
        toolName: input.toolName,
        metadata,
        success: input.success,
      })
    ) {
      await this.markActivity(createdAt);
    }
  }

  async recordRunUsage(input: RecordRunUsageInput) {
    const db = await this.ensureDb();
    db.prepare(
      `INSERT INTO run_usage (
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
         total_tokens = COALESCE(excluded.total_tokens, run_usage.total_tokens)`,
    ).run(
      input.runId,
      input.agentId,
      input.trigger,
      input.autonomous ? 1 : 0,
      input.startedAt ?? Date.now(),
      input.endedAt ?? null,
      input.success == null ? null : input.success ? 1 : 0,
      input.durationMs ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.totalTokens ?? null,
    );
    if (!input.autonomous && input.trigger !== "heartbeat") {
      await this.markActivity(input.endedAt ?? input.startedAt ?? Date.now());
    }
  }

  async getBudgetUsage(now = Date.now()): Promise<BudgetUsage> {
    const db = await this.ensureDb();
    const since24h = now - 24 * 60 * 60 * 1000;
    const since1h = now - 60 * 60 * 1000;

    const runsRow = db
      .prepare(
        `SELECT COUNT(*) AS count FROM events WHERE event_type = 'goal_selected' AND ts >= ?`,
      )
      .get(since24h) as { count?: number };
    const tokensRow = db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens), 0) AS total
         FROM run_usage
         WHERE autonomous = 1 AND started_at >= ?`,
      )
      .get(since24h) as { total?: number };
    const external24hRow = db
      .prepare(
        `SELECT COUNT(*) AS count FROM events WHERE event_type = 'external_action' AND ts >= ?`,
      )
      .get(since24h) as { count?: number };
    const external1hRow = db
      .prepare(
        `SELECT COUNT(*) AS count FROM events WHERE event_type = 'external_action' AND ts >= ?`,
      )
      .get(since1h) as { count?: number };

    return {
      autonomousRuns24h: runsRow.count ?? 0,
      autonomousTokens24h: tokensRow.total ?? 0,
      externalActions24h: external24hRow.count ?? 0,
      externalActions1h: external1hRow.count ?? 0,
    };
  }

  async shouldRequestBoredomWake(now = Date.now()): Promise<{
    shouldWake: boolean;
    reason: string;
    boredom: BoredomState;
    budgetUsage: BudgetUsage;
  }> {
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
    if (
      budgetUsage.autonomousRuns24h >= this.config.budgets.autonomousRunsPerDay ||
      budgetUsage.autonomousTokens24h >= this.config.budgets.autonomousTokensPerDay
    ) {
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

  async markBoredomWakeRequested(params: {
    runReason: string;
    agentId?: string;
    sessionKey?: string;
    now?: number;
    boredom: BoredomState;
  }) {
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

  private async getGoalIdForRun(runId: string): Promise<string | undefined> {
    const db = await this.ensureDb();
    const row = db
      .prepare(`SELECT goal_id FROM goals WHERE last_run_id = ? LIMIT 1`)
      .get(runId) as { goal_id?: string } | undefined;
    return asString(row?.goal_id);
  }

  async findGoalByRunId(runId: string): Promise<GoalRecord | null> {
    const db = await this.ensureDb();
    const row = db
      .prepare(`SELECT * FROM goals WHERE last_run_id = ? LIMIT 1`)
      .get(runId) as Record<string, unknown> | undefined;
    return row ? this.parseGoalRow(row) : null;
  }

  async findActiveGoalForAgent(
    agentId?: string,
    maxAgeMs = 2 * 60 * 60 * 1000,
  ): Promise<GoalRecord | null> {
    const db = await this.ensureDb();
    const normalizedAgentId = agentId?.trim();
    const cutoff = Date.now() - maxAgeMs;
    const row = normalizedAgentId
      ? (db
          .prepare(
            `SELECT * FROM goals
             WHERE status IN ('selected', 'in_progress') AND agent_id = ? AND updated_at >= ?
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(normalizedAgentId, cutoff) as Record<string, unknown> | undefined)
      : (db
          .prepare(
            `SELECT * FROM goals
             WHERE status IN ('selected', 'in_progress') AND updated_at >= ?
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(cutoff) as Record<string, unknown> | undefined);
    return row ? this.parseGoalRow(row) : null;
  }

  async resolveRunForAutonomousEvent(params: {
    runId?: string;
    agentId?: string;
  }): Promise<ToolRunResolution | null> {
    const originalRunId = params.runId?.trim();
    if (originalRunId) {
      const goal = await this.findGoalByRunId(originalRunId);
      if (goal) {
        return {
          goalId: goal.goalId,
          runId: originalRunId,
          originalRunId,
          correlated: false,
        };
      }
    }

    const activeGoal = await this.findActiveGoalForAgent(params.agentId);
    const correlatedRunId = activeGoal?.lastRunId;
    if (!activeGoal || !correlatedRunId) {
      return null;
    }
    return {
      goalId: activeGoal.goalId,
      runId: correlatedRunId,
      originalRunId: originalRunId ?? correlatedRunId,
      correlated: originalRunId !== correlatedRunId,
    };
  }

  private async markRunGoalInProgress(runId: string) {
    const goalId = await this.getGoalIdForRun(runId);
    if (!goalId) {
      return;
    }
    const db = await this.ensureDb();
    db.prepare(
      `UPDATE goals
       SET status = CASE WHEN status = 'selected' THEN 'in_progress' ELSE status END,
           updated_at = ?
       WHERE goal_id = ?`,
    ).run(Date.now(), goalId);
  }

  private isSurfaceAllowed(surface: string): boolean {
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

  async canUseTool(
    runId: string,
    toolName: string,
    options: { agentId?: string } = {},
  ): Promise<{ allowed: boolean; reason?: string; goalId?: string }> {
    const resolvedRun = await this.resolveRunForAutonomousEvent({
      runId,
      agentId: options.agentId,
    });
    const goalId = resolvedRun?.goalId;
    const eventRunId = resolvedRun?.runId ?? runId;
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
      if (
        this.config.actionPolicy.externalTargetPolicy === "research-web-only" &&
        !isResearchWebTool(toolName)
      ) {
        return { allowed: false, reason: "policy only allows research-web tools", goalId };
      }
      if (usage.externalActions24h >= this.config.budgets.externalActionsPerDay) {
        return { allowed: false, reason: "external action budget exhausted for the last 24h", goalId };
      }
      if (usage.externalActions1h >= this.config.budgets.externalActionsPerHour) {
        return { allowed: false, reason: "external action hourly budget exhausted", goalId };
      }
    }

    await this.markRunGoalInProgress(eventRunId);
    await this.appendAuditEvent({
      eventType: safeLocalTool ? "tool_allowed" : "external_action",
      goalId,
      runId: eventRunId,
      payload: {
        toolName,
        safeLocalTool,
        originalRunId: resolvedRun?.correlated ? resolvedRun.originalRunId : undefined,
        correlatedRunId: resolvedRun?.correlated ? eventRunId : undefined,
      },
    });
    return { allowed: true, goalId };
  }

  async recordObservedToolCalls(params: {
    runId: string;
    agentId?: string;
    toolNames: string[];
    callCount?: number;
    source: string;
  }): Promise<{ recorded: number; runId: string; goalId?: string }> {
    const resolvedRun = await this.resolveRunForAutonomousEvent({
      runId: params.runId,
      agentId: params.agentId,
    });
    const eventRunId = resolvedRun?.runId ?? params.runId;
    const goalId = resolvedRun?.goalId ?? (await this.getGoalIdForRun(eventRunId));
    const normalizedToolNames = uniq(
      params.toolNames
        .map((toolName) => toolName.trim())
        .filter(Boolean)
        .map((toolName) => toolName.replace(/^openclaw_/, "")),
    );
    const callCount = Math.max(
      normalizedToolNames.length,
      Number.isFinite(params.callCount ?? NaN) ? Math.trunc(params.callCount ?? 0) : 0,
    );
    if (callCount <= 0 || normalizedToolNames.length === 0) {
      return { recorded: 0, runId: eventRunId, goalId };
    }

    await this.markRunGoalInProgress(eventRunId);
    let recorded = 0;
    for (let index = 0; index < callCount; index += 1) {
      const toolName =
        normalizedToolNames[index] ?? normalizedToolNames[normalizedToolNames.length - 1];
      if (!toolName) {
        continue;
      }
      const normalizedToolName = toolName.trim().toLowerCase();
      const safeLocalTool = SAFE_LOCAL_TOOLS.has(normalizedToolName);
      await this.appendAuditEvent({
        eventType: safeLocalTool ? "tool_allowed" : "external_action",
        goalId,
        runId: eventRunId,
        payload: {
          toolName,
          safeLocalTool,
          observed: true,
          source: params.source,
          originalRunId: resolvedRun?.correlated ? resolvedRun.originalRunId : undefined,
          correlatedRunId: resolvedRun?.correlated ? eventRunId : undefined,
        },
      });
      recorded += 1;
    }
    return { recorded, runId: eventRunId, goalId };
  }

  async canSendMessage(
    runId: string,
    surface: string,
    to: string,
    options: { agentId?: string } = {},
  ): Promise<{ allowed: boolean; reason?: string; goalId?: string }> {
    const resolvedRun = await this.resolveRunForAutonomousEvent({
      runId,
      agentId: options.agentId,
    });
    const goalId = resolvedRun?.goalId;
    const eventRunId = resolvedRun?.runId ?? runId;
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
    await this.markRunGoalInProgress(eventRunId);
    await this.appendAuditEvent({
      eventType: "external_action",
      goalId,
      runId: eventRunId,
      payload: {
        target: to,
        surface,
        originalRunId: resolvedRun?.correlated ? resolvedRun.originalRunId : undefined,
        correlatedRunId: resolvedRun?.correlated ? eventRunId : undefined,
      },
    });
    return { allowed: true, goalId };
  }

  private parseGoalRow(row: Record<string, unknown>): GoalRecord {
    return {
      goalId: String(row.goal_id),
      fingerprint: String(row.fingerprint),
      agentId: String(row.agent_id),
      createdAt: Number(row.created_at),
      source: row.source as GoalSource,
      title: String(row.title),
      evidence: parseJsonArray(row.evidence_json),
      proposedAction: String(row.proposed_action),
      targetSurface: String(row.target_surface),
      scoresByModel: parseScoreCard(row.scores_json),
      selectedByPolicy: String(row.selected_by_policy),
      estimatedCost: Number(row.estimated_cost),
      risk: Number(row.risk),
      status: row.status as GoalStatus,
      attempts: Number(row.attempts),
      lastRunId: asString(row.last_run_id),
      outcome: parseJsonObject(row.outcome_json),
      updatedAt: Number(row.updated_at),
    };
  }

  private parseObservationRow(row: Record<string, unknown>): ObservationRecord {
    return {
      id: Number(row.id),
      kind: row.kind as ObservationKind,
      createdAt: Number(row.created_at),
      runId: asString(row.run_id),
      agentId: asString(row.agent_id),
      sessionKey: asString(row.session_key),
      channelId: asString(row.channel_id),
      toolName: asString(row.tool_name),
      success:
        typeof row.success === "number"
          ? Number(row.success) === 1
          : typeof row.success === "boolean"
            ? row.success
            : undefined,
      content: String(row.content ?? ""),
      metadata: parseJsonObject(row.metadata_json),
    };
  }

  private parseRunUsageRow(row: Record<string, unknown>): RunUsageRecord {
    return {
      runId: String(row.run_id),
      agentId: String(row.agent_id),
      trigger: String(row.trigger),
      autonomous: Number(row.autonomous) === 1,
      startedAt: Number(row.started_at),
      endedAt: typeof row.ended_at === "number" ? Number(row.ended_at) : undefined,
      success:
        typeof row.success === "number"
          ? Number(row.success) === 1
          : typeof row.success === "boolean"
            ? row.success
            : undefined,
      durationMs: typeof row.duration_ms === "number" ? Number(row.duration_ms) : undefined,
      inputTokens: typeof row.input_tokens === "number" ? Number(row.input_tokens) : undefined,
      outputTokens: typeof row.output_tokens === "number" ? Number(row.output_tokens) : undefined,
      totalTokens: typeof row.total_tokens === "number" ? Number(row.total_tokens) : undefined,
    };
  }

  private parseEventRow(row: Record<string, unknown>): AuditEventRecord {
    return {
      id: typeof row.id === "number" ? Number(row.id) : undefined,
      ts: Number(row.ts),
      eventType: String(row.event_type),
      goalId: asString(row.goal_id),
      runId: asString(row.run_id),
      payload: parseJsonObject(row.payload_json),
    };
  }

  async listGoalsByStatus(statuses: GoalStatus[], limit = 20): Promise<GoalRecord[]> {
    const db = await this.ensureDb();
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT * FROM goals WHERE status IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...statuses, limit) as Record<string, unknown>[];
    return rows.map((row) => this.parseGoalRow(row));
  }

  async listRecentCompletedGoals(limit = 10): Promise<GoalRecord[]> {
    return this.listGoalsByStatus(["completed", "failed"], limit);
  }

  async listRecentRunUsage(limit = 20): Promise<RunUsageRecord[]> {
    const db = await this.ensureDb();
    const rows = db
      .prepare(`SELECT * FROM run_usage ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.parseRunUsageRow(row));
  }

  async listRecentEvents(limit = 100): Promise<AuditEventRecord[]> {
    const db = await this.ensureDb();
    const rows = db
      .prepare(`SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.parseEventRow(row));
  }

  async listRecentObservations(limit = 100): Promise<ObservationRecord[]> {
    const db = await this.ensureDb();
    const rows = db
      .prepare(`SELECT * FROM observations ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.parseObservationRow(row));
  }

  async markGoalInProgress(params: { goalId: string; runId: string; agentId?: string; now?: number }) {
    const db = await this.ensureDb();
    const now = params.now ?? Date.now();
    if (params.agentId) {
      db.prepare(
        `UPDATE goals SET status = ?, agent_id = ?, last_run_id = ?, updated_at = ? WHERE goal_id = ?`,
      ).run("in_progress", params.agentId, params.runId, now, params.goalId);
    } else {
      db.prepare(
        `UPDATE goals SET status = ?, last_run_id = ?, updated_at = ? WHERE goal_id = ?`,
      ).run("in_progress", params.runId, now, params.goalId);
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

  private configuredSurfaces(): string[] {
    return [...this.configuredSurfaceSet];
  }

  private isCandidateAllowedByDrive(candidate: CandidateGoal, boredom: BoredomState): boolean {
    if (candidate.source === "unresolved_user_ask") {
      return true;
    }
    return boredom.level >= this.config.boredom.wakeLevel;
  }

  private goalRetryBlocked(goal: GoalRecord, now: number): string | null {
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

  private buildLowCoverageCandidates(observations: ObservationRecord[]): CandidateGoal[] {
    const candidates: CandidateGoal[] = [];
    const recentChannels = new Set(
      observations
        .map((observation) => observation.channelId?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value)),
    );
    for (const surface of this.configuredSurfaces()) {
      const seenCount = observations.filter(
        (observation) => observation.channelId?.trim().toLowerCase() === surface,
      ).length;
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

  private buildBootstrapCandidates(params: {
    observations: ObservationRecord[];
    openGoals: GoalRecord[];
    recentCompleted: GoalRecord[];
    boredom: BoredomState;
  }): CandidateGoal[] {
    if (!this.config.goalSources.bootstrapExploration) {
      return [];
    }
    if (
      params.boredom.level < this.config.boredom.wakeLevel ||
      params.observations.length > 0 ||
      params.openGoals.length > 0 ||
      params.recentCompleted.length > 0
    ) {
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

  private async buildCandidates(params: {
    agentId: string;
    observations: ObservationRecord[];
    openGoals: GoalRecord[];
    recentCompleted: GoalRecord[];
    boredom: BoredomState;
    force?: boolean;
    forcedSurface?: string;
  }): Promise<CandidateGoal[]> {
    const now = Date.now();
    const candidates: CandidateGoal[] = [];
    const toolNames = params.observations
      .map((observation) => observation.toolName)
      .filter((toolName): toolName is string => Boolean(toolName));

    candidates.push(
      ...this.buildBootstrapCandidates({
        observations: params.observations,
        openGoals: params.openGoals,
        recentCompleted: params.recentCompleted,
        boredom: params.boredom,
      }),
    );

    if (this.config.boredom.enabled && params.boredom.level >= this.config.boredom.wakeLevel) {
      const idleMinutes = Math.round(params.boredom.idleMinutes * 10) / 10;
      const targetSurface = this.config.actionPolicy.allowExternalActions ? "web" : "workspace";
      candidates.push({
        source: "self_authored_intention",
        title:
          targetSurface === "web"
            ? "Use idle time for one concrete web exploration"
            : "Use idle time for one concrete autonomous outcome",
        evidence: [
          `No meaningful external activity has been observed since ${new Date(params.boredom.idleSince).toISOString()}.`,
          `Boredom level is ${params.boredom.level.toFixed(2)} after ${idleMinutes} idle minutes.`,
          targetSurface === "web"
            ? "External actions are allowed, so the first autonomous attempt should look outside the local workspace."
            : "External actions are disabled, so the run is limited to local workspace affordances.",
        ],
        proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
        targetSurface,
        estimatedCost: targetSurface === "web" ? 320 : 160,
        risk: targetSurface === "web" ? 0.1 : 0.06,
        keywords: extractKeywords(
          targetSurface === "web"
            ? "self authored boredom drive curiosity web research external"
            : "self authored boredom drive curiosity",
        ),
        metadata: {
          idleSince: params.boredom.idleSince,
          idleMs: params.boredom.idleMs,
          boredomLevel: params.boredom.level,
          scoreBonus: params.boredom.scoreBonus,
          targetSurface,
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
      const keywordFrequency = new Map<string, number>();
      const entityObservations = params.observations
        .filter((observation) => observation.kind === "message_received")
        .slice(0, 40);
      for (const observation of entityObservations) {
        const keywords =
          Array.isArray(observation.metadata.keywords) &&
          observation.metadata.keywords.every((value) => typeof value === "string")
            ? (observation.metadata.keywords as string[])
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
      const repeatedTools = new Map<string, number>();
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
        if (goal.status !== "completed" || goal.outcome?.success !== true) {
          continue;
        }
        if (
          goal.source === "external_follow_up" ||
          /^Follow up on autonomous goal:/i.test(goal.title)
        ) {
          continue;
        }
        if (goal.targetSurface === "workspace") {
          continue;
        }
        if (goal.outcome?.minimumActionSatisfied === false || goal.evidence.length === 0) {
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

    const deduped = new Map<string, CandidateGoal>();
    const driveAllowedCandidates = candidates.filter((candidate) =>
      params.force === true || this.isCandidateAllowedByDrive(candidate, params.boredom),
    );
    const forcedSurface = params.forcedSurface?.trim().toLowerCase();
    if (params.force === true && forcedSurface) {
      driveAllowedCandidates.unshift({
        source: "self_authored_intention",
        title:
          forcedSurface === "web" || forcedSurface === "search" || forcedSurface === "browser"
            ? "Manual forced web exploration"
            : `Manual forced curiosity run on ${forcedSurface}`,
        evidence: [
          `A manual curiosity run was forced from the CLI for target surface "${forcedSurface}".`,
          "This bypasses drive maturity for smoke testing and should still satisfy the normal tool-backed action requirement.",
        ],
        proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
        targetSurface: forcedSurface,
        estimatedCost:
          forcedSurface === "web" || forcedSurface === "search" || forcedSurface === "browser"
            ? 320
            : 160,
        risk:
          forcedSurface === "web" || forcedSurface === "search" || forcedSurface === "browser"
            ? 0.1
            : 0.06,
        keywords: extractKeywords(`manual forced curiosity ${forcedSurface} exploration`),
        metadata: {
          forced: true,
          forcedSurface,
        },
      });
    }

    if (params.force === true && driveAllowedCandidates.length === 0) {
      driveAllowedCandidates.push({
        source: "self_authored_intention",
        title: "Manual self-authored curiosity run",
        evidence: [
          "A manual curiosity run was forced from the CLI.",
          "No other candidate source produced an eligible goal, so the agent must author one bounded intention from available local context.",
        ],
        proposedAction: SELF_AUTHORED_PROPOSED_ACTION,
        targetSurface: "workspace",
        estimatedCost: 160,
        risk: 0.06,
        keywords: extractKeywords("manual self authored curiosity workspace"),
        metadata: {
          forced: true,
        },
      });
    }

    for (const candidate of driveAllowedCandidates) {
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

  private async upsertGoal(params: {
    candidate: CandidateGoal;
    scoreCard: ScoreCard;
    agentId: string;
    now: number;
  }): Promise<GoalRecord> {
    const db = await this.ensureDb();
    const fingerprint = stableFingerprint({
      source: params.candidate.source,
      title: params.candidate.title,
      targetSurface: params.candidate.targetSurface,
    });
    const existing = db
      .prepare(`SELECT * FROM goals WHERE fingerprint = ? LIMIT 1`)
      .get(fingerprint) as Record<string, unknown> | undefined;

    if (existing) {
      const current = this.parseGoalRow(existing);
      const evidence = uniq([...current.evidence, ...params.candidate.evidence]).slice(0, 6);
      const nextStatus: GoalStatus =
        current.status === "completed" || current.status === "failed" ? "queued" : current.status;
      db.prepare(
        `UPDATE goals
         SET title = ?, evidence_json = ?, proposed_action = ?, target_surface = ?, scores_json = ?,
             selected_by_policy = ?, estimated_cost = ?, risk = ?, status = ?, updated_at = ?
         WHERE goal_id = ?`,
      ).run(
        params.candidate.title,
        toJson(evidence),
        params.candidate.proposedAction,
        params.candidate.targetSurface,
        toJson(params.scoreCard),
        current.selectedByPolicy || POLICY_NAME,
        params.candidate.estimatedCost,
        params.candidate.risk,
        nextStatus,
        params.now,
        current.goalId,
      );
      const refreshed = db
        .prepare(`SELECT * FROM goals WHERE goal_id = ? LIMIT 1`)
        .get(current.goalId) as Record<string, unknown>;
      return this.parseGoalRow(refreshed);
    }

    const goalId = randomUUID();
    db.prepare(
      `INSERT INTO goals (
         goal_id, fingerprint, agent_id, created_at, source, title, evidence_json,
         proposed_action, target_surface, scores_json, selected_by_policy,
         estimated_cost, risk, status, attempts, last_run_id, outcome_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      goalId,
      fingerprint,
      params.agentId,
      params.now,
      params.candidate.source,
      params.candidate.title,
      toJson(params.candidate.evidence),
      params.candidate.proposedAction,
      params.candidate.targetSurface,
      toJson(params.scoreCard),
      POLICY_NAME,
      params.candidate.estimatedCost,
      params.candidate.risk,
      "queued",
      0,
      null,
      null,
      params.now,
    );
    const inserted = db
      .prepare(`SELECT * FROM goals WHERE goal_id = ? LIMIT 1`)
      .get(goalId) as Record<string, unknown>;
    return this.parseGoalRow(inserted);
  }

  async selectGoalForRun(params: {
    agentId: string;
    runId: string;
    trigger: string;
    ignoreRetryBlocks?: boolean;
    forceSelect?: boolean;
    forcedSurface?: string;
  }): Promise<GoalSelectionDecision> {
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
    if (
      budgetUsage.autonomousRuns24h >= this.config.budgets.autonomousRunsPerDay ||
      budgetUsage.autonomousTokens24h >= this.config.budgets.autonomousTokensPerDay
    ) {
      await this.appendAuditEvent({
        eventType: "selection_skipped",
        runId: params.runId,
        payload: { reason: "budget_exhausted", budgetUsage },
      });
      return { selected: false, reason: "budget_exhausted", budgetUsage, candidateCount: 0 };
    }

    const boredom = await this.getBoredomState(now);
    const recentObservationCutoff =
      now - this.config.thresholds.recentObservationWindowHours * 60 * 60 * 1000;
    const observations = (await this.listRecentObservations(200)).filter(
      (observation) => observation.createdAt >= recentObservationCutoff,
    );
    const openGoals = await this.listGoalsByStatus(["queued", "selected", "in_progress"], 30);
    const recentCompleted = await this.listRecentCompletedGoals(12);
    const candidates = await this.buildCandidates({
      agentId: params.agentId,
      observations,
      openGoals,
      recentCompleted,
      boredom,
      force: params.ignoreRetryBlocks === true,
      forcedSurface: params.forceSelect === true ? params.forcedSurface : undefined,
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
      .filter((toolName): toolName is string => Boolean(toolName));
    const scoredGoals: GoalRecord[] = [];
    for (const candidate of candidates) {
      const scoreCard = scoreCandidate(
        candidate,
        { observations, openGoals, recentToolNames, boredomDrive: boredom.level },
        this.config,
      );
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
    const forcedSurface = params.forcedSurface?.trim().toLowerCase();
    const forcedSurfaceMatches =
      params.forceSelect === true
        ? ranked.filter((goal) => {
            return !forcedSurface || goal.targetSurface.trim().toLowerCase() === forcedSurface;
          })
        : [];
    const forcedSelection =
      forcedSurfaceMatches.find((goal) => /^Manual forced/i.test(goal.title)) ??
      forcedSurfaceMatches[0];
    const blockedGoals: Array<{ goalId: string; title: string; reason: string }> = [];
    const selected = forcedSelection ?? ranked.find((goal) => {
      if (goal.scoresByModel.active_ensemble < this.config.thresholds.act) {
        return false;
      }
      const blockedReason = this.goalRetryBlocked(goal, now);
      if (blockedReason) {
        blockedGoals.push({ goalId: goal.goalId, title: goal.title, reason: blockedReason });
        return params.ignoreRetryBlocks === true;
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
        reason: blockedGoals.length > 0 ? "retry_blocked" : "below_threshold",
        budgetUsage,
        candidateCount: candidates.length,
      };
    }

    const db = await this.ensureDb();
    db.prepare(
      `UPDATE goals
       SET status = ?, attempts = attempts + 1, last_run_id = ?, selected_by_policy = ?, updated_at = ?
       WHERE goal_id = ?`,
    ).run("selected", params.runId, POLICY_NAME, now, selected.goalId);
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
      .get(selected.goalId) as Record<string, unknown>;
    return {
      selected: true,
      goal: this.parseGoalRow(refreshed),
      budgetUsage,
      candidateCount: candidates.length,
    };
  }

  async finalizeAutonomousRun(params: {
    runId: string;
    goalId: string;
    agentId: string;
    trigger: string;
    success: boolean;
    durationMs?: number;
    error?: string;
  }): Promise<{
    success: boolean;
    error?: string;
    durationMs?: number;
    minimumActionSatisfied: boolean;
    sensingSteps: number;
    requiredSensingSteps: number;
    finishedAt: number;
    satiatedUntil?: number;
  }> {
    const db = await this.ensureDb();
    const sensingSteps = this.countAutonomousSensingSteps(db, params.runId);
    const metMinimumAction =
      sensingSteps >= this.config.actionPolicy.minimumSensingSteps ||
      this.autonomousRunReportedNoSensingAffordance(db, params.runId);
    const success = params.success && metMinimumAction;
    const status: GoalStatus = success ? "completed" : "failed";
    const now = Date.now();
    const satiatedUntil = now + this.config.boredom.satiationMinutes * 60 * 1000;
    if (this.config.boredom.satiationMinutes > 0) {
      this.writeNumericMeta(db, BOREDOM_SATIATED_UNTIL_META_KEY, satiatedUntil);
    }
    const minimumActionError =
      `autonomous curiosity ended before taking ${this.config.actionPolicy.minimumSensingSteps} qualifying tool-backed step(s) or declaring no safe tool affordance`;
    const outcome = {
      success,
      error: metMinimumAction
        ? params.error
        : params.error
          ? `${minimumActionError}; agent error: ${clampContent(params.error)}`
          : minimumActionError,
      durationMs: params.durationMs,
      minimumActionSatisfied: metMinimumAction,
      sensingSteps,
      requiredSensingSteps: this.config.actionPolicy.minimumSensingSteps,
      finishedAt: now,
      ...(this.config.boredom.satiationMinutes > 0 ? { satiatedUntil } : {}),
    };
    db.prepare(
      `UPDATE goals SET status = ?, outcome_json = ?, updated_at = ? WHERE goal_id = ?`,
    ).run(status, toJson(outcome), now, params.goalId);
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
    return outcome;
  }

  private countAutonomousSensingSteps(db: DatabaseSync, runId: string): number {
    const eventRows = db
      .prepare(
        `SELECT event_type, payload_json
         FROM events
         WHERE run_id = ? AND event_type IN ('tool_allowed', 'external_action')`,
      )
      .all(runId) as { event_type?: string; payload_json?: string }[];
    return eventRows.filter((row) => {
      if (row.event_type === "external_action") {
        return true;
      }
      const payload = parseJsonObject(row.payload_json);
      const toolName = String(payload.toolName ?? "").trim().toLowerCase();
      return row.event_type === "tool_allowed" && toolName !== "curiosity_inspect";
    }).length;
  }

  async countSensingStepsForRun(runId: string): Promise<number> {
    const db = await this.ensureDb();
    return this.countAutonomousSensingSteps(db, runId);
  }

  private autonomousRunReportedNoSensingAffordance(db: DatabaseSync, runId: string): boolean {
    const assistantRows = db
      .prepare(
        `SELECT content
         FROM observations
         WHERE run_id = ? AND kind = 'assistant_output'
         ORDER BY created_at DESC LIMIT 5`,
      )
      .all(runId) as { content?: string }[];
    return assistantRows.some((row) => String(row.content ?? "").includes(NO_SENSING_AFFORDANCE_TOKEN));
  }

  async notifyAutonomousStart(params: {
    runId: string;
    agentId: string;
    goal: GoalRecord;
    now?: number;
    fetchFn?: typeof fetch;
  }) {
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

  async notifyAutonomousFinish(params: {
    runId: string;
    agentId: string;
    goal: GoalRecord;
    success: boolean;
    error?: string;
    summary?: string;
    now?: number;
    fetchFn?: typeof fetch;
  }) {
    const now = params.now ?? Date.now();
    const result = await sendAutonomousResultNotice({
      config: this.config.notifications.autonomousStart,
      goal: params.goal,
      agentId: params.agentId,
      runId: params.runId,
      success: params.success,
      error: params.error,
      summary: params.summary,
      fetchFn: params.fetchFn,
      logger: this.logger,
    });
    await this.appendAuditEvent({
      ts: now,
      eventType: result.sent ? "autonomous_result_notification_sent" : "autonomous_result_notification_skipped",
      goalId: params.goal.goalId,
      runId: params.runId,
      payload: result,
    });
    return result;
  }

  async updateRunTokens(params: {
    runId: string;
    goalId?: string;
    agentId: string;
    trigger: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }) {
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

  async queueSnapshot(limit = 20): Promise<QueueSnapshot> {
    const [paused, budgetUsage, boredom, goals] = await Promise.all([
      this.isPaused(),
      this.getBudgetUsage(),
      this.getBoredomState(),
      this.listGoalsByStatus(["queued", "selected", "in_progress", "completed", "failed"], limit),
    ]);
    return { paused, budgetUsage, boredom, goals };
  }

  async observatorySnapshot(limit = 50): Promise<ObservatorySnapshot> {
    const [queue, recentRuns, recentEvents, recentObservations] = await Promise.all([
      this.queueSnapshot(limit),
      this.listRecentRunUsage(limit),
      this.listRecentEvents(limit * 2),
      this.listRecentObservations(limit * 2),
    ]);
    return {
      ...queue,
      generatedAt: Date.now(),
      workspaceDir: this.workspaceDir,
      curiosityDir: this.curiosityDir,
      retention: {
        retentionDays: this.config.logging.retentionDays,
        maxStorageBytes: this.config.logging.maxStorageBytes,
      },
      recentRuns,
      recentEvents,
      recentObservations,
    };
  }

  async inspectIdentifier(identifier: string): Promise<Record<string, unknown>> {
    const db = await this.ensureDb();
    const goalRow = db
      .prepare(`SELECT * FROM goals WHERE goal_id = ? OR last_run_id = ? LIMIT 1`)
      .get(identifier, identifier) as Record<string, unknown> | undefined;
    const goalId = asString(goalRow?.goal_id) ?? "";
    const runRow = db
      .prepare(`SELECT * FROM run_usage WHERE run_id = ? LIMIT 1`)
      .get(identifier) as Record<string, unknown> | undefined;
    const events = db
      .prepare(
        `SELECT * FROM events WHERE goal_id = ? OR run_id = ? ORDER BY ts DESC LIMIT 50`,
      )
      .all(goalId, identifier) as Record<string, unknown>[];
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

  async observatoryRunDetail(identifier: string, limit = 200): Promise<ObservatoryRunDetail> {
    const db = await this.ensureDb();
    const goalRow = db
      .prepare(`SELECT * FROM goals WHERE goal_id = ? OR last_run_id = ? LIMIT 1`)
      .get(identifier, identifier) as Record<string, unknown> | undefined;
    const goal = goalRow ? this.parseGoalRow(goalRow) : null;
    const runId = goal?.lastRunId ?? identifier;
    const goalId = goal?.goalId ?? "";
    const runRow = db
      .prepare(`SELECT * FROM run_usage WHERE run_id = ? LIMIT 1`)
      .get(runId) as Record<string, unknown> | undefined;
    const events = db
      .prepare(
        `SELECT * FROM events WHERE goal_id = ? OR run_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(goalId, runId, limit) as Record<string, unknown>[];
    const observations = db
      .prepare(
        `SELECT * FROM observations WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(runId, limit) as Record<string, unknown>[];
    return {
      generatedAt: Date.now(),
      goal,
      runUsage: runRow ? this.parseRunUsageRow(runRow) : null,
      events: events.map((event) => this.parseEventRow(event)),
      observations: observations.map((observation) => this.parseObservationRow(observation)),
    };
  }

  async readRawObservationContent(observationId: number): Promise<string | null> {
    const db = await this.ensureDb();
    const row = db
      .prepare(`SELECT metadata_json FROM observations WHERE id = ? LIMIT 1`)
      .get(observationId) as Record<string, unknown> | undefined;
    const metadata = parseJsonObject(row?.metadata_json);
    const rawPath = asString(metadata.rawContentPath);
    if (!rawPath) {
      return null;
    }
    const resolved = path.resolve(rawPath);
    const curiosityRoot = path.resolve(this.curiosityDir);
    if (resolved !== curiosityRoot && !resolved.startsWith(`${curiosityRoot}${path.sep}`)) {
      return null;
    }
    try {
      return await fs.readFile(resolved, "utf8");
    } catch {
      return null;
    }
  }

  async compareWindow(windowMs: number): Promise<CompareSnapshot> {
    const db = await this.ensureDb();
    const since = Date.now() - windowMs;
    const goals = (
      db
        .prepare(`SELECT * FROM goals WHERE created_at >= ? ORDER BY created_at DESC`)
        .all(since) as Record<string, unknown>[]
    ).map((row) => this.parseGoalRow(row));
    const events = db
      .prepare(`SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC`)
      .all(since) as Record<string, unknown>[];
    const observations = (
      db
        .prepare(`SELECT * FROM observations WHERE created_at >= ? ORDER BY created_at DESC`)
        .all(since) as Record<string, unknown>[]
    ).map((row) => this.parseObservationRow(row));
    const runUsageRows = db
      .prepare(`SELECT * FROM run_usage WHERE started_at >= ?`)
      .all(since) as Record<string, unknown>[];

    const selectedCount = events.filter((event) => event.event_type === "goal_selected").length;
    const externalAttempts = events.filter((event) => event.event_type === "external_action").length;
    const externalSuccess = observations.filter(
      (observation) => observation.kind === "message_sent" && observation.success === true,
    ).length;
    const completedGoals = goals.filter((goal) => goal.status === "completed");
    const failedGoals = goals.filter((goal) => goal.status === "failed");
    const scoreKeys: Array<keyof ScoreCard> = [
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
    const averageScores: Partial<Record<keyof ScoreCard, number>> = {};
    for (const key of scoreKeys) {
      averageScores[key] =
        goals.length === 0
          ? 0
          : goals.reduce((sum, goal) => sum + Number(goal.scoresByModel[key] ?? 0), 0) /
            goals.length;
    }

    const autonomousRuns = runUsageRows.filter((row) => Number(row.autonomous) === 1);
    const interventionSignals = autonomousRuns.filter((run) =>
      observations.some((observation) => {
        return (
          observation.kind === "message_received" &&
          observation.createdAt >= Number(run.ended_at ?? run.started_at) &&
          observation.createdAt <= Number(run.ended_at ?? run.started_at) + 30 * 60 * 1000
        );
      }),
    ).length;

    return {
      windowMs,
      candidateCount: goals.length,
      selectedCount,
      completedCount: completedGoals.length,
      failedCount: failedGoals.length,
      selectionRate: goals.length === 0 ? 0 : selectedCount / goals.length,
      realizedNovelty:
        completedGoals.length === 0
          ? 0
          : completedGoals.reduce((sum, goal) => sum + goal.scoresByModel.novelty_composite, 0) /
            completedGoals.length,
      uncertaintyReduced:
        completedGoals.length === 0
          ? 0
          : completedGoals.reduce(
              (sum, goal) => sum + goal.scoresByModel.plan2explore_uncertainty,
              0,
            ) / completedGoals.length,
      progressRealized: selectedCount === 0 ? 0 : completedGoals.length / selectedCount,
      externalActionSuccess: externalAttempts === 0 ? 0 : externalSuccess / externalAttempts,
      reversalsFailures: failedGoals.length,
      humanInterventionRate: autonomousRuns.length === 0 ? 0 : interventionSignals / autonomousRuns.length,
      totalTokens: runUsageRows.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0),
      averageScores,
    };
  }

  async buildAwarenessContext(): Promise<string | null> {
    const [activeGoals, recentFindings] = await Promise.all([
      this.listGoalsByStatus(["queued", "selected", "in_progress"], 5),
      this.listRecentCompletedGoals(5),
    ]);
    return renderAwarenessPrompt({ activeGoals, recentFindings });
  }
}
