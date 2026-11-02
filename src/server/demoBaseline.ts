import type { ApprovalRow } from "@/approvals/queue";
import { computeRowHash, GENESIS_HASH, type AuditRow } from "@/audit/log";
import type { Db } from "@/db/db";
import type { ExecutionRow, PayPalObject } from "@/db/store";
import { canonicalJson } from "@/lib/hash";

/**
 * Static demo dataset shown to every fresh mock-mode visitor. Loaded into the in-memory DB on
 * each request; never written to cookies. Cookie state is only the visitor's delta on top.
 *
 * IDs are stable so a decision on `apr_demo_*` can round-trip across serverless instances.
 */

const CLERK = "u_clerk";
const MANAGER = "u_manager";
const CREATED = "2026-11-01T08:00:00.000Z";
const EXPIRES = "2027-12-31T00:00:00.000Z"; // far enough that expireStale() will not hide the samples
const DAY_KEY = "2026-10-31"; // past Amman day, so today's daily cap starts empty for the visitor

const refundArgs = (captureId: string, value: string, note?: string) =>
  canonicalJson({ capture_id: captureId, amount: { currency_code: "USD", value }, ...(note ? { note } : {}) });

function approval(partial: Omit<ApprovalRow, "currency" | "expires_at" | "conversation_id"> & { conversation_id?: null }): ApprovalRow {
  return { currency: "USD", expires_at: EXPIRES, conversation_id: null, ...partial };
}

/** 3 pending + 1 already-executed + 1 already-rejected. Denied/auto-approved items live in the audit trail. */
export const BASELINE_APPROVALS: readonly ApprovalRow[] = [
  approval({
    id: "apr_demo_pending_transit", requested_by: CLERK, tool: "create_refund",
    args_json: refundArgs("7NR50183HB2241519", "70.00", "Damaged in transit"),
    amount_minor: 7000, policy_rule: "refund-large", reason: "Refunds above $50 need a manager.",
    status: "PENDING", decided_by: null, decided_at: null, decision_note: null, result_json: null,
    created_at: "2026-11-01T08:20:00.000Z",
  }),
  approval({
    id: "apr_demo_pending_return", requested_by: CLERK, tool: "create_refund",
    args_json: refundArgs("4KX31962MV6619203", "60.00", "Customer returned the item"),
    amount_minor: 6000, policy_rule: "refund-large", reason: "Refunds above $50 need a manager.",
    status: "PENDING", decided_by: null, decided_at: null, decision_note: null, result_json: null,
    created_at: "2026-11-01T08:25:00.000Z",
  }),
  approval({
    id: "apr_demo_pending_late", requested_by: CLERK, tool: "create_refund",
    args_json: refundArgs("9TW04187LK2930028", "80.00", "Arrived two weeks late"),
    amount_minor: 8000, policy_rule: "refund-large", reason: "Refunds above $50 need a manager.",
    status: "PENDING", decided_by: null, decided_at: null, decision_note: null, result_json: null,
    created_at: "2026-11-01T08:30:00.000Z",
  }),
  approval({
    id: "apr_demo_done_damage", requested_by: CLERK, tool: "create_refund",
    args_json: refundArgs("2GG279541U471931P", "120.00", "Damaged in transit"),
    amount_minor: 12000, policy_rule: "refund-large", reason: "Refunds above $50 need a manager.",
    status: "EXECUTED", decided_by: MANAGER, decided_at: "2026-11-01T08:12:00.000Z",
    decision_note: "Verified with the customer by phone.",
    result_json: canonicalJson({ id: "MOCKREFUND_DEMO_DAMAGE", status: "COMPLETED" }),
    created_at: "2026-11-01T08:10:00.000Z",
  }),
  approval({
    id: "apr_demo_rejected_unreturned", requested_by: CLERK, tool: "create_refund",
    args_json: refundArgs("7NR50183HB2241519", "80.00"),
    amount_minor: 8000, policy_rule: "refund-large", reason: "Refunds above $50 need a manager.",
    status: "REJECTED", decided_by: MANAGER, decided_at: "2026-11-01T08:16:00.000Z",
    decision_note: "Item not returned yet. Ask for the return tracking number first.",
    result_json: null, created_at: "2026-11-01T08:15:00.000Z",
  }),
];

export const BASELINE_EXECUTIONS: readonly ExecutionRow[] = [
  {
    id: "exe_demo_small", approval_id: null, requested_by: CLERK, tool: "create_refund",
    target_id: "8MC585209K746392H", amount_minor: 1500, currency: "USD", status: "EXECUTED",
    day_key: DAY_KEY, created_at: "2026-11-01T08:00:30.000Z",
  },
  {
    id: "exe_demo_damage", approval_id: "apr_demo_done_damage", requested_by: CLERK, tool: "create_refund",
    target_id: "2GG279541U471931P", amount_minor: 12000, currency: "USD", status: "EXECUTED",
    day_key: DAY_KEY, created_at: "2026-11-01T08:12:05.000Z",
  },
];

