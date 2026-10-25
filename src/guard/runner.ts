import { z } from "zod";
import type { AuditLog } from "@/audit/log";
import type { Store } from "@/db/store";
import { dayKey, type Clock } from "@/lib/clock";
import { hashJson } from "@/lib/hash";
import { parseMoneyToMinor } from "@/lib/money";
import type { Result } from "@/lib/result";
import type { ExecError, ExecSuccess, Executor } from "./executor";
import { extractCaptureId, extractMoneyFacts, extractOrderId } from "./toolArgs";

/**
 * Runs one action that the guard or an approver already cleared: calls the executor, records the
 * execution (daily caps, refund totals), tracks PayPal objects and appends EXECUTED/FAILED to the audit.
 */

export type RunRequest = {
  tool: string;
  args: Record<string, unknown>;
  /** Sent as PayPal-Request-Id; equals the approval id for approved actions. */
  requestId: string;
  requestedBy: string;
  actor: string;
  approvalId?: string | null;
};

export type RunnerDeps = { store: Store; audit: AuditLog; executor: Executor; clock: Clock; timeZone: string };

const CaptureList = z.object({
  id: z.string(),
  status: z.string().optional(),
  purchase_units: z
    .array(
      z.object({
        payments: z
          .object({
            captures: z
              .array(z.object({ id: z.string(), status: z.string().optional(), amount: z.object({ value: z.string(), currency_code: z.string() }).optional() }))
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});
const WithId = z.object({ id: z.string(), status: z.string().optional() });

export class ActionRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async run(req: RunRequest): Promise<Result<ExecSuccess, ExecError>> {
    const { store, audit, executor, clock, timeZone } = this.deps;
    const result = await executor.execute({ tool: req.tool, args: req.args, requestId: req.requestId });
    const now = clock();
    const facts = extractMoneyFacts(req.tool, req.args);
    const money = facts.ok ? facts.value : { amountMinor: null, currency: null };
    const targetId = req.tool === "create_refund" ? extractCaptureId(req.args) : req.tool === "pay_order" ? extractOrderId(req.args) : null;

    store.recordExecution({
      id: req.requestId,
      approval_id: req.approvalId ?? null,
      requested_by: req.requestedBy,
      tool: req.tool,
      target_id: targetId,
      amount_minor: money.amountMinor,
      currency: money.currency,
      status: result.ok ? "EXECUTED" : "FAILED",
      day_key: dayKey(now, timeZone),
      created_at: now.toISOString(),
    });

    if (result.ok) {
      this.trackObjects(req.tool, result.value.data, money.amountMinor, money.currency, now);
      audit.append({
        actor: req.actor, event: "EXECUTED", tool: req.tool, approvalId: req.approvalId ?? null,
        inputHash: hashJson({ tool: req.tool, args: req.args }), outputHash: hashJson(result.value.data),
        detail: { requestId: req.requestId },
      });
    } else {
      // Only the code, status and a short message: never headers or tokens.
      audit.append({
        actor: req.actor, event: "FAILED", tool: req.tool, approvalId: req.approvalId ?? null,
        inputHash: hashJson({ tool: req.tool, args: req.args }),
        detail: { requestId: req.requestId, code: result.error.code, status: result.error.status ?? null, message: result.error.message },
      });
    }
    return result;
  }

  private trackObjects(tool: string, data: unknown, amountMinor: number | null, currency: string | null, now: Date): void {
    const { store } = this.deps;
    const ts = now.toISOString();
    const raw = JSON.stringify(data);
    if (tool === "create_order" || tool === "create_refund") {
      const p = WithId.safeParse(data);
      if (!p.success) return;
      store.upsertObject({
        id: p.data.id, kind: tool === "create_order" ? "order" : "refund", status: p.data.status ?? null,
        amount_minor: amountMinor, currency, created_by_payguard: 1, raw_json: raw, updated_at: ts,
      });
    } else if (tool === "pay_order") {
      const p = CaptureList.safeParse(data);
      if (!p.success) return;
      store.upsertObject({ id: p.data.id, kind: "order", status: p.data.status ?? null, amount_minor: null, currency: null, created_by_payguard: 0, raw_json: raw, updated_at: ts });
      for (const unit of p.data.purchase_units ?? []) {
        for (const cap of unit.payments?.captures ?? []) {
          store.upsertObject({
            id: cap.id, kind: "capture", status: cap.status ?? null,
            amount_minor: cap.amount ? parseMoneyToMinor(cap.amount.value) : null, currency: cap.amount?.currency_code ?? null,
            created_by_payguard: 1, raw_json: null, updated_at: ts,
          });
        }
      }
    }
  }
}
