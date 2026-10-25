import type { Actor, ApprovalQueue } from "@/approvals/queue";
import type { AuditLog } from "@/audit/log";
import type { Store } from "@/db/store";
import { dayKey, type Clock } from "@/lib/clock";
import { hashJson } from "@/lib/hash";
import { newId } from "@/lib/ids";
import type { ExecError } from "./executor";
import type { Policy } from "./policy";
import { evaluate, type CallFacts, type Provenance } from "./policyEngine";
import type { ActionRunner } from "./runner";
import { describeArgIssues } from "./argFeedback";
import { extractCaptureId, extractMoneyFacts, extractOrderId } from "./toolArgs";

/**
 * Every tool call the agent proposes passes through here: gather facts -> evaluate policy ->
 * execute, queue for approval, or deny. Each step lands in the audit log.
 * Outcomes are plain JSON so they can be returned to the LLM as the tool result.
 */

export type GuardRequest = {
  actor: Actor;
  conversationId?: string | null;
  tool: string;
  args: Record<string, unknown>;
  provenance: Provenance;
  /** Changes made by argument normalization before the guard saw the call (audited). */
  normalized?: string[];
};

export type GuardOutcome =
  | { status: "executed"; tool: string; requestId: string; data: unknown }
  | { status: "failed"; tool: string; requestId: string; error: ExecError }
  | { status: "pending_approval"; tool: string; approvalId: string; ruleId: string; reason: string }
  | { status: "denied"; tool: string; ruleId: string; reason: string; issues?: string[] };

export type GuardDeps = {
  policy: Policy;
  store: Store;
  audit: AuditLog;
  runner: ActionRunner;
  approvals: ApprovalQueue;
  clock: Clock;
};

export class PolicyGuard {
  constructor(private readonly deps: GuardDeps) {}

  async handle(req: GuardRequest): Promise<GuardOutcome> {
    const { policy, audit, runner, approvals } = this.deps;
    const inputHash = hashJson({ tool: req.tool, args: req.args });
    audit.append({ actor: req.actor.id, event: "PROPOSED", tool: req.tool, inputHash, detail: { args: req.args, provenance: req.provenance, ...(req.normalized?.length ? { normalized: req.normalized } : {}) } });

    const money = extractMoneyFacts(req.tool, req.args);
    if (!money.ok) {
      // Short reason for the UI and audit; the detailed issues go back to the model so it can self-correct.
      const reason = `${req.tool} arguments are invalid`;
      const issues = describeArgIssues(req.tool, req.args);
      audit.append({ actor: req.actor.id, event: "DENIED", tool: req.tool, decision: "DENY", inputHash, detail: { ruleId: "INVALID_ARGS", reason, issues } });
      return { status: "denied", tool: req.tool, ruleId: "INVALID_ARGS", reason, issues };
    }

    const facts = this.gatherFacts(req, money.value.amountMinor, money.value.currency);
    const decision = evaluate(policy, facts);
    const event = decision.decision === "ALLOW" ? "ALLOWED" : decision.decision === "DENY" ? "DENIED" : "QUEUED";

    if (decision.decision === "DENY") {
      audit.append({ actor: req.actor.id, event, tool: req.tool, decision: decision.decision, inputHash, detail: { ruleId: decision.ruleId, reason: decision.reason } });
      return { status: "denied", tool: req.tool, ruleId: decision.ruleId, reason: decision.reason };
    }

    if (decision.decision === "REQUIRE_APPROVAL") {
      const row = approvals.enqueue({
        requestedBy: req.actor.id, conversationId: req.conversationId ?? null, tool: req.tool, args: req.args,
        amountMinor: facts.amountMinor, currency: facts.currency, ruleId: decision.ruleId, reason: decision.reason,
      });
      audit.append({ actor: req.actor.id, event, tool: req.tool, decision: decision.decision, approvalId: row.id, inputHash, detail: { ruleId: decision.ruleId, reason: decision.reason } });
      return { status: "pending_approval", tool: req.tool, approvalId: row.id, ruleId: decision.ruleId, reason: decision.reason };
    }

    const requestId = newId("exe");
    audit.append({ actor: req.actor.id, event, tool: req.tool, decision: decision.decision, inputHash, detail: { ruleId: decision.ruleId, requestId } });
    const result = await runner.run({ tool: req.tool, args: req.args, requestId, requestedBy: req.actor.id, actor: req.actor.id });
    return result.ok
      ? { status: "executed", tool: req.tool, requestId, data: result.value.data }
      : { status: "failed", tool: req.tool, requestId, error: result.error };
  }

  private gatherFacts(req: GuardRequest, amountMinor: number | null, currency: string | null): CallFacts {
    const { store, policy, clock } = this.deps;
    const facts: CallFacts = {
      tool: req.tool,
      role: req.actor.role,
      amountMinor,
      currency,
      provenance: req.provenance,
      dailyRefundTotalMinor: store.dailyTotalMinor("create_refund", dayKey(clock(), policy.timezone)),
    };
    if (req.tool === "pay_order") {
      // The capture amount comes from PayGuard's own record of the order, never from the model.
      const orderId = extractOrderId(req.args);
      const order = orderId ? store.getObject(orderId) : undefined;
      facts.orderCreatedByPayguard = order?.created_by_payguard === 1;
      facts.amountMinor = order?.amount_minor ?? null;
      facts.currency = order?.currency ?? null;
    }
    if (req.tool === "create_refund") {
      const captureId = extractCaptureId(req.args);
      const capture = captureId ? store.getObject(captureId) : undefined;
      if (captureId && capture?.amount_minor != null) {
        facts.refundableRemainingMinor = capture.amount_minor - store.refundedMinorForCapture(captureId);
      }
    }
    return facts;
  }
}
