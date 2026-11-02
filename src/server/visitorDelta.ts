import type { ApprovalRow } from "@/approvals/queue";
import type { Db } from "@/db/db";
import {
  BASELINE_APPROVAL_IDS,
  BASELINE_APPROVALS,
  BASELINE_AUDIT_MAX_SEQ,
  BASELINE_EXECUTION_IDS,
  BASELINE_PAYPAL_IDS,
} from "./demoBaseline";
import { DEMO_CAPTURES } from "./runtime";
import { exportState } from "./stateSync";
import {
  decodeJsonChunks,
  encodeJsonChunks,
  MAX_COOKIE_CHUNKS,
  VisitorDeltaSchema,
  type VisitorDelta,
  type VisitorDecision,
} from "./visitorState";

export function encodeDelta(delta: VisitorDelta): string[] {
  return encodeJsonChunks(delta);
}

export function decodeDelta(chunks: string[]): VisitorDelta {
  return VisitorDeltaSchema.parse(decodeJsonChunks(chunks));
}

export function isEmptyDelta(delta: VisitorDelta): boolean {
  return delta.decisions.length === 0
    && delta.approvals.length === 0
    && delta.audit.length === 0
    && delta.executions.length === 0
    && delta.paypal_objects.length === 0
    && delta.conversations.length === 0
    && delta.messages.length === 0
    && delta.chat_turns.length === 0;
}

const DEMO_CAPTURE_IDS: ReadonlySet<string> = new Set(DEMO_CAPTURES.map((c) => c.id));

/** Keep only recent chat so the cookie cannot grow without bound. */
export const MAX_COOKIE_MESSAGES = 12;
const MESSAGE_KEEP_STEPS = [12, 6, 3, 0] as const;

const byCreated = <T extends { created_at: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));

function capChat(delta: VisitorDelta, keep: number): VisitorDelta {
  if (keep === 0) {
    return { ...delta, conversations: [], messages: [], chat_turns: [] };
  }
  // Drop whole messages only — content is JSON and must stay parseable.
  const messages = byCreated(delta.messages).slice(-keep);
  const convIds = new Set(messages.map((m) => m.conversation_id));
  const conversations = delta.conversations.filter((c) => convIds.has(c.id));
  const turns = byCreated(delta.chat_turns).filter((t) => convIds.has(t.conversation_id)).slice(-keep);
  return { ...delta, conversations, messages, chat_turns: turns };
}

function baselineOf(id: string): ApprovalRow | undefined {
  return BASELINE_APPROVALS.find((a) => a.id === id);
}

function decisionIfChanged(row: ApprovalRow): VisitorDecision | null {
  const base = baselineOf(row.id);
  if (!base) return null;
  if (
    row.status === base.status
    && row.decided_by === base.decided_by
    && row.decided_at === base.decided_at
    && row.decision_note === base.decision_note
    && row.result_json === base.result_json
  ) return null;
  return {
    id: row.id,
    status: row.status,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    decision_note: row.decision_note,
    result_json: row.result_json,
  };
}

/** Snapshot of visitor-owned rows + decisions on seeded ids. Baseline rows are omitted. */
export function exportDelta(db: Db): VisitorDelta {
  const full = exportState(db);
  const decisions = full.approvals
    .map(decisionIfChanged)
    .filter((d): d is VisitorDecision => d !== null);
  return capChat({
    version: 2,
    decisions,
    approvals: full.approvals.filter((a) => !BASELINE_APPROVAL_IDS.has(a.id)),
    audit: full.audit.filter((r) => r.seq > BASELINE_AUDIT_MAX_SEQ),
    executions: full.executions.filter((e) => !BASELINE_EXECUTION_IDS.has(e.id)),
    paypal_objects: full.paypal_objects.filter((o) => !BASELINE_PAYPAL_IDS.has(o.id) && !DEMO_CAPTURE_IDS.has(o.id)),
    conversations: full.conversations,
    messages: full.messages,
    chat_turns: full.chat_turns,
  }, MAX_COOKIE_MESSAGES);
}

/** Shrink chat until the encoded cookie fits in MAX_COOKIE_CHUNKS, then encode. */
export function encodeDeltaWithinBudget(delta: VisitorDelta): string[] {
  for (const keep of MESSAGE_KEEP_STEPS) {
    const current = capChat(delta, keep);
    const chunks = encodeDelta(current);
    if (chunks.length <= MAX_COOKIE_CHUNKS) return chunks;
  }
  return encodeDelta({ ...delta, conversations: [], messages: [], chat_turns: [] });
}

/**
 * Overlays a cookie delta onto a DB that already has the static baseline.
 * Does not delete baseline rows (unlike importState).
 */
export function applyDelta(db: Db, delta: VisitorDelta): void {
  db.transaction(() => {
    const conv = db.prepare("INSERT OR IGNORE INTO conversations (id, user_id, created_at, lang) VALUES (?, ?, ?, ?)");
    for (const c of delta.conversations) conv.run(c.id, c.user_id, c.created_at, c.lang);

    const msg = db.prepare(
      "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const m of delta.messages) msg.run(m.id, m.conversation_id, m.role, m.content, m.provenance, m.created_at);

    const turn = db.prepare(
      "INSERT OR IGNORE INTO chat_turns (id, conversation_id, user_id, status, stopped_at_limit, error_code, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const t of delta.chat_turns) {
      turn.run(t.id, t.conversation_id, t.user_id, t.status, t.stopped_at_limit, t.error_code, t.created_at, t.finished_at);
    }

    const obj = db.prepare(
      "INSERT OR IGNORE INTO paypal_objects (id, kind, status, amount_minor, currency, created_by_payguard, raw_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const o of delta.paypal_objects) {
      obj.run(o.id, o.kind, o.status, o.amount_minor, o.currency, o.created_by_payguard, o.raw_json, o.updated_at);
    }

    const appr = db.prepare(
      `INSERT OR IGNORE INTO approvals (id, conversation_id, requested_by, tool, args_json, amount_minor, currency,
        policy_rule, reason, status, decided_by, decided_at, decision_note, result_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of delta.approvals) {
      appr.run(
        a.id, a.conversation_id, a.requested_by, a.tool, a.args_json, a.amount_minor, a.currency,
        a.policy_rule, a.reason, a.status, a.decided_by, a.decided_at, a.decision_note, a.result_json,
        a.created_at, a.expires_at,
      );
    }

    const upd = db.prepare(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, result_json = ? WHERE id = ?",
    );
    for (const d of delta.decisions) {
      upd.run(d.status, d.decided_by, d.decided_at, d.decision_note, d.result_json, d.id);
    }

    const exec = db.prepare(
      "INSERT OR IGNORE INTO executions (id, approval_id, requested_by, tool, target_id, amount_minor, currency, status, day_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of delta.executions) {
      exec.run(e.id, e.approval_id, e.requested_by, e.tool, e.target_id, e.amount_minor, e.currency, e.status, e.day_key, e.created_at);
    }

    const audit = db.prepare(
      `INSERT OR IGNORE INTO audit_log (seq, ts, actor, event, tool, decision, approval_id, input_hash,
        output_hash, detail_json, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of delta.audit) {
      audit.run(
        r.seq, r.ts, r.actor, r.event, r.tool, r.decision, r.approval_id, r.input_hash,
        r.output_hash, r.detail_json, r.prev_hash, r.hash,
      );
    }
  })();
}