export const BASELINE_PAYPAL_OBJECTS: readonly PayPalObject[] = [
  {
    id: "MOCKREFUND_DEMO_SMALL", kind: "refund", status: "COMPLETED", amount_minor: 1500, currency: "USD",
    created_by_payguard: 1, raw_json: canonicalJson({ id: "MOCKREFUND_DEMO_SMALL", status: "COMPLETED" }),
    updated_at: "2026-11-01T08:00:30.000Z",
  },
  {
    id: "MOCKREFUND_DEMO_DAMAGE", kind: "refund", status: "COMPLETED", amount_minor: 12000, currency: "USD",
    created_by_payguard: 1, raw_json: canonicalJson({ id: "MOCKREFUND_DEMO_DAMAGE", status: "COMPLETED" }),
    updated_at: "2026-11-01T08:12:05.000Z",
  },
];

type AuditDraft = Omit<AuditRow, "seq" | "prev_hash" | "hash">;

const detail = (obj: Record<string, unknown>) => canonicalJson(obj);

function chain(entries: AuditDraft[]): AuditRow[] {
  let prev = GENESIS_HASH;
  return entries.map((e, i) => {
    const base: Omit<AuditRow, "hash"> = { ...e, seq: i + 1, prev_hash: prev };
    const row: AuditRow = { ...base, hash: computeRowHash(base) };
    prev = row.hash;
    return row;
  });
}

/** Matching hash-chained audit trail: auto-allow, deny (injection), queued, approved, rejected. */
export const BASELINE_AUDIT: readonly AuditRow[] = chain([
  { ts: CREATED, actor: CLERK, event: "PROPOSED", tool: "create_refund", decision: null, approval_id: null, input_hash: null, output_hash: null, detail_json: detail({ args: { capture_id: "8MC585209K746392H", amount: { currency_code: "USD", value: "15.00" } } }) },
  { ts: "2026-11-01T08:00:01.000Z", actor: CLERK, event: "ALLOWED", tool: "create_refund", decision: "ALLOW", approval_id: null, input_hash: null, output_hash: null, detail_json: detail({ ruleId: "refund-small" }) },
  { ts: "2026-11-01T08:00:30.000Z", actor: CLERK, event: "EXECUTED", tool: "create_refund", decision: null, approval_id: null, input_hash: null, output_hash: null, detail_json: detail({ requestId: "exe_demo_small" }) },
  { ts: "2026-11-01T08:05:00.000Z", actor: CLERK, event: "PROPOSED", tool: "create_refund", decision: null, approval_id: null, input_hash: null, output_hash: null, detail_json: detail({ args: { capture_id: "9TW04187LK2930028", amount: { currency_code: "USD", value: "900.00" } } }) },
  { ts: "2026-11-01T08:05:01.000Z", actor: CLERK, event: "DENIED", tool: "create_refund", decision: "DENY", approval_id: null, input_hash: null, output_hash: null, detail_json: detail({ ruleId: "UNTRUSTED_SOURCE", reason: "Untrusted customer text cannot be the source of a refund amount or id." }) },
  { ts: "2026-11-01T08:10:00.000Z", actor: CLERK, event: "PROPOSED", tool: "create_refund", decision: null, approval_id: "apr_demo_done_damage", input_hash: null, output_hash: null, detail_json: null },
  { ts: "2026-11-01T08:10:01.000Z", actor: CLERK, event: "QUEUED", tool: "create_refund", decision: "REQUIRE_APPROVAL", approval_id: "apr_demo_done_damage", input_hash: null, output_hash: null, detail_json: detail({ ruleId: "refund-large", reason: "Refunds above $50 need a manager." }) },
  { ts: "2026-11-01T08:12:00.000Z", actor: MANAGER, event: "APPROVED", tool: "create_refund", decision: null, approval_id: "apr_demo_done_damage", input_hash: null, output_hash: null, detail_json: detail({ note: "Verified with the customer by phone." }) },
  { ts: "2026-11-01T08:12:05.000Z", actor: MANAGER, event: "EXECUTED", tool: "create_refund", decision: null, approval_id: "apr_demo_done_damage", input_hash: null, output_hash: null, detail_json: detail({ requestId: "exe_demo_damage" }) },
  { ts: "2026-11-01T08:15:00.000Z", actor: CLERK, event: "PROPOSED", tool: "create_refund", decision: null, approval_id: "apr_demo_rejected_unreturned", input_hash: null, output_hash: null, detail_json: null },
  { ts: "2026-11-01T08:15:01.000Z", actor: CLERK, event: "QUEUED", tool: "create_refund", decision: "REQUIRE_APPROVAL", approval_id: "apr_demo_rejected_unreturned", input_hash: null, output_hash: null, detail_json: detail({ ruleId: "refund-large" }) },
  { ts: "2026-11-01T08:16:00.000Z", actor: MANAGER, event: "REJECTED", tool: "create_refund", decision: null, approval_id: "apr_demo_rejected_unreturned", input_hash: null, output_hash: null, detail_json: detail({ note: "Item not returned yet. Ask for the return tracking number first." }) },
  { ts: "2026-11-01T08:20:00.000Z", actor: CLERK, event: "PROPOSED", tool: "create_refund", decision: null, approval_id: "apr_demo_pending_transit", input_hash: null, output_hash: null, detail_json: null },
  { ts: "2026-11-01T08:20:01.000Z", actor: CLERK, event: "QUEUED", tool: "create_refund", decision: "REQUIRE_APPROVAL", approval_id: "apr_demo_pending_transit", input_hash: null, output_hash: null, detail_json: detail({ ruleId: "refund-large", reason: "Refunds above $50 need a manager." }) },
  { ts: "2026-11-01T08:25:00.000Z", actor: CLERK, event: "PROPOSED", tool: "create_refund", decision: null, approval_id: "apr_demo_pending_return", input_hash: null, output_hash: null, detail_json: null },
  { ts: "2026-11-01T08:25:01.000Z", actor: CLERK, event: "QUEUED", tool: "create_refund", decision: "REQUIRE_APPROVAL", approval_id: "apr_demo_pending_return", input_hash: null, output_hash: null, detail_json: detail({ ruleId: "refund-large" }) },
  { ts: "2026-11-01T08:30:00.000Z", actor: CLERK, event: "PROPOSED", tool: "create_refund", decision: null, approval_id: "apr_demo_pending_late", input_hash: null, output_hash: null, detail_json: null },
  { ts: "2026-11-01T08:30:01.000Z", actor: CLERK, event: "QUEUED", tool: "create_refund", decision: "REQUIRE_APPROVAL", approval_id: "apr_demo_pending_late", input_hash: null, output_hash: null, detail_json: detail({ ruleId: "refund-large" }) },
]);

