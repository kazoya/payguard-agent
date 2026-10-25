import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

/** Resolved from the project root because Next.js bundling breaks module-relative paths. */
export const DEFAULT_MIGRATIONS_DIR = path.resolve(process.cwd(), "src/db/migrations");

/** Opens (or creates) the SQLite file and applies pending NNN_name.sql migrations in order. */
export function openDb(file: string, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db, migrationsDir);
  return db;
}

export function migrate(db: Db, migrationsDir: string): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(migrationsDir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const newlyApplied: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(path.join(migrationsDir, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
    })();
    newlyApplied.push(name);
  }
  return newlyApplied;
}
