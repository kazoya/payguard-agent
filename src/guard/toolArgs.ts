import { z } from "zod";
import { numberToMinor, parseMoneyToMinor } from "@/lib/money";
import { err, ok, type Result } from "@/lib/result";

/**
 * Extracts the money facts the policy needs from raw tool arguments.
 * The guard computes amounts itself instead of trusting a model-provided "total".
 */

export type MoneyFacts = { amountMinor: number | null; currency: string | null };

const RefundArgs = z
  .object({
    capture_id: z.string().min(1),
    amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
  })
  .passthrough();

const OrderItem = z
  .object({
    itemCost: z.number().nonnegative(),
    quantity: z.number().int().positive().default(1),
    taxPercent: z.number().nonnegative().max(100).default(0),
  })
  .passthrough();

const OrderArgs = z
  .object({
    currencyCode: z.string(),
    items: z.array(OrderItem).min(1).max(50),
    discount: z.number().nonnegative().default(0),
    shippingCost: z.number().nonnegative().default(0),
  })
  .passthrough();

const IdArgs = z.object({ id: z.string().min(1) }).passthrough();

export function extractMoneyFacts(tool: string, args: unknown): Result<MoneyFacts, string> {
  if (tool === "create_refund") {
    const p = RefundArgs.safeParse(args);
    if (!p.success) return err("create_refund arguments are invalid");
    if (!p.data.amount) return ok({ amountMinor: null, currency: null });
    const minor = parseMoneyToMinor(p.data.amount.value);
    if (minor === null) return err("create_refund amount.value must be a decimal string like \"20.00\"");
    return ok({ amountMinor: minor, currency: p.data.amount.currency_code.toUpperCase() });
  }
  if (tool === "create_order") {
    const p = OrderArgs.safeParse(args);
    if (!p.success) return err("create_order arguments are invalid");
    return orderTotal(p.data);
  }
  return ok({ amountMinor: null, currency: null });
}

/** Mirrors the toolkit's total: sum(itemCost*qty) + tax + shipping - discount. Tax rounds up, to stay conservative. */
function orderTotal(o: z.infer<typeof OrderArgs>): Result<MoneyFacts, string> {
  let subtotal = 0;
  let taxTimes100 = 0;
  for (const item of o.items) {
    const cost = numberToMinor(item.itemCost);
    if (cost === null) return err("create_order itemCost must have at most 2 decimals");
    subtotal += cost * item.quantity;
    taxTimes100 += cost * item.quantity * item.taxPercent;
  }
  const shipping = numberToMinor(o.shippingCost);
  const discount = numberToMinor(o.discount);
  if (shipping === null || discount === null) return err("create_order shipping/discount must have at most 2 decimals");
  const total = subtotal + Math.ceil(taxTimes100 / 100) + shipping - discount;
  if (total <= 0) return err("create_order total must be greater than zero");
  return ok({ amountMinor: total, currency: o.currencyCode.toUpperCase() });
}

export function extractCaptureId(args: unknown): string | null {
  const p = RefundArgs.safeParse(args);
  return p.success ? p.data.capture_id : null;
}

export function extractOrderId(args: unknown): string | null {
  const p = IdArgs.safeParse(args);
  return p.success ? p.data.id : null;
}
