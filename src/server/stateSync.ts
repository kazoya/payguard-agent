import type { Db } from "@/db/db";
import type { VisitorState } from "./visitorState";

/**
 * Exports the current database state to a VisitorState object.
 */
export function exportState(db: Db): VisitorState {
  const approvals = db.prepare("SELECT * FROM approvals ORDER BY created_at").all() as VisitorState["approvals"];
  const audit = db.prepare("SELECT * FROM audit_log ORDER BY seq").all() as VisitorState["audit"];
  const executions = db.prepare("SELECT * FROM executions ORDER BY created_at").all() as VisitorState["executions"];
  const paypal_objects = db.prepare("SELECT * FROM paypal_objects ORDER BY updated_at").all() as VisitorState["paypal_objects"];
  const conversations = db.prepare("SELECT * FROM conversations ORDER BY created_at").all() as VisitorState["conversations"];
  const messages = db.prepare("SELECT * FROM messages ORDER BY created_at").all() as VisitorState["messages"];
  const chat_turns = db.prepare("SELECT * FROM chat_turns ORDER BY created_at").all() as VisitorState["chat_turns"];

  return {
    version: 1,
    approvals,
    audit,
    executions,
    paypal_objects,
    conversations,
    messages,
    chat_turns,
  };
}

/**
 * Imports a VisitorState into a fresh database. Assumes the database is empty or freshly migrated.
 */
export function importState(db: Db, state: VisitorState): void {
  db.transaction(() => {
    // Clear existing data (in case not empty)
    db.prepare("DELETE FROM chat_turns").run();
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM conversations").run();
    db.prepare("DELETE FROM paypal_objects").run();
    db.prepare("DELETE FROM executions").run();
    
    // We can't delete from audit_log due to triggers, so we'll just append
    // For approvals, we can clear and re-insert
    db.prepare("DELETE FROM approvals").run();

    // Import conversations
    const convStmt = db.prepare(
      "INSERT INTO conversations (id, user_id, created_at, lang) VALUES (?, ?, ?, ?)"
    );
    for (const c of state.conversations) {
      convStmt.run(c.id, c.user_id, c.created_at, c.lang);
    }

    // Import messages
    const msgStmt = db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const m of state.messages) {
      msgStmt.run(m.id, m.conversation_id, m.role, m.content, m.provenance, m.created_at);
    }

    // Import chat_turns
    const turnStmt = db.prepare(
      "INSERT INTO chat_turns (id, conversation_id, user_id, status, stopped_at_limit, error_code, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const t of state.chat_turns) {
      turnStmt.run(t.id, t.conversation_id, t.user_id, t.status, t.stopped_at_limit, t.error_code, t.created_at, t.finished_at);
    }

    // Import paypal_objects
    const objStmt = db.prepare(
      "INSERT INTO paypal_objects (id, kind, status, amount_minor, currency, created_by_payguard, raw_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const o of state.paypal_objects) {
      objStmt.run(o.id, o.kind, o.status, o.amount_minor, o.currency, o.created_by_payguard, o.raw_json, o.updated_at);
    }

    // Import approvals BEFORE executions (executions references approvals)
    const apprStmt = db.prepare(
      `INSERT INTO approvals (id, conversation_id, requested_by, tool, args_json, amount_minor, currency, 
        policy_rule, reason, status, decided_by, decided_at, decision_note, result_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const a of state.approvals) {
      apprStmt.run(
        a.id, a.conversation_id, a.requested_by, a.tool, a.args_json, a.amount_minor, a.currency,
        a.policy_rule, a.reason, a.status, a.decided_by, a.decided_at, a.decision_note, a.result_json,
        a.created_at, a.expires_at
      );
    }

    // Import executions (after approvals since it references them)
    const execStmt = db.prepare(
      "INSERT INTO executions (id, approval_id, requested_by, tool, target_id, amount_minor, currency, status, day_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const e of state.executions) {
      execStmt.run(e.id, e.approval_id, e.requested_by, e.tool, e.target_id, e.amount_minor, e.currency, e.status, e.day_key, e.created_at);
    }

    // Import audit log - we need to disable triggers temporarily
    // Since triggers prevent DELETE/UPDATE, we work around by inserting with specific seq values
    // But first, check if audit already has entries
    const existingAudit = (db.prepare("SELECT COUNT(*) as count FROM audit_log").get() as { count: number }).count;
    
    if (existingAudit === 0 && state.audit.length > 0) {
      // Only import if audit log is empty
      const auditStmt = db.prepare(
        `INSERT INTO audit_log (seq, ts, actor, event, tool, decision, approval_id, input_hash, 
          output_hash, detail_json, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const a of state.audit) {
        auditStmt.run(
          a.seq, a.ts, a.actor, a.event, a.tool, a.decision, a.approval_id, a.input_hash,
          a.output_hash, a.detail_json, a.prev_hash, a.hash
        );
      }
    }
  })();
}
