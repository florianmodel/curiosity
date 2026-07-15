import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);
export function requireNodeSqlite() {
    try {
        return require("node:sqlite");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`);
    }
}
export async function openCuriosityDatabase(dbPath) {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    return db;
}
