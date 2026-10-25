import type { AuditLog } from "@/audit/log";
import type { Db } from "@/db/db";
import type { Role } from "@/guard/policy";
import type { ExecError, ExecSuccess } from "@/guard/executor";
import type { ActionRunner } from "@/guard/runner";
import { canonicalJson } from "@/lib/hash";
import { newId } from "@/lib/ids";
import type { Clock } from "@/lib/clock";
import { err, ok, type Result } from "@/lib/result";

/**
 * Approval state machine: PENDING -> APPROVED -> EXECUTED | FAILED, or PENDING -> REJECTED | EXPIRED.
 * Exactly-once execution comes from an atomic conditional UPDATE (only one caller can move a row
 * out of PENDING) plus PayPal-Request-Id = approval id. The LLM has no path into this module.
 */

export type ApprovalStatus = "PENDING" | "APPROVED" | "EXECUTED" | "REJECTED" | "FAILED" | "EXPIRED";

export type ApprovalRow = {
  id: string;
  conversation_id: string | null;
  requested_by: string;
  tool: string;
  args_json: string;
  amount_minor: number | null;
  currency: string | null;
  policy_rule: string;
  reason: string | null;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  result_json: string | null;
  created_at: string;
  expires_at: string;
};

export type Actor = { id: string; role: Role };

export type EnqueueInput = {
  requestedBy: string;
  conversationId?: string | null;
  tool: string;
  args: Record<string, unknown>;
  amountMinor: number | null;
  currency: string | null;
  ruleId: string;
  reason: string;
};

export type ApprovalErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN_ROLE"
  | "SELF_APPROVAL"
  | "ALREADY_DECIDED"
  | "EXPIRED"
  | "REASON_REQUIRED";
export type ApprovalError = { code: ApprovalErrorCode; message: string };

export type ApproveOutcome =
  | { status: "EXECUTED"; approvalId: string; result: ExecSuccess }
  | { status: "FAILED"; approvalId: string; error: ExecError };

const DECIDER_ROLES: readonly Role[] = ["approver", "owner"];

export class ApprovalQueue {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly runner: ActionRunner,
    private readonly clock: Clock,
    private readonly ttlHours: number,
  ) {}

  enqueue(input: EnqueueInput): ApprovalRow {
    const now = this.clock();
    const row: ApprovalRow = {
      id: newId("apr"),
      conversation_id: input.conversationId ?? null,
      requested_by: input.requestedBy,
      tool: input.tool,
      args_json: canonicalJson(input.args),
      amount_minor: input.amountMinor,
      currency: input.currency,
      policy_rule: input.ruleId,
      reason: input.reason,
      status: "PENDING",
      decided_by: null,
      decided_at: null,
      decision_note: null,
      result_json: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.ttlHours * 3_600_000).toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO approvals (id, conversation_id, requested_by, tool, args_json, amount_minor, currency, policy_rule, reason, status,
          decided_by, decided_at, decision_note, result_json, created_at, expires_at)
         VALUES (@id, @conversation_id, @requested_by, @tool, @args_json, @amount_minor, @currency, @policy_rule, @reason, @status,
          @decided_by, @decided_at, @decision_note, @result_json, @created_at, @expires_at)`,
      )
      .run(row);
    return row;
  }

  get(id: string): ApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  }

  /** Marks overdue PENDING rows EXPIRED (lazy TTL) and audits each; returns how many expired. */
  expireStale(): number {
    const now = this.clock().toISOString();
    const stale = this.db.prepare("SELECT id, tool FROM approvals WHERE status = 'PENDING' AND expires_at <= ?").all(now) as { id: string; tool: string }[];
    for (const r of stale) {
      const changed = this.db.prepare("UPDATE approvals SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'").run(r.id).changes;
      if (changed === 1) this.audit.append({ actor: "system", event: "EXPIRED", tool: r.tool, approvalId: r.id });
    }
    return stale.length;
  }

  list(status?: ApprovalStatus): ApprovalRow[] {
    return (status
      ? this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC").all(status)
      : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all()) as ApprovalRow[];
  }

  async approve(id: string, actor: Actor, note?: string): Promise<Result<ApproveOutcome, ApprovalError>> {
    // Everything up to the claim runs synchronously, so a concurrent second call sees APPROVED.
    const claimed = this.claim(id, actor, "APPROVED", note ?? null);
    if (!claimed.ok) return claimed;
    const row = claimed.value;

    const result = await this.runner.run({
      tool: row.tool,
      args: JSON.parse(row.args_json) as Record<string, unknown>,
      requestId: row.id,
      requestedBy: row.requested_by,
      actor: actor.id,
      approvalId: row.id,
    });
    const final: ApprovalStatus = result.ok ? "EXECUTED" : "FAILED";
    this.db
      .prepare("UPDATE approvals SET status = ?, result_json = ? WHERE id = ? AND status = 'APPROVED'")
      .run(final, JSON.stringify(result.ok ? result.value.data : result.error), row.id);
    return ok(result.ok ? { status: "EXECUTED", approvalId: row.id, result: result.value } : { status: "FAILED", approvalId: row.id, error: result.error });
  }

  reject(id: string, actor: Actor, reason: string): Result<ApprovalRow, ApprovalError> {
    if (!reason || reason.trim() === "") return this.refuse(id, actor, { code: "REASON_REQUIRED", message: "A rejection needs a reason." });
    return this.claim(id, actor, "REJECTED", reason.trim());
  }

  /** Atomically moves a PENDING row to APPROVED/REJECTED after all authorization checks. */
  private claim(id: string, actor: Actor, to: "APPROVED" | "REJECTED", note: string | null): Result<ApprovalRow, ApprovalError> {
    const row = this.get(id);
    if (!row) return this.refuse(id, actor, { code: "NOT_FOUND", message: "Approval not found." });
    if (!DECIDER_ROLES.includes(actor.role)) {
      return this.refuse(id, actor, { code: "FORBIDDEN_ROLE", message: "Only an approver or owner can decide." });
    }
    if (row.requested_by === actor.id) {
      return this.refuse(id, actor, { code: "SELF_APPROVAL", message: "You cannot decide on your own request." });
    }
    const now = this.clock();
    if (row.status === "PENDING" && now.toISOString() >= row.expires_at) {
      this.db.prepare("UPDATE approvals SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'").run(id);
      return this.refuse(id, actor, { code: "EXPIRED", message: "This approval has expired." });
    }
    const changed = this.db
      .prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'PENDING'")
      .run(to, actor.id, now.toISOString(), note, id).changes;
    if (changed !== 1) {
      return this.refuse(id, actor, { code: row.status === "EXPIRED" ? "EXPIRED" : "ALREADY_DECIDED", message: "This approval was already decided." });
    }
    this.audit.append({ actor: actor.id, event: to, tool: row.tool, approvalId: id, detail: { note } });
    return ok({ ...row, status: to, decided_by: actor.id, decided_at: now.toISOString(), decision_note: note });
  }

  private refuse(id: string, actor: Actor, error: ApprovalError): Result<never, ApprovalError> {
    this.audit.append({ actor: actor.id, event: "APPROVAL_REFUSED", approvalId: id, detail: { code: error.code } });
    return err(error);
  }
}
