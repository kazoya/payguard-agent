import { ApprovalQueue } from "@/approvals/queue";
import { AuditLog } from "@/audit/log";
import type { Db } from "@/db/db";
import { Store } from "@/db/store";
import { createExecutor } from "@/guard/executor";
import type { Policy } from "@/guard/policy";
import { PolicyGuard } from "@/guard/policyGuard";
import { ActionRunner } from "@/guard/runner";
import { systemClock, type Clock } from "@/lib/clock";
import type { CheckoutUrls } from "@/paypal/checkout";
import type { ToolCallHandlerFactory } from "@/paypal/types";

/** Composition root: wires the safety layer so routes, scripts and tests share one assembly. */
export type PayGuard = {
  store: Store;
  audit: AuditLog;
  approvals: ApprovalQueue;
  guard: PolicyGuard;
  policy: Policy;
};

export function createPayGuard(opts: { db: Db; policy: Policy; handlerFactory: ToolCallHandlerFactory; clock?: Clock; checkoutUrls?: CheckoutUrls | null }): PayGuard {
  const clock = opts.clock ?? systemClock;
  const store = new Store(opts.db);
  const audit = new AuditLog(opts.db, clock);
  const executor = createExecutor(opts.handlerFactory);
  const runner = new ActionRunner({ store, audit, executor, clock, timeZone: opts.policy.timezone, checkoutUrls: opts.checkoutUrls ?? null });
  const approvals = new ApprovalQueue(opts.db, audit, runner, clock, opts.policy.approval_ttl_hours);
  const guard = new PolicyGuard({ policy: opts.policy, store, audit, runner, approvals, clock });
  return { store, audit, approvals, guard, policy: opts.policy };
}
