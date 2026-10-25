import type { Db } from "./db";

/** Small typed data-access layer over the tables the guard reads for policy facts. */

export type PayPalObject = {
  id: string;
  kind: "order" | "capture" | "refund";
  status: string | null;
  amount_minor: number | null;
  currency: string | null;
  created_by_payguard: number;
  raw_json: string | null;
  updated_at: string;
};

export type ExecutionRow = {
  id: string;
  approval_id: string | null;
  requested_by: string;
  tool: string;
  target_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  status: "EXECUTED" | "FAILED";
  day_key: string;
  created_at: string;
};

export class Store {
  constructor(readonly db: Db) {}

  recordExecution(row: ExecutionRow): void {
    this.db
      .prepare(
        `INSERT INTO executions (id, approval_id, requested_by, tool, target_id, amount_minor, currency, status, day_key, created_at)
         VALUES (@id, @approval_id, @requested_by, @tool, @target_id, @amount_minor, @currency, @status, @day_key, @created_at)`,
      )
      .run(row);
  }

  dailyTotalMinor(tool: string, dayKey: string): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(amount_minor), 0) AS total FROM executions WHERE tool = ? AND day_key = ? AND status = 'EXECUTED'")
      .get(tool, dayKey) as { total: number };
    return r.total;
  }

  refundedMinorForCapture(captureId: string): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(amount_minor), 0) AS total FROM executions WHERE tool = 'create_refund' AND target_id = ? AND status = 'EXECUTED'")
      .get(captureId) as { total: number };
    return r.total;
  }

  /** Amounts of PayPal objects the tool layer has seen (orders, captures): trusted amount sources. */
  knownAmountsMinor(): Set<number> {
    const rows = this.db.prepare("SELECT DISTINCT amount_minor FROM paypal_objects WHERE amount_minor IS NOT NULL AND kind IN ('order','capture')").all() as { amount_minor: number }[];
    return new Set(rows.map((r) => r.amount_minor));
  }

  getObject(id: string): PayPalObject | undefined {
    return this.db.prepare("SELECT * FROM paypal_objects WHERE id = ?").get(id) as PayPalObject | undefined;
  }

  upsertObject(o: PayPalObject): void {
    this.db
      .prepare(
        `INSERT INTO paypal_objects (id, kind, status, amount_minor, currency, created_by_payguard, raw_json, updated_at)
         VALUES (@id, @kind, @status, @amount_minor, @currency, @created_by_payguard, @raw_json, @updated_at)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status,
           amount_minor = COALESCE(excluded.amount_minor, paypal_objects.amount_minor),
           currency = COALESCE(excluded.currency, paypal_objects.currency),
           created_by_payguard = MAX(paypal_objects.created_by_payguard, excluded.created_by_payguard),
           raw_json = excluded.raw_json, updated_at = excluded.updated_at`,
      )
      .run(o);
  }
}
