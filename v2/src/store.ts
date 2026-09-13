import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Artifact, DueHook, Experience, FollowUp, Interest, Project, Relationship, ResourceRequest, SelfModification, SelfRevision, Snapshot, TimelineEvent, Turn, Visit } from "./types.js";

type Body = Record<string, unknown>;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const DAY = 86_400_000;
const limitValue = (value = 50) => Math.max(1, Math.min(200, Math.trunc(value) || 50));

export class DevelopmentStore {
  private opening?: Promise<DatabaseSync>;
  constructor(readonly workspaceDir: string) {}

  private database(): Promise<DatabaseSync> {
    return this.opening ??= this.open();
  }
  private async open(): Promise<DatabaseSync> {
    const dir = path.join(this.workspaceDir, ".openclaw", "curiosity-v2");
    await fs.mkdir(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, "development.db"));
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, state TEXT, body_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_kind_updated ON records(kind, updated_at DESC);
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER,
        tokens INTEGER NOT NULL DEFAULT 0, success INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, run_id TEXT, body_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
      CREATE TABLE IF NOT EXISTS revisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL, kind TEXT NOT NULL,
        created_at INTEGER NOT NULL, body_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS revisions_record ON revisions(record_id, seq);
      INSERT INTO revisions(record_id,kind,created_at,body_json)
        SELECT id,kind,updated_at,body_json FROM records r
        WHERE NOT EXISTS (SELECT 1 FROM revisions v WHERE v.record_id=r.id);
      CREATE TRIGGER IF NOT EXISTS record_insert_revision AFTER INSERT ON records BEGIN
        INSERT INTO revisions(record_id,kind,created_at,body_json) VALUES(NEW.id,NEW.kind,NEW.updated_at,NEW.body_json);
      END;
      CREATE TRIGGER IF NOT EXISTS record_update_revision AFTER UPDATE ON records BEGIN
        INSERT INTO revisions(record_id,kind,created_at,body_json) VALUES(NEW.id,NEW.kind,NEW.updated_at,NEW.body_json);
      END;
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'Revisions are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'Revisions are append-only'); END;
      CREATE TABLE IF NOT EXISTS external_actions (
        operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
        target TEXT, direct INTEGER NOT NULL, state TEXT NOT NULL, result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS contact_blocks (target TEXT PRIMARY KEY, reason TEXT NOT NULL);
    `);
    const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{name: string}>;
    if (!columns.some(item => item.name === "lease_until")) db.exec("ALTER TABLE runs ADD COLUMN lease_until INTEGER");
    return db;
  }

  async close(): Promise<void> { const db = await this.opening; db?.close(); this.opening = undefined; }
  async put(kind: string, id: string, body: unknown, state?: string, createdAt = Date.now()): Promise<void> {
    const db = await this.database();
    const previous = db.prepare("SELECT kind,body_json FROM records WHERE id=?").get(id) as {kind:string;body_json:string}|undefined;
    if (previous && previous.kind !== kind) throw new Error("Record ID belongs to a different kind");
    const original = previous ? parse<Body>(previous.body_json) : {};
    const merged = { ...original, ...(body as Body), createdAt: original.createdAt ?? createdAt, updatedAt: Date.now() };
    db.prepare(`INSERT INTO records(kind,id,created_at,updated_at,state,body_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,state=COALESCE(excluded.state,records.state),body_json=excluded.body_json`)
      .run(kind, id, createdAt, Date.now(), state ?? null, JSON.stringify(merged));
  }
  async get(id: string): Promise<Body | undefined> {
    const row = (await this.database()).prepare("SELECT body_json FROM records WHERE id=?").get(id) as {body_json:string}|undefined;
    return row ? parse<Body>(row.body_json) : undefined;
  }
  async search(query: string, kind?: string, limit = 30): Promise<Body[]> {
    const escaped = query.slice(0, 300).replace(/[\\%_]/g, match => `\\${match}`);
    return ((await this.database()).prepare("SELECT body_json FROM records WHERE (? IS NULL OR kind=?) AND body_json LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?")
      .all(kind ?? null, kind ?? null, `%${escaped}%`, limitValue(limit)) as Array<{body_json:string}>).map(row => parse<Body>(row.body_json));
  }
  async history(id: string, limit = 30): Promise<Body[]> {
    return ((await this.database()).prepare("SELECT body_json FROM revisions WHERE record_id=? ORDER BY seq DESC LIMIT ?").all(id, limitValue(limit)) as Array<{body_json:string}>).map(row => parse<Body>(row.body_json));
  }
  private async list<T>(kind: string, limit: number): Promise<T[]> {
    return ((await this.database()).prepare("SELECT body_json FROM records WHERE kind=? ORDER BY updated_at DESC,rowid DESC LIMIT ?").all(kind, limit) as Array<{body_json:string}>).map(row => parse<T>(row.body_json));
  }
  async recordEvent(input: Omit<TimelineEvent, "eventId" | "createdAt">): Promise<TimelineEvent> {
    const event = { ...input, eventId: this.id("event"), createdAt: Date.now() };
    (await this.database()).prepare("INSERT INTO events(event_id,created_at,run_id,body_json) VALUES(?,?,?,?)").run(event.eventId,event.createdAt,event.runId ?? null,JSON.stringify(event));
    return event;
  }
  async event(id: string): Promise<TimelineEvent | undefined> {
    const row = (await this.database()).prepare("SELECT body_json FROM events WHERE event_id=?").get(id) as {body_json:string}|undefined;
    return row ? parse<TimelineEvent>(row.body_json) : undefined;
  }
  async listEvents(options: {runId?:string;limit?:number;after?:number} = {}): Promise<TimelineEvent[]> {
    return ((await this.database()).prepare("SELECT body_json FROM events WHERE (? IS NULL OR run_id=?) AND created_at>=? ORDER BY seq DESC LIMIT ?")
      .all(options.runId ?? null, options.runId ?? null, options.after ?? 0, limitValue(options.limit)) as Array<{body_json:string}>).map(row => parse<TimelineEvent>(row.body_json));
  }
  async snapshot(): Promise<Snapshot & {events:TimelineEvent[];followUps:FollowUp[]}> {
    const db = await this.database();
    const rows = db.prepare(`SELECT kind,body_json FROM records WHERE kind IN ('interest','project')
      AND json_type(body_json,'$.nextReturnAt') IN ('integer','real')
      AND json_extract(body_json,'$.nextReturnAt')<=?
      AND COALESCE(state,'active') NOT IN ('abandoned','completed','dormant','paused')
      ORDER BY json_extract(body_json,'$.nextReturnAt')`).all(Date.now()) as Array<{kind:string;body_json:string}>;
    const hooks: DueHook[] = rows.map(row => {
      const item = parse<Interest & Project>(row.body_json);
      return {refId: row.kind === "interest" ? item.interestId : item.projectId, kind: row.kind as "interest"|"project",name:item.name,dueAt:item.nextReturnAt!,hint:row.kind === "interest" ? item.openQuestions?.[0] : item.nextMove};
    });
    const followUps = (db.prepare("SELECT body_json FROM records WHERE kind='follow_up' AND state IN ('pending','snoozed') ORDER BY json_extract(body_json,'$.dueAt')").all() as Array<{body_json:string}>).map(row => parse<FollowUp>(row.body_json));
    return {
      self:(await this.list<SelfRevision>("self",1))[0], interests:await this.list<Interest>("interest",30), projects:await this.list<Project>("project",30),
      recentExperiences:await this.list<Experience>("experience",20),relationships:await this.list<Relationship>("relationship",30),artifacts:await this.list<Artifact>("artifact",50),
      resourceRequests:await this.list<ResourceRequest>("resource_request",20),selfModifications:await this.list<SelfModification>("self_modification",20),
      turns:await this.list<Turn>("turn",8),visits:await this.list<Visit>("visit",12),dueHooks:hooks,events:await this.listEvents({limit:12}),followUps,
    };
  }
  private recover(db: DatabaseSync, now: number) {
    db.prepare("UPDATE runs SET ended_at=?,success=0 WHERE ended_at IS NULL AND COALESCE(lease_until,started_at+3600000)<?").run(now, now);
  }
  private usage(db: DatabaseSync, now: number): {runs:number;tokens:number} {
    return db.prepare(`SELECT COALESCE(SUM(CASE WHEN success=1 OR ended_at IS NULL THEN 1 ELSE 0 END),0) runs,
      COALESCE(SUM(tokens),0) tokens FROM runs WHERE started_at>=? OR ended_at>=?`).get(now-DAY, now-DAY) as {runs:number;tokens:number};
  }
  async reserveRun(runId: string, limits: {maxRuns:number;maxTokens:number;leaseMs?:number}, now = Date.now()): Promise<boolean> {
    const db = await this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.recover(db, now);
      const existing = db.prepare("SELECT ended_at FROM runs WHERE run_id=?").get(runId) as {ended_at:number|null}|undefined;
      if (existing) { db.exec("COMMIT"); return existing.ended_at === null; }
      const usage = this.usage(db,now);
      if (usage.runs >= limits.maxRuns || usage.tokens >= limits.maxTokens) { db.exec("COMMIT"); return false; }
      db.prepare("INSERT INTO runs(run_id,started_at,lease_until) VALUES(?,?,?)").run(runId,now,now+(limits.leaseMs ?? 3600000));
      db.exec("COMMIT"); return true;
    } catch(error) {db.exec("ROLLBACK");throw error;}
  }
  async recordRunStart(runId:string, now=Date.now()):Promise<void> {
    (await this.database()).prepare("INSERT OR IGNORE INTO runs(run_id,started_at,lease_until) VALUES(?,?,?)").run(runId,now,now+3600000);
  }
  async addRunTokens(runId:string,tokens:number):Promise<void> {
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error("Token usage must be nonnegative");
    (await this.database()).prepare("UPDATE runs SET tokens=tokens+? WHERE run_id=?").run(Math.ceil(tokens),runId);
  }
  async recordRunEnd(runId:string,success:boolean,tokens?:number):Promise<void> {
    if(tokens !== undefined && (!Number.isFinite(tokens)||tokens<0)) throw new Error("Invalid token count");
    (await this.database()).prepare("UPDATE runs SET ended_at=?,success=?,tokens=CASE WHEN ? IS NULL THEN tokens ELSE MAX(tokens,?) END WHERE run_id=?")
      .run(Date.now(),success?1:0,tokens ?? null,tokens ?? null,runId);
  }
  async usage24h(now=Date.now()):Promise<{runs:number;tokens:number}> { const db=await this.database();this.recover(db,now);return this.usage(db,now); }

  async blockContact(target:string,reason:string):Promise<void> {
    (await this.database()).prepare("INSERT INTO contact_blocks(target,reason) VALUES(?,?) ON CONFLICT(target) DO UPDATE SET reason=excluded.reason").run(target,reason);
    await this.recordEvent({kind:"contact_blocked",target,outcome:reason});
  }
  async isContactBlocked(target:string):Promise<boolean> {return !!(await this.database()).prepare("SELECT 1 FROM contact_blocks WHERE target=?").get(target);}
  async reserveExternal(operationId:string,fingerprint:string,options:{maxPerDay:number;maxDirect:number;direct:boolean;target?:string},now=Date.now()):Promise<{cached?:unknown;reserved:boolean}> {
    const db=await this.database(); db.exec("BEGIN IMMEDIATE");
    try {
      const existing=db.prepare("SELECT * FROM external_actions WHERE operation_id=?").get(operationId) as {fingerprint:string;state:string;result_json:string|null}|undefined;
      if(existing) {
        if(existing.fingerprint!==fingerprint) throw new Error("operationId already used for different content");
        if(existing.state!=="completed"&&existing.state!=="sent") throw new Error("Previous operation is pending or uncertain; inspect it before attempting another send");
        db.exec("COMMIT");return {reserved:false,cached:parse(existing.result_json!)};
      }
      if(options.target && db.prepare("SELECT 1 FROM contact_blocks WHERE target=?").get(options.target)) throw new Error("Contact opted out; no further messages permitted");
      const usage=db.prepare("SELECT COUNT(*) total,COALESCE(SUM(direct),0) direct FROM external_actions WHERE created_at>=?").get(now-DAY) as {total:number;direct:number};
      if(usage.total>=options.maxPerDay || (options.direct && usage.direct>=options.maxDirect)) throw new Error("Daily social action limit reached");
      if(options.direct && options.target && db.prepare("SELECT 1 FROM external_actions WHERE target=? AND direct=1 AND created_at>=?").get(options.target,now-DAY)) throw new Error("Already initiated contact with this account in the last day; wait for a response");
      db.prepare("INSERT INTO external_actions VALUES(?,?,?,?,?,'pending',NULL)").run(operationId,fingerprint,now,options.target ?? null,options.direct?1:0);
      db.exec("COMMIT");return {reserved:true};
    } catch(error) {db.exec("ROLLBACK");throw error;}
  }
  async markExternalSent(operationId:string,result:unknown):Promise<void> {
    (await this.database()).prepare("UPDATE external_actions SET state='sent',result_json=? WHERE operation_id=? AND state='pending'").run(JSON.stringify(result),operationId);
  }
  async finishExternal(operationId:string,result:unknown):Promise<void> {
    (await this.database()).prepare("UPDATE external_actions SET state='completed',result_json=? WHERE operation_id=?").run(JSON.stringify(result),operationId);
  }
  id(prefix:string):string {return `${prefix}-${randomUUID()}`;}
}