export const BASELINE_APPROVAL_IDS: ReadonlySet<string> = new Set(BASELINE_APPROVALS.map((a) => a.id));
export const BASELINE_EXECUTION_IDS: ReadonlySet<string> = new Set(BASELINE_EXECUTIONS.map((e) => e.id));
export const BASELINE_PAYPAL_IDS: ReadonlySet<string> = new Set(BASELINE_PAYPAL_OBJECTS.map((o) => o.id));
export const BASELINE_AUDIT_MAX_SEQ = BASELINE_AUDIT.length;

export function isBaselineApprovalId(id: string): boolean {
  return BASELINE_APPROVAL_IDS.has(id);
}

/** Inserts the static baseline into an empty (migrated + users-seeded) database. */
export function insertDemoBaseline(db: Db): void {
  const appr = db.prepare(
    `INSERT INTO approvals (id, conversation_id, requested_by, tool, args_json, amount_minor, currency,
      policy_rule, reason, status, decided_by, decided_at, decision_note, result_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of BASELINE_APPROVALS) {
    appr.run(a.id, a.conversation_id, a.requested_by, a.tool, a.args_json, a.amount_minor, a.currency,
      a.policy_rule, a.reason, a.status, a.decided_by, a.decided_at, a.decision_note, a.result_json,
      a.created_at, a.expires_at);
  }

  const exec = db.prepare(
    "INSERT INTO executions (id, approval_id, requested_by, tool, target_id, amount_minor, currency, status, day_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const e of BASELINE_EXECUTIONS) {
    exec.run(e.id, e.approval_id, e.requested_by, e.tool, e.target_id, e.amount_minor, e.currency, e.status, e.day_key, e.created_at);
  }

  const obj = db.prepare(
    "INSERT INTO paypal_objects (id, kind, status, amount_minor, currency, created_by_payguard, raw_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const o of BASELINE_PAYPAL_OBJECTS) {
    obj.run(o.id, o.kind, o.status, o.amount_minor, o.currency, o.created_by_payguard, o.raw_json, o.updated_at);
  }

  const audit = db.prepare(
    `INSERT INTO audit_log (seq, ts, actor, event, tool, decision, approval_id, input_hash, output_hash, detail_json, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of BASELINE_AUDIT) {
    audit.run(r.seq, r.ts, r.actor, r.event, r.tool, r.decision, r.approval_id, r.input_hash, r.output_hash, r.detail_json, r.prev_hash, r.hash);
  }
}
