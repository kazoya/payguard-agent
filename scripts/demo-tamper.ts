import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import Database from "better-sqlite3";
import { AuditLog } from "@/audit/log";
import { openDb } from "@/db/db";

/**
 * Tamper demo (S12 AC2). Works on a COPY of the audit DB, never the original:
 *   npm run demo:tamper [path/to/payguard.db]
 * Without a DB (or with fewer than 3 entries) it builds a small sample chain first.
 * It then edits one row "directly in SQLite" and shows that verifyChain() reports where the chain breaks.
 */
const source = path.resolve(process.argv[2] ?? process.env.DATABASE_PATH ?? "./data/payguard.db");
const copy = path.join(mkdtempSync(path.join(tmpdir(), "payguard-tamper-")), "copy.db");

if (existsSync(source)) {
  const src = new Database(source, { readonly: true, fileMustExist: true });
  src.prepare("VACUUM INTO ?").run(copy);
  src.close();
  console.log(`copied ${source} -> ${copy}`);
} else {
  console.log(`no DB at ${source}; using a fresh sample DB at ${copy}`);
}

const db = openDb(copy);
const audit = new AuditLog(db);
for (let i = audit.all().length; i < 5; i++) {
  audit.append({ actor: "demo", event: "PROPOSED", tool: "create_refund", detail: { sample: i + 1 } });
}

const before = audit.verifyChain();
console.log(`before: ${before.ok ? `chain intact (${before.count} entries)` : `broken at seq ${before.firstBadSeq}`}`);

const target = audit.all()[Math.floor(audit.all().length / 2)]!;
// Simulate an attacker with raw DB access: drop the append-only guard and rewrite one entry.
db.exec("DROP TRIGGER IF EXISTS audit_log_no_update");
db.prepare("UPDATE audit_log SET detail_json = ? WHERE seq = ?").run(JSON.stringify({ tampered: true }), target.seq);
console.log(`tampered: rewrote detail_json of seq ${target.seq}`);

const after = audit.verifyChain();
console.log(after.ok ? "after: chain intact (unexpected!)" : `after: BROKEN at seq ${after.firstBadSeq} (${after.reason})`);
db.close();
process.exitCode = after.ok ? 1 : 0;
