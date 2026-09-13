// Read-only observer: never opens a model session or sends a message.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
if (args.includes("--help")) {
    console.log("Usage: node dist/scripts/inspect.js --workspace /agent/workspace [--limit 100] [--before event-sequence] [--id record-id] [--html /output/timeline.html]");
    process.exit(0);
}
const workspace = path.resolve(value("--workspace") ?? process.cwd());
const filename = path.join(workspace, ".openclaw/curiosity-v2/development.db");
await fs.access(filename);
const db = new DatabaseSync(filename, { readOnly: true });
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(item => item.name));
const count = Math.max(1, Math.min(1000, Number(value("--limit")) || 100));
const before = Number(value("--before")) || Number.MAX_SAFE_INTEGER;
const records = db.prepare("SELECT kind,id,updated_at,body_json FROM records ORDER BY updated_at DESC LIMIT ?").all(count);
const events = tables.has("events") ? db.prepare("SELECT seq,body_json FROM events WHERE seq<? ORDER BY seq DESC LIMIT ?").all(before, count) : [];
const runs = db.prepare("SELECT run_id,started_at,ended_at,tokens,success FROM runs ORDER BY started_at DESC LIMIT ?").all(count);
const operations = tables.has("external_actions") ? db.prepare("SELECT operation_id,target,created_at,state,result_json FROM external_actions ORDER BY created_at DESC LIMIT ?").all(count) : [];
const requestedId = value("--id");
const revisions = requestedId && tables.has("revisions") ? db.prepare("SELECT seq,created_at,body_json FROM revisions WHERE record_id=? ORDER BY seq DESC LIMIT ?").all(requestedId, count) : [];
db.close();
const data = { workspace, events: events.map(row => ({ sequence: row.seq, ...JSON.parse(row.body_json) })), nextBefore: events.at(-1)?.seq, records: records.map(row => ({ kind: row.kind, id: row.id, updatedAt: row.updated_at, record: JSON.parse(row.body_json) })), runs, operations, revisions };
const htmlPath = value("--html");
if (!htmlPath) {
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
}
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const details = (value) => `<details><summary>Details</summary><pre>${escape(JSON.stringify(value, null, 2))}</pre></details>`;
const eventRows = data.events.map(event => `<article><time>${escape(new Date(event.createdAt).toISOString())}</time><h3>${escape(event.toolName ?? event.kind)}</h3><p>${escape(event.outcome)}</p><p class="target">${escape(event.target)}</p>${details(event)}</article>`).join("");
const recordRows = data.records.map(item => `<article><small>${escape(item.kind)}</small><h3>${escape(item.record.name ?? item.record.note ?? item.id)}</h3>${details(item.record)}</article>`).join("");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Curiosity — observed history</title><style>
body{font:16px/1.6 system-ui,sans-serif;background:#faf9f6;color:#262b2c;max-width:1100px;margin:48px auto;padding:0 24px}h1{font-size:36px;letter-spacing:-1px}h2{margin-top:40px}h3{margin:4px 0}article{padding:20px 0;border-bottom:1px solid #d9ddda}time,small,.target{color:#54665d;font-size:13px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef1ed;padding:16px;font-size:12px}summary{cursor:pointer}p{margin:6px 0}.intro{max-width:750px}</style><h1>Curiosity: observed history</h1><p class="intro">An observation surface, not a scorecard. Actions come from tool events; interests and reflections are the agent's interpretations. This static export makes no network requests.</p><p>${escape(workspace)}</p><h2>Recent sessions and usage</h2>${details(runs)}<h2>Actions and events</h2>${eventRows || "<p>No events recorded yet.</p>"}<h2>Interests, creations, and follow-ups</h2>${recordRows}<h2>Publication operations</h2><p>Pending operations may have reached Mastodon. Inspect the account before any further send.</p>${details(operations)}${requestedId ? `<h2>Revision history</h2>${details(revisions)}` : ""}</html>`;
const output = path.resolve(htmlPath);
await fs.writeFile(output, html, "utf8");
console.log(`Wrote ${output}`);
