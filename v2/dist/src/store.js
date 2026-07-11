import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const json = (value) => JSON.stringify(value);
const parse = (value) => JSON.parse(String(value));
export class DevelopmentStore {
    workspaceDir;
    db;
    constructor(workspaceDir) {
        this.workspaceDir = workspaceDir;
    }
    async database() {
        if (this.db)
            return this.db;
        const dir = path.join(this.workspaceDir, ".openclaw", "curiosity-v2");
        await fs.mkdir(dir, { recursive: true });
        this.db = new DatabaseSync(path.join(dir, "development.db"));
        this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, state TEXT, body_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_kind_updated ON records(kind, updated_at DESC);
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER,
        tokens INTEGER NOT NULL DEFAULT 0, success INTEGER
      );
    `);
        return this.db;
    }
    async put(kind, id, body, state, createdAt = Date.now()) {
        const db = await this.database();
        db.prepare(`INSERT INTO records(kind,id,created_at,updated_at,state,body_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,state=excluded.state,body_json=excluded.body_json`)
            .run(kind, id, createdAt, Date.now(), state ?? null, json(body));
    }
    async list(kind, limit) {
        const db = await this.database();
        return db.prepare("SELECT body_json FROM records WHERE kind=? ORDER BY updated_at DESC LIMIT ?").all(kind, limit).map(row => parse(row.body_json));
    }
    async snapshot() {
        return {
            self: (await this.list("self", 1))[0],
            interests: await this.list("interest", 30),
            projects: await this.list("project", 30),
            recentExperiences: await this.list("experience", 40),
            relationships: await this.list("relationship", 30),
            artifacts: await this.list("artifact", 50),
            resourceRequests: await this.list("resource_request", 20),
            selfModifications: await this.list("self_modification", 20),
        };
    }
    async recordRunStart(runId, now = Date.now()) {
        (await this.database()).prepare("INSERT OR IGNORE INTO runs(run_id,started_at) VALUES(?,?)").run(runId, now);
    }
    async recordRunEnd(runId, success, tokens = 0) {
        (await this.database()).prepare("UPDATE runs SET ended_at=?,success=?,tokens=? WHERE run_id=?").run(Date.now(), success ? 1 : 0, tokens, runId);
    }
    async usage24h(now = Date.now()) {
        const row = (await this.database()).prepare("SELECT COUNT(*) runs, COALESCE(SUM(tokens),0) tokens FROM runs WHERE started_at>=?").get(now - 86_400_000);
        return { runs: Number(row.runs), tokens: Number(row.tokens) };
    }
    id(prefix) { return `${prefix}-${randomUUID()}`; }
}
