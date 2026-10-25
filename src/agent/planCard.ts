import type { Store } from "@/db/store";
import { extractCaptureId, extractMoneyFacts, extractOrderId } from "@/guard/toolArgs";
import { summarizeCapture, verifyCheckoutUrl } from "@/paypal/checkout";

/**
 * A plan card is the UI view of one proposed PayPal action: what, how much, on what, why,
 * and what the guard decided. It is built server-side from the tool call and the guard result,
 * never from model prose, so the card cannot overstate what happened.
 */

export type CardStatus = "executed" | "failed" | "pending_approval" | "denied";

export type PlanCard = {
  callId: string;
  tool: string;
  plan: string | null;
  amountMinor: number | null;
  currency: string | null;
  target: string | null;
  status: CardStatus;
  ruleId: string | null;
  reason: string | null;
  approvalId: string | null;
  resultId: string | null;
  error: string | null;
  /** PayPal's status of the object (e.g. PAYER_ACTION_REQUIRED, or the capture status for pay_order). */
  paypalStatus?: string | null;
  /** Capture id from a pay_order response. */
  captureId?: string | null;
  /** Buyer approval link, only from the verified tool result (never from model text). */
  checkoutUrl?: string | null;
};

const STATUSES: readonly CardStatus[] = ["executed", "failed", "pending_approval", "denied"];

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function buildPlanCard(
  call: { id: string; name: string; args: Record<string, unknown> },
  plan: string | null,
  result: Record<string, unknown>,
  store: Pick<Store, "getObject">,
): PlanCard {
  const facts = extractMoneyFacts(call.name, call.args);
  const target = call.name === "create_refund" ? extractCaptureId(call.args) : extractOrderId(call.args);
  let amountMinor = facts.ok ? facts.value.amountMinor : null;
  let currency = facts.ok ? facts.value.currency : null;
  if (amountMinor === null && target) {
    const known = store.getObject(target);
    if (known && call.name === "pay_order") {
      amountMinor = known.amount_minor;
      currency = known.currency;
    }
  }
  const status = STATUSES.includes(result.status as CardStatus) ? (result.status as CardStatus) : "failed";
  const data = (result.data ?? {}) as Record<string, unknown>;
  const error = result.error as { code?: string; message?: string } | undefined;
  const capture = status === "executed" && call.name === "pay_order" ? summarizeCapture(data) : null;
  const link = typeof result.checkout_url === "string" ? verifyCheckoutUrl(result.checkout_url) : null;
  return {
    callId: call.id,
    tool: call.name,
    plan: str(plan),
    amountMinor,
    currency: currency ?? (amountMinor !== null ? "USD" : null),
    target,
    status,
    ruleId: str(result.rule),
    reason: str(result.reason),
    approvalId: str(result.approval_id),
    resultId: str(data.id),
    error: error ? [error.code, error.message].filter(Boolean).join(": ") : null,
    paypalStatus: status === "executed" ? capture?.captureStatus ?? str(data.status) : null,
    captureId: capture?.captureId ?? null,
    checkoutUrl: link?.ok ? link.url : null,
  };
}
