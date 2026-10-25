import { describe, expect, it } from "vitest";
import { AuditLog, computeRowHash, GENESIS_HASH } from "@/audit/log";
import { migrate, openDb } from "@/db/db";
import { fakeClock, MIGRATIONS_DIR } from "../helpers/setup";

function seeded(n = 5) {
  const db = openDb(":memory:", MIGRATIONS_DIR);
  const time = fakeClock("2026-10-24T10:00:00.000Z");
  const log = new AuditLog(db, time.clock);
  for (let i = 1; i <= n; i++) {
    log.append({ actor: "u_clerk", event: "PROPOSED", tool: "create_refund", detail: { i, note: "a,b \"quoted\"" } });
    time.advanceHours(1);
  }
  return { db, log };
}

describe("AuditLog", () => {
  it("links each entry to the previous hash, starting from genesis", () => {
    const { log } = seeded(3);
    const rows = log.all();
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);
    const { hash, ...rest } = rows[2]!;
    expect(computeRowHash(rest)).toBe(hash);
  });

  it("verifies a clean chain (and an empty one)", () => {
    expect(seeded(5).log.verifyChain()).toEqual({ ok: true, count: 5 });
    expect(seeded(0).log.verifyChain()).toEqual({ ok: true, count: 0 });
  });

  it("blocks UPDATE and DELETE at the database level", () => {
    const { db } = seeded(2);
    expect(() => db.prepare("UPDATE audit_log SET actor = 'mallory' WHERE seq = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_log WHERE seq = 2").run()).toThrow(/append-only/);
  });

  it("detects a manual edit of row 3 (triggers dropped by an attacker)", () => {
    const { db, log } = seeded(5);
    db.exec("DROP TRIGGER audit_log_no_update");
    db.prepare("UPDATE audit_log SET detail_json = '{\"i\":999}' WHERE seq = 3").run();
    expect(log.verifyChain()).toMatchObject({ ok: false, firstBadSeq: 3, reason: expect.stringMatching(/hash/) });
  });

  it("detects a re-hashed edit because the next link breaks", () => {
    const { db, log } = seeded(5);
    db.exec("DROP TRIGGER audit_log_no_update");
    const row = log.all()[2]!;
    const forged = { ...row, actor: "mallory" };
    const { hash: _old, ...rest } = forged;
    db.prepare("UPDATE audit_log SET actor = ?, hash = ? WHERE seq = 3").run("mallory", computeRowHash(rest));
    expect(log.verifyChain()).toMatchObject({ ok: false, firstBadSeq: 4 });
  });

  it("detects a deleted row", () => {
    const { db, log } = seeded(5);
    db.exec("DROP TRIGGER audit_log_no_delete");
    db.prepare("DELETE FROM audit_log WHERE seq = 2").run();
    expect(log.verifyChain()).toMatchObject({ ok: false, firstBadSeq: 2 });
  });

  it("exports JSON and CSV (golden)", () => {
    const { log } = seeded(1);
    const json = JSON.parse(log.exportJson());
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({ seq: 1, actor: "u_clerk", event: "PROPOSED", ts: "2026-10-24T10:00:00.000Z" });
    const row = log.all()[0]!;
    expect(log.exportCsv()).toBe(
      "seq,ts,actor,event,tool,decision,approval_id,input_hash,output_hash,detail_json,prev_hash,hash\n" +
        `1,2026-10-24T10:00:00.000Z,u_clerk,PROPOSED,create_refund,,,,,"{""i"":1,""note"":""a,b \\""quoted\\""""}",${GENESIS_HASH},${row.hash}\n`,
    );
  });

  it("neutralizes spreadsheet formulas in CSV", () => {
    const db = openDb(":memory:", MIGRATIONS_DIR);
    const log = new AuditLog(db);
    log.append({ actor: "=HYPERLINK(\"x\")", event: "PROPOSED" });
    expect(log.exportCsv()).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe("migrations", () => {
  it("are idempotent", () => {
    const db = openDb(":memory:", MIGRATIONS_DIR);
    expect(migrate(db, MIGRATIONS_DIR)).toEqual([]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["approvals", "audit_log", "executions", "paypal_objects", "webhook_events", "users"]));
  });
});
