import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isWithinActiveWindow, resolveWanderWorkspaceDir } from "./config.js";
import { createOpenAiEmbedder, type Embedder, type EmbeddingCache } from "./embeddings.js";
import type {
  ActiveRun,
  AuditEventRecord,
  BoredomState,
  BudgetUsage,
  Candidate,
  GoalRecord,
  GoalStatus,
  ObservationKind,
  ObservationRecord,
  RunReport,
  RunUsageRecord,
  ScoreCard,
  TerritoryRecord,
  WakeDecision,
  WanderConfig,
} from "./types.js";

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

const IDLE_ANCHOR_META_KEY = "idle_anchor_at";
const SATIATED_UNTIL_META_KEY = "boredom_satiated_until";
const LAST_WAKE_META_KEY = "last_boredom_wake_requested_at";

/** Merge a new run's topic into an existing territory region above this similarity. */
const TERRITORY_MERGE_DISTANCE = 0.18;

function clampContent(text: string, maxChars = 1600): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
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

function parseJsonStringArray(value: unknown): string[] {
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

function parseJsonNumberArray(value: unknown): number[] | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "number")
      ? (parsed as number[])
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function candidateFingerprint(candidate: Pick<Candidate, "origin" | "topic">): string {
  return [candidate.origin, candidate.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")].join("|");
}

export class WanderManager {
  readonly workspaceDir: string;
  readonly wanderDir: string;
  readonly dbPath: string;
  readonly logger: LoggerLike;
  private config: WanderConfig;
  private db: DatabaseSync | null = null;
  private embedderInstance: Embedder | null = null;
  /** In-flight autonomous runs keyed by agent id; used to attribute hook events. */
  private activeRuns = new Map<string, ActiveRun>();
  /** Agents currently inside a candidate-generation call, mapped to the generation run id. */
  private generationInFlight = new Map<string, string>();

  constructor(params: { workspaceDir: string; config: WanderConfig; logger: LoggerLike }) {
    this.workspaceDir = params.workspaceDir;
    this.wanderDir = resolveWanderWorkspaceDir(params.workspaceDir);
    this.dbPath = path.join(this.wanderDir, "wander.db");
    this.config = params.config;
    this.logger = params.logger;
  }

  getConfig(): WanderConfig {
    return this.config;
  }

  updateConfig(config: WanderConfig) {
    this.config = config;
    this.embedderInstance = null;
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
    const { openWanderDatabase } = await import("./sqlite.js");
    this.db = await openWanderDatabase(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        goal_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        origin TEXT NOT NULL,
        topic TEXT NOT NULL,
        why_interesting TEXT NOT NULL,
        first_action TEXT NOT NULL,
        expected_artifact TEXT NOT NULL,
        expected_surprise REAL NOT NULL,
        domain TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        estimated_cost REAL NOT NULL,
        risk REAL NOT NULL,
        scores_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_run_id TEXT,
        outcome_json TEXT
      );

      CREATE TABLE IF NOT EXISTS territory (
        territory_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        summary TEXT NOT NULL,
        domain TEXT NOT NULL,
        vector_json TEXT,
        visits INTEGER NOT NULL DEFAULT 1,
        first_visited_at INTEGER NOT NULL,
        last_visited_at INTEGER NOT NULL,
        learning_progress REAL NOT NULL DEFAULT 0,
        saturation REAL NOT NULL DEFAULT 0,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        run_ids_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        run_id TEXT,
        agent_id TEXT,
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
        kind TEXT NOT NULL DEFAULT 'other',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        success INTEGER,
        duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER
      );

      CREATE TABLE IF NOT EXISTS embedding_cache (
        hash TEXT PRIMARY KEY,
        text_preview TEXT NOT NULL,
        model TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    return this.db;
  }

  // ---------------------------------------------------------------- embedder

  private embeddingCache(db: DatabaseSync): EmbeddingCache {
    return {
      get: (hash) => {
        const row = db
          .prepare(`SELECT vector_json FROM embedding_cache WHERE hash = ? LIMIT 1`)
          .get(hash) as { vector_json?: string } | undefined;
        return parseJsonNumberArray(row?.vector_json);
      },
      set: (hash, textPreview, model, vector) => {
        db.prepare(
          `INSERT INTO embedding_cache (hash, text_preview, model, vector_json, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(hash) DO NOTHING`,
        ).run(hash, textPreview, model, toJson(vector), Date.now());
      },
    };
  }

  async embedder(): Promise<Embedder> {
    const db = await this.ensureDb();
    if (!this.embedderInstance) {
      this.embedderInstance = createOpenAiEmbedder({
        config: this.config.embeddings,
        cache: this.embeddingCache(db),
        logger: this.logger,
      });
    }
    return this.embedderInstance;
  }

  // ------------------------------------------------------------- audit trail

  async appendAuditEvent(params: {
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

    await fs.mkdir(this.wanderDir, { recursive: true });
    const date = new Date(ts).toISOString().slice(0, 10);
    const eventPath = path.join(this.wanderDir, `events-${date}.jsonl`);
    const line = JSON.stringify({
      ts,
      eventType: params.eventType,
      goalId: params.goalId,
      runId: params.runId,
      payload,
    });
    await fs.appendFile(eventPath, `${line}\n`, "utf8");
  }

  async listRecentEvents(limit = 100): Promise<AuditEventRecord[]> {
    const db = await this.ensureDb();
    const rows = db
      .prepare(`SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: typeof row.id === "number" ? Number(row.id) : undefined,
      ts: Number(row.ts),
      eventType: String(row.event_type),
      goalId: asString(row.goal_id),
      runId: asString(row.run_id),
      payload: parseJsonObject(row.payload_json),
    }));
  }

  // ------------------------------------------------------------ pause/resume

  async setPaused(paused: boolean) {
    const db = await this.ensureDb();
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('paused', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(paused ? "1" : "0");
    await this.appendAuditEvent({ eventType: paused ? "paused" : "resumed", payload: { paused } });
  }

  async isPaused(): Promise<boolean> {
    const db = await this.ensureDb();
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'paused'`).get() as
      | { value?: string }
      | undefined;
    return row?.value === "1";
  }

  // -------------------------------------------------------------- meta utils

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

  // -------------------------------------------------------------- active runs

  registerActiveRun(run: Omit<ActiveRun, "sensingSteps">) {
    this.activeRuns.set(run.agentId, { ...run, sensingSteps: 0 });
  }

  clearActiveRun(agentId: string) {
    this.activeRuns.delete(agentId);
  }

  getActiveRun(agentId?: string): ActiveRun | null {
    if (agentId) {
      return this.activeRuns.get(agentId) ?? null;
    }
    if (this.activeRuns.size === 1) {
      return [...this.activeRuns.values()][0];
    }
    return null;
  }

  markGenerationInFlight(agentId: string, generationRunId: string | null) {
    if (generationRunId) {
      this.generationInFlight.set(agentId, generationRunId);
    } else {
      this.generationInFlight.delete(agentId);
    }
  }

  /** True while wander itself is driving the agent (generation or exploration). */
  isAutonomousWindow(agentId?: string): boolean {
    if (!agentId) {
      return this.activeRuns.size > 0 || this.generationInFlight.size > 0;
    }
    return this.activeRuns.has(agentId) || this.generationInFlight.has(agentId);
  }

  noteSensingStep(agentId: string | undefined): ActiveRun | null {
    const run = this.getActiveRun(agentId);
    if (!run) {
      return null;
    }
    run.sensingSteps += 1;
    return run;
  }

  addSensingSteps(agentId: string | undefined, count: number): ActiveRun | null {
    const run = this.getActiveRun(agentId);
    if (!run) {
      return null;
    }
    run.sensingSteps += Math.max(0, Math.trunc(count));
    return run;
  }

  // ------------------------------------------------------------ boredom drive

  private readStoredIdleAnchor(db: DatabaseSync): number | null {
    return this.readNumericMeta(db, IDLE_ANCHOR_META_KEY);
  }

  private writeIdleAnchor(db: DatabaseSync, ts: number) {
    this.writeNumericMeta(db, IDLE_ANCHOR_META_KEY, ts);
  }

  /**
   * Which observations count as "the world is active, the agent is not idle".
   * Wander's own autonomous activity must NOT reset idle, otherwise the system
   * keeps itself awake forever; heartbeat acks and infrastructure failures are
   * also not meaningful activity (a hard-won learning from v1).
   */
  observationResetsIdle(input: {
    kind: ObservationKind;
    content?: string;
    toolName?: string;
    metadata?: Record<string, unknown>;
  }): boolean {
    if (input.metadata?.wanderAutonomous === true) {
      return false;
    }
    const trigger = typeof input.metadata?.trigger === "string" ? input.metadata.trigger : "";
    if (trigger === "heartbeat") {
      return input.kind === "message_received";
    }
    if (input.kind === "message_received") {
      return true;
    }
    if (input.kind === "assistant_output") {
      return !isHeartbeatAckText(input.content ?? "");
    }
    if (input.kind === "tool_failure" && isInfrastructureFailureText(input.content ?? "")) {
      return false;
    }
    return input.kind === "tool_success" || input.kind === "tool_failure" || input.kind === "message_sent";
  }

  private async resolveIdleAnchor(now: number): Promise<number> {
    const db = await this.ensureDb();
    const stored = this.readStoredIdleAnchor(db);
    if (stored !== null) {
      return stored;
    }
    this.writeIdleAnchor(db, now);
    return now;
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
      ? clamp01((idleMs - startsAfterMs) / growthWindowMs)
      : 0;
    const satiatedUntil = this.readNumericMeta(db, SATIATED_UNTIL_META_KEY) ?? undefined;
    const level = satiatedUntil && now < satiatedUntil ? 0 : rawLevel;
    return {
      enabled: this.config.boredom.enabled,
      idleSince,
      idleMs,
      idleMinutes: idleMs / 60_000,
      rawLevel,
      level,
      startsAfterMs,
      saturatesAfterMs,
      ...(satiatedUntil ? { satiatedUntil } : {}),
    };
  }

  async getBudgetUsage(now = Date.now()): Promise<BudgetUsage> {
    const db = await this.ensureDb();
    const since24h = now - 24 * 60 * 60 * 1000;
    const runsRow = db
      .prepare(
        `SELECT COUNT(*) AS count FROM run_usage WHERE kind = 'exploration' AND started_at >= ?`,
      )
      .get(since24h) as { count?: number };
    const tokensRow = db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens), 0) AS total
         FROM run_usage
         WHERE kind IN ('exploration', 'generation') AND started_at >= ?`,
      )
      .get(since24h) as { total?: number };
    return {
      autonomousRuns24h: runsRow.count ?? 0,
      autonomousTokens24h: tokensRow.total ?? 0,
    };
  }

  async shouldWake(now = Date.now()): Promise<WakeDecision> {
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
    const lastWake = this.readNumericMeta(db, LAST_WAKE_META_KEY);
    const minIntervalMs = this.config.boredom.wakeMinIntervalMinutes * 60 * 1000;
    if (lastWake !== null && now - lastWake < minIntervalMs) {
      return { shouldWake: false, reason: "wake_interval_active", boredom, budgetUsage };
    }
    if (this.isAutonomousWindow()) {
      return { shouldWake: false, reason: "run_in_flight", boredom, budgetUsage };
    }
    return { shouldWake: true, reason: "boredom_ready", boredom, budgetUsage };
  }

  async markWakeRequested(now = Date.now()) {
    const db = await this.ensureDb();
    this.writeNumericMeta(db, LAST_WAKE_META_KEY, now);
  }

  async markSatiated(now = Date.now()) {
    if (this.config.boredom.satiationMinutes <= 0) {
      return;
    }
    const db = await this.ensureDb();
    const until = now + this.config.boredom.satiationMinutes * 60 * 1000;
    this.writeNumericMeta(db, SATIATED_UNTIL_META_KEY, until);
    // The satiation window doubles as the new idle anchor so boredom regrows
    // from the end of the run rather than from stale pre-run activity.
    this.writeIdleAnchor(db, now);
  }

  // ------------------------------------------------------------ observations

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
    const rawDir = path.join(this.wanderDir, "raw", date, runSegment);
    const filename = `${input.createdAt}-${safePathSegment(input.kind)}-${randomUUID()}.txt`;
    const rawPath = path.join(rawDir, filename);
    try {
      await fs.mkdir(rawDir, { recursive: true });
      await fs.writeFile(rawPath, input.content, "utf8");
    } catch (error) {
      this.logger.warn?.(`wander: raw observation write skipped (${String(error)})`);
      return {};
    }
    return {
      rawContentRelativePath: path.relative(this.wanderDir, rawPath),
      rawContentChars: input.content.length,
    };
  }

  async recordObservation(input: {
    kind: ObservationKind;
    createdAt?: number;
    runId?: string;
    agentId?: string;
    channelId?: string;
    toolName?: string;
    success?: boolean;
    content?: string;
    metadata?: Record<string, unknown>;
  }) {
    const db = await this.ensureDb();
    const createdAt = input.createdAt ?? Date.now();
    const rawContent = input.content ?? "";
    const activeRun = this.getActiveRun(input.agentId);
    const wanderAutonomous = this.isAutonomousWindow(input.agentId);
    const runId = input.runId ?? (wanderAutonomous ? activeRun?.runId : undefined);
    const rawMetadata = await this.writeRawObservationContent({
      kind: input.kind,
      createdAt,
      runId,
      content: rawContent,
    });
    const content = clampContent(rawContent);
    const metadata = {
      ...(input.metadata ?? {}),
      ...rawMetadata,
      ...(wanderAutonomous ? { wanderAutonomous: true } : {}),
    };
    db.prepare(
      `INSERT INTO observations (
         kind, created_at, run_id, agent_id, channel_id, tool_name, success, content, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.kind,
      createdAt,
      runId ?? null,
      input.agentId ?? null,
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
      })
    ) {
      await this.markActivity(createdAt);
    }
  }

  private parseObservationRow(row: Record<string, unknown>): ObservationRecord {
    return {
      id: Number(row.id),
      kind: row.kind as ObservationKind,
      createdAt: Number(row.created_at),
      runId: asString(row.run_id),
      agentId: asString(row.agent_id),
      channelId: asString(row.channel_id),
      toolName: asString(row.tool_name),
      success:
        typeof row.success === "number"
          ? Number(row.success) === 1
          : undefined,
      content: String(row.content ?? ""),
      metadata: parseJsonObject(row.metadata_json),
    };
  }

  async listRecentObservations(limit = 100): Promise<ObservationRecord[]> {
    const db = await this.ensureDb();
    const rows = db
      .prepare(`SELECT * FROM observations ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.parseObservationRow(row));
  }

  async listRecentMeaningfulObservations(limit: number): Promise<ObservationRecord[]> {
    const cutoff =
      Date.now() - this.config.thresholds.recentObservationWindowHours * 60 * 60 * 1000;
    const observations = await this.listRecentObservations(300);
    return observations
      .filter((observation) => observation.createdAt >= cutoff)
      .filter(
        (observation) =>
          observation.metadata.wanderAutonomous !== true &&
          observation.content.trim().length > 0 &&
          !isHeartbeatAckText(observation.content),
      )
      .slice(0, limit);
  }

  // --------------------------------------------------------------- run usage

  async recordRunUsage(input: {
    runId: string;
    agentId: string;
    trigger: string;
    kind: RunUsageRecord["kind"];
    startedAt?: number;
    endedAt?: number;
    success?: boolean;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }) {
    const db = await this.ensureDb();
    db.prepare(
      `INSERT INTO run_usage (
         run_id, agent_id, trigger, kind, started_at, ended_at, success, duration_ms, input_tokens, output_tokens, total_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
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
      input.kind,
      input.startedAt ?? Date.now(),
      input.endedAt ?? null,
      input.success == null ? null : input.success ? 1 : 0,
      input.durationMs ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.totalTokens ?? null,
    );
  }

  async addRunTokens(input: {
    agentId?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }) {
    const run = this.getActiveRun(input.agentId);
    const generationRunId =
      !run && input.agentId ? this.generationInFlight.get(input.agentId) ?? null : null;
    if (!run && !generationRunId) {
      return;
    }
    const db = await this.ensureDb();
    const runId = run?.runId ?? generationRunId!;
    const total =
      input.totalTokens ?? (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
    db.prepare(
      `UPDATE run_usage
       SET input_tokens = COALESCE(input_tokens, 0) + ?,
           output_tokens = COALESCE(output_tokens, 0) + ?,
           total_tokens = COALESCE(total_tokens, 0) + ?
       WHERE run_id = ?`,
    ).run(input.inputTokens ?? 0, input.outputTokens ?? 0, total, runId);
  }

  async listRecentRunUsage(limit = 20): Promise<RunUsageRecord[]> {
    const db = await this.ensureDb();
    const rows = db
      .prepare(`SELECT * FROM run_usage ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      runId: String(row.run_id),
      agentId: String(row.agent_id),
      trigger: String(row.trigger),
      kind: (row.kind as RunUsageRecord["kind"]) ?? "other",
      startedAt: Number(row.started_at),
      endedAt: typeof row.ended_at === "number" ? Number(row.ended_at) : undefined,
      success: typeof row.success === "number" ? Number(row.success) === 1 : undefined,
      durationMs: typeof row.duration_ms === "number" ? Number(row.duration_ms) : undefined,
      inputTokens: typeof row.input_tokens === "number" ? Number(row.input_tokens) : undefined,
      outputTokens: typeof row.output_tokens === "number" ? Number(row.output_tokens) : undefined,
      totalTokens: typeof row.total_tokens === "number" ? Number(row.total_tokens) : undefined,
    }));
  }

  // -------------------------------------------------------------------- goals

  private parseGoalRow(row: Record<string, unknown>): GoalRecord {
    return {
      goalId: String(row.goal_id),
      fingerprint: String(row.fingerprint),
      agentId: String(row.agent_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      origin: row.origin as GoalRecord["origin"],
      topic: String(row.topic),
      whyInteresting: String(row.why_interesting ?? ""),
      firstAction: String(row.first_action ?? ""),
      expectedArtifact: String(row.expected_artifact ?? ""),
      expectedSurprise: Number(row.expected_surprise ?? 0.5),
      domain: String(row.domain ?? ""),
      evidence: parseJsonStringArray(row.evidence_json),
      estimatedCost: Number(row.estimated_cost ?? 0),
      risk: Number(row.risk ?? 0),
      scores: parseJsonObject(row.scores_json) as unknown as ScoreCard,
      status: row.status as GoalStatus,
      attempts: Number(row.attempts ?? 0),
      lastRunId: asString(row.last_run_id),
      outcome: parseJsonObject(row.outcome_json),
    };
  }

  async upsertGoal(params: {
    candidate: Candidate;
    scores: ScoreCard;
    agentId: string;
    status: GoalStatus;
    now?: number;
  }): Promise<GoalRecord> {
    const db = await this.ensureDb();
    const now = params.now ?? Date.now();
    const fingerprint = candidateFingerprint(params.candidate);
    const existing = db
      .prepare(`SELECT * FROM goals WHERE fingerprint = ? LIMIT 1`)
      .get(fingerprint) as Record<string, unknown> | undefined;
    if (existing) {
      const current = this.parseGoalRow(existing);
      // Terminal goals keep their status; a re-generated identical topic just
      // refreshes scores so retry blocking still sees the original attempts.
      const nextStatus =
        current.status === "completed" || current.status === "failed"
          ? current.status
          : params.status;
      db.prepare(
        `UPDATE goals
         SET why_interesting = ?, first_action = ?, expected_artifact = ?, expected_surprise = ?,
             domain = ?, evidence_json = ?, estimated_cost = ?, risk = ?, scores_json = ?, status = ?, updated_at = ?
         WHERE goal_id = ?`,
      ).run(
        params.candidate.whyInteresting,
        params.candidate.firstAction,
        params.candidate.expectedArtifact,
        params.candidate.expectedSurprise,
        params.candidate.domain,
        toJson(params.candidate.evidence),
        params.candidate.estimatedCost,
        params.candidate.risk,
        toJson(params.scores),
        nextStatus,
        now,
        current.goalId,
      );
      return this.getGoal(current.goalId) as Promise<GoalRecord>;
    }
    const goalId = randomUUID();
    db.prepare(
      `INSERT INTO goals (
         goal_id, fingerprint, agent_id, created_at, updated_at, origin, topic, why_interesting,
         first_action, expected_artifact, expected_surprise, domain, evidence_json,
         estimated_cost, risk, scores_json, status, attempts, last_run_id, outcome_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`,
    ).run(
      goalId,
      fingerprint,
      params.agentId,
      now,
      now,
      params.candidate.origin,
      params.candidate.topic,
      params.candidate.whyInteresting,
      params.candidate.firstAction,
      params.candidate.expectedArtifact,
      params.candidate.expectedSurprise,
      params.candidate.domain,
      toJson(params.candidate.evidence),
      params.candidate.estimatedCost,
      params.candidate.risk,
      toJson(params.scores),
      params.status,
    );
    return this.getGoal(goalId) as Promise<GoalRecord>;
  }

  async getGoal(goalId: string): Promise<GoalRecord | null> {
    const db = await this.ensureDb();
    const row = db.prepare(`SELECT * FROM goals WHERE goal_id = ? LIMIT 1`).get(goalId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.parseGoalRow(row) : null;
  }

  async findGoalByRunId(runId: string): Promise<GoalRecord | null> {
    const db = await this.ensureDb();
    const row = db.prepare(`SELECT * FROM goals WHERE last_run_id = ? LIMIT 1`).get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.parseGoalRow(row) : null;
  }

  async listGoalsByStatus(statuses: GoalStatus[], limit = 30): Promise<GoalRecord[]> {
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

  async listRecentGoalTopics(limit = 20): Promise<string[]> {
    const db = await this.ensureDb();
    const rows = db
      .prepare(`SELECT topic FROM goals ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as Array<{ topic?: string }>;
    return rows.map((row) => String(row.topic ?? "")).filter(Boolean);
  }

  /** Retry blocking keyed to the actual last attempt time (outcome.finishedAt), not updatedAt. */
  goalRetryBlocked(goal: GoalRecord, now = Date.now()): string | null {
    if (goal.attempts >= this.config.actionPolicy.maxAttemptsPerGoal) {
      return "max_attempts_reached";
    }
    const cooldownMs = this.config.actionPolicy.retryCooldownMinutes * 60 * 1000;
    const finishedAt = goal.outcome.finishedAt;
    const lastAttemptAt =
      typeof finishedAt === "number" && Number.isFinite(finishedAt) ? finishedAt : null;
    if (goal.attempts > 0 && cooldownMs > 0 && lastAttemptAt !== null && now - lastAttemptAt < cooldownMs) {
      return "retry_cooldown_active";
    }
    return null;
  }

  async markGoalSelected(params: { goalId: string; runId: string; agentId: string; now?: number }) {
    const db = await this.ensureDb();
    const now = params.now ?? Date.now();
    db.prepare(
      `UPDATE goals
       SET status = 'in_progress', attempts = attempts + 1, last_run_id = ?, agent_id = ?, updated_at = ?
       WHERE goal_id = ?`,
    ).run(params.runId, params.agentId, now, params.goalId);
  }

  async markGoalRejected(goalId: string, now = Date.now()) {
    const db = await this.ensureDb();
    db.prepare(
      `UPDATE goals SET status = 'rejected', updated_at = ? WHERE goal_id = ? AND status = 'queued'`,
    ).run(now, goalId);
  }

  async finalizeGoal(params: {
    goalId: string;
    runId: string;
    success: boolean;
    sensingSteps: number;
    durationMs?: number;
    error?: string;
    report: RunReport | null;
    playgroundDir?: string;
  }): Promise<{ status: GoalStatus; outcome: Record<string, unknown> }> {
    const db = await this.ensureDb();
    const now = Date.now();
    const status: GoalStatus = params.success ? "completed" : "failed";
    const outcome: Record<string, unknown> = {
      success: params.success,
      finishedAt: now,
      sensingSteps: params.sensingSteps,
      requiredSensingSteps: this.config.actionPolicy.minimumSensingSteps,
      ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
      ...(params.error ? { error: clampContent(params.error) } : {}),
      ...(params.playgroundDir ? { playgroundDir: params.playgroundDir } : {}),
      ...(params.report
        ? {
            report: {
              topic: params.report.topic,
              summary: params.report.summary,
              surprise: params.report.surprise,
              learningProgress: params.report.learningProgress,
              artifacts: params.report.artifacts,
              nextClue: params.report.nextClue,
              worthContinuing: params.report.worthContinuing,
            },
          }
        : { reportMissing: true }),
    };
    db.prepare(
      `UPDATE goals SET status = ?, outcome_json = ?, updated_at = ? WHERE goal_id = ?`,
    ).run(status, toJson(outcome), now, params.goalId);
    return { status, outcome };
  }

  // ---------------------------------------------------------------- territory

  private parseTerritoryRow(row: Record<string, unknown>): TerritoryRecord {
    return {
      territoryId: String(row.territory_id),
      topic: String(row.topic),
      summary: String(row.summary ?? ""),
      domain: String(row.domain ?? ""),
      vector: parseJsonNumberArray(row.vector_json),
      visits: Number(row.visits ?? 1),
      firstVisitedAt: Number(row.first_visited_at),
      lastVisitedAt: Number(row.last_visited_at),
      learningProgress: Number(row.learning_progress ?? 0),
      saturation: Number(row.saturation ?? 0),
      artifacts: parseJsonStringArray(row.artifacts_json),
      runIds: parseJsonStringArray(row.run_ids_json),
    };
  }

  async listTerritory(limit = 200): Promise<TerritoryRecord[]> {
    const db = await this.ensureDb();
    const rows = db
      .prepare(`SELECT * FROM territory ORDER BY last_visited_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.parseTerritoryRow(row));
  }

  /**
   * Fold a finished run into the exploration map. Topics that land close to an
   * existing region merge into it: visits increment, learning progress moves by
   * EMA, and saturation rises when revisits stop producing learning.
   */
  async recordTerritoryVisit(params: {
    runId: string;
    report: RunReport;
    vector: number[] | null;
  }): Promise<TerritoryRecord> {
    const db = await this.ensureDb();
    const now = Date.now();
    const { report } = params;
    let merged: TerritoryRecord | null = null;
    if (params.vector) {
      const { cosineDistance } = await import("./embeddings.js");
      const { normalizeDistance } = await import("./scoring.js");
      for (const region of await this.listTerritory(500)) {
        if (!region.vector) {
          continue;
        }
        if (normalizeDistance(cosineDistance(params.vector, region.vector)) <= TERRITORY_MERGE_DISTANCE) {
          merged = region;
          break;
        }
      }
    }
    if (merged) {
      const learningProgress = clamp01(merged.learningProgress * 0.5 + report.learningProgress * 0.5);
      // Revisits that stop teaching push saturation up; strong learning pulls it back down.
      const saturation = clamp01(
        merged.saturation + (report.learningProgress < 0.3 ? 0.3 : -0.15) + 0.05,
      );
      const artifacts = [...new Set([...merged.artifacts, ...report.artifacts])].slice(0, 24);
      const runIds = [...new Set([...merged.runIds, params.runId])].slice(-24);
      db.prepare(
        `UPDATE territory
         SET topic = ?, summary = ?, visits = visits + 1, last_visited_at = ?,
             learning_progress = ?, saturation = ?, artifacts_json = ?, run_ids_json = ?
         WHERE territory_id = ?`,
      ).run(
        merged.topic,
        clampContent(report.summary, 600) || merged.summary,
        now,
        learningProgress,
        saturation,
        toJson(artifacts),
        toJson(runIds),
        merged.territoryId,
      );
      const row = db
        .prepare(`SELECT * FROM territory WHERE territory_id = ? LIMIT 1`)
        .get(merged.territoryId) as Record<string, unknown>;
      return this.parseTerritoryRow(row);
    }
    const territoryId = randomUUID();
    db.prepare(
      `INSERT INTO territory (
         territory_id, topic, summary, domain, vector_json, visits,
         first_visited_at, last_visited_at, learning_progress, saturation, artifacts_json, run_ids_json
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?)`,
    ).run(
      territoryId,
      clampContent(report.topic, 200),
      clampContent(report.summary, 600),
      "",
      params.vector ? toJson(params.vector) : null,
      now,
      now,
      report.learningProgress,
      toJson(report.artifacts.slice(0, 24)),
      toJson([params.runId]),
    );
    const row = db
      .prepare(`SELECT * FROM territory WHERE territory_id = ? LIMIT 1`)
      .get(territoryId) as Record<string, unknown>;
    return this.parseTerritoryRow(row);
  }

  // ---------------------------------------------------------------- retention

  async pruneRetention(now = Date.now()) {
    const db = await this.ensureDb();
    const cutoff = now - this.config.logging.retentionDays * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM events WHERE ts < ?`).run(cutoff);
    db.prepare(`DELETE FROM observations WHERE created_at < ?`).run(cutoff);
    db.prepare(`DELETE FROM run_usage WHERE started_at < ?`).run(cutoff);
    db.prepare(
      `DELETE FROM goals WHERE updated_at < ? AND status IN ('completed', 'failed', 'rejected')`,
    ).run(cutoff);
    // Territory is intentionally exempt: the exploration map is long-term memory.

    try {
      const files = await fs.readdir(this.wanderDir, { withFileTypes: true });
      await Promise.all(
        files
          .filter((entry) => entry.isFile() && /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
          .map(async (entry) => {
            const rawDate = entry.name.slice("events-".length, "events-YYYY-MM-DD".length);
            const fileTs = Date.parse(`${rawDate}T00:00:00.000Z`);
            if (Number.isFinite(fileTs) && fileTs < cutoff) {
              await fs.unlink(path.join(this.wanderDir, entry.name));
            }
          }),
      );
    } catch (error) {
      this.logger.warn?.(`wander: retention prune skipped (${String(error)})`);
    }
    await this.pruneStorageBudget();
  }

  private async pruneStorageBudget() {
    const maxBytes = this.config.logging.maxStorageBytes;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      return;
    }
    const size = await this.directorySize(this.wanderDir);
    if (size <= maxBytes) {
      return;
    }
    const candidates = await this.listPrunableFiles(this.wanderDir);
    let currentSize = size;
    for (const candidate of candidates) {
      if (currentSize <= maxBytes) {
        break;
      }
      try {
        await fs.rm(candidate.path, { force: true });
        currentSize -= candidate.size;
      } catch {
        // Best-effort retention pruning should never interrupt the wander loop.
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

  private async listPrunableFiles(
    dir: string,
  ): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await this.listPrunableFiles(fullPath)));
          continue;
        }
        if (!entry.isFile() || entry.name === "wander.db") {
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

  // ---------------------------------------------------------------- snapshots

  async statusSnapshot() {
    const [boredom, budgetUsage, paused, territory, recentRuns] = await Promise.all([
      this.getBoredomState(),
      this.getBudgetUsage(),
      this.isPaused(),
      this.listTerritory(10),
      this.listRecentRunUsage(10),
    ]);
    const embedder = await this.embedder();
    return {
      paused,
      boredom,
      budgetUsage,
      budgets: this.config.budgets,
      embeddingAvailable: embedder.available(),
      embeddingModel: embedder.model,
      activeRuns: [...this.activeRuns.values()],
      recentTerritory: territory.map((region) => ({
        topic: region.topic,
        visits: region.visits,
        learningProgress: region.learningProgress,
        saturation: region.saturation,
        lastVisitedAt: new Date(region.lastVisitedAt).toISOString(),
      })),
      recentRuns,
    };
  }

  async queueSnapshot(limit = 20) {
    const goals = await this.listGoalsByStatus(
      ["queued", "selected", "in_progress", "completed", "failed", "rejected"],
      limit,
    );
    return {
      goals: goals.map((goal) => ({
        goalId: goal.goalId,
        topic: goal.topic,
        origin: goal.origin,
        domain: goal.domain,
        status: goal.status,
        attempts: goal.attempts,
        curiosityValue: goal.scores.curiosity_value,
        semanticDistance: goal.scores.semantic_distance,
        frontierFit: goal.scores.frontier_fit,
        updatedAt: new Date(goal.updatedAt).toISOString(),
      })),
    };
  }

  async mapSnapshot(limit = 100) {
    const territory = await this.listTerritory(limit);
    return {
      regions: territory.map((region) => ({
        territoryId: region.territoryId,
        topic: region.topic,
        summary: region.summary,
        visits: region.visits,
        learningProgress: region.learningProgress,
        saturation: region.saturation,
        artifacts: region.artifacts,
        firstVisitedAt: new Date(region.firstVisitedAt).toISOString(),
        lastVisitedAt: new Date(region.lastVisitedAt).toISOString(),
      })),
    };
  }

  async inspectIdentifier(id: string) {
    const goal = (await this.getGoal(id)) ?? (await this.findGoalByRunId(id));
    if (!goal) {
      return { found: false, id };
    }
    const db = await this.ensureDb();
    const events = db
      .prepare(
        `SELECT * FROM events WHERE goal_id = ? OR run_id = ? ORDER BY ts ASC LIMIT 200`,
      )
      .all(goal.goalId, goal.lastRunId ?? "") as Record<string, unknown>[];
    const observations = goal.lastRunId
      ? ((db
          .prepare(`SELECT * FROM observations WHERE run_id = ? ORDER BY created_at ASC LIMIT 100`)
          .all(goal.lastRunId) as Record<string, unknown>[]) ?? [])
      : [];
    return {
      found: true,
      goal,
      events: events.map((row) => ({
        ts: Number(row.ts),
        eventType: String(row.event_type),
        payload: parseJsonObject(row.payload_json),
      })),
      observations: observations.map((row) => this.parseObservationRow(row)),
    };
  }
}
