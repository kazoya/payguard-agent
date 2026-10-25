import type { Db } from "@/db/db";
import { canonicalJson, sha256Hex } from "@/lib/hash";
import { systemClock, type Clock } from "@/lib/clock";

/**
 * Append-only, SHA-256 hash-chained audit log.
 * hash = SHA256(prev_hash || canonical_json(row without hash)). The seq is part of the hashed row,
 * so deleting or reordering rows breaks the chain as well as editing them.
 */

export const GENESIS_HASH = "0".repeat(64);

export type AuditEvent =
  | "PROPOSED"
  | "ALLOWED"
  | "DENIED"
  | "QUEUED"
  | "APPROVED"
  | "REJECTED"
  | "APPROVAL_REFUSED"
  | "EXPIRED"
  | "EXECUTED"
  | "FAILED"
  | "WEBHOOK";

export type AuditInput = {
  actor: string;
  event: AuditEvent;
  tool?: string | null;
  decision?: string | null;
  approvalId?: string | null;
  inputHash?: string | null;
  outputHash?: string | null;
  detail?: Record<string, unknown> | null;
};

export type AuditRow = {
  seq: number;
  ts: string;
  actor: string;
  event: string;
  tool: string | null;
  decision: string | null;
  approval_id: string | null;
  input_hash: string | null;
  output_hash: string | null;
  detail_json: string | null;
  prev_hash: string;
  hash: string;
};

export type VerifyResult = { ok: true; count: number } | { ok: false; count: number; firstBadSeq: number; reason: string };

const COLUMNS = [
  "seq", "ts", "actor", "event", "tool", "decision", "approval_id",
  "input_hash", "output_hash", "detail_json", "prev_hash", "hash",
] as const;

export function computeRowHash(row: Omit<AuditRow, "hash">): string {
  return sha256Hex(row.prev_hash + canonicalJson(row));
}

export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  append(input: AuditInput): AuditRow {
    // One transaction: read the tip and insert the next link atomically.
    return this.db.transaction((): AuditRow => {
      const tip = this.db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as
        | { seq: number; hash: string }
        | undefined;
      const base: Omit<AuditRow, "hash"> = {
        seq: (tip?.seq ?? 0) + 1,
        ts: this.clock().toISOString(),
        actor: input.actor,
        event: input.event,
        tool: input.tool ?? null,
        decision: input.decision ?? null,
        approval_id: input.approvalId ?? null,
        input_hash: input.inputHash ?? null,
        output_hash: input.outputHash ?? null,
        detail_json: input.detail ? canonicalJson(input.detail) : null,
        prev_hash: tip?.hash ?? GENESIS_HASH,
      };
      const row: AuditRow = { ...base, hash: computeRowHash(base) };
      this.db
        .prepare(`INSERT INTO audit_log (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => "@" + c).join(", ")})`)
        .run(row);
      return row;
    })();
  }

  all(): AuditRow[] {
    return this.db.prepare("SELECT * FROM audit_log ORDER BY seq ASC").all() as AuditRow[];
  }

  verifyChain(): VerifyResult {
    const rows = this.all();
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return { ok: false, count: rows.length, firstBadSeq: expectedSeq, reason: "missing or reordered entry" };
      }
      if (row.prev_hash !== prevHash) {
        return { ok: false, count: rows.length, firstBadSeq: row.seq, reason: "prev_hash does not link to previous entry" };
      }
      const { hash, ...rest } = row;
      if (computeRowHash(rest) !== hash) {
        return { ok: false, count: rows.length, firstBadSeq: row.seq, reason: "entry content does not match its hash" };
      }
      prevHash = hash;
      expectedSeq += 1;
    }
    return { ok: true, count: rows.length };
  }

  exportJson(): string {
    return JSON.stringify(this.all(), null, 2);
  }

  exportCsv(): string {
    const lines = [COLUMNS.join(",")];
    for (const row of this.all()) lines.push(COLUMNS.map((c) => csvCell(row[c])).join(","));
    return lines.join("\n") + "\n";
  }
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  // Quote when needed, and neutralize spreadsheet formula injection.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
