import { z } from "zod";
import { sha256Hex } from "@/lib/hash";
import { parseMoneyToMinor } from "@/lib/money";
import type { PayPalObject } from "@/db/store";
import { MOCK_WEBHOOK_ID, readWebhookHeaders, verifyWebhook, type CertFetcher, type HeaderSource, type Postback } from "@/paypal/webhookVerify";
import type { Runtime } from "../runtime";
import { apiError, json, type ApiResponse } from "./http";

export const MAX_WEBHOOK_BYTES = 256 * 1024;

const Amount = z.object({ currency_code: z.string().max(3), value: z.string().max(32) }).partial();
const Resource = z
  .object({
    id: z.string().max(200).optional(),
    dispute_id: z.string().max(200).optional(),
    status: z.string().max(64).optional(),
    amount: Amount.optional(),
    purchase_units: z.array(z.object({ amount: Amount.optional() }).passthrough()).max(10).optional(),
  })
  .passthrough();
const EventSchema = z.object({ id: z.string().min(1).max(200), event_type: z.string().min(1).max(100), resource: Resource.default({}) }).passthrough();

const KIND_BY_EVENT: Record<string, PayPalObject["kind"]> = {
  "CHECKOUT.ORDER.APPROVED": "order",
  "CHECKOUT.ORDER.COMPLETED": "order",
  "PAYMENT.CAPTURE.COMPLETED": "capture",
  "PAYMENT.CAPTURE.REFUNDED": "refund",
  "PAYMENT.CAPTURE.REVERSED": "refund",
};

export type WebhookDeps = { fetchCert: CertFetcher; postback?: Postback };

function webhookIdFor(rt: Runtime): string | null {
  return rt.env?.PAYPAL_WEBHOOK_ID ?? (rt.mode.paypal === "mock" ? MOCK_WEBHOOK_ID : null);
}

/** Verify, dedupe on event id, update local PayPal state and append one WEBHOOK audit entry. */
export async function receiveWebhook(rt: Runtime, raw: string, headers: HeaderSource, deps: WebhookDeps): Promise<ApiResponse> {
  if (Buffer.byteLength(raw, "utf8") > MAX_WEBHOOK_BYTES) return apiError(413, "TOO_LARGE", "Webhook body too large.");
  const webhookId = webhookIdFor(rt);
  if (!webhookId) return apiError(503, "WEBHOOK_NOT_CONFIGURED", "PAYPAL_WEBHOOK_ID is not set.");

  const h = readWebhookHeaders(headers);
  if (!h.ok) return apiError(400, h.error, "Missing PayPal transmission headers.");
  const verified = await verifyWebhook({ raw, headers: h.value, webhookId, ...deps });
  if (!verified.ok) return apiError(401, verified.error, "Webhook signature could not be verified.");

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return apiError(400, "INVALID_JSON", "Body is not JSON.");
  }
  const parsed = EventSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "INVALID_EVENT", "Unexpected webhook event shape.");
  const ev = parsed.data;
  const resourceId = ev.resource.id ?? ev.resource.dispute_id ?? null;
  const now = rt.clock().toISOString();

  const inserted = rt.db
    .prepare("INSERT OR IGNORE INTO webhook_events (id, event_type, verified, resource_id, received_at, raw_json) VALUES (?, ?, 1, ?, ?, ?)")
    .run(ev.id, ev.event_type, resourceId, now, raw);
  if (inserted.changes === 0) return json(200, { received: true, duplicate: true });

  const kind = KIND_BY_EVENT[ev.event_type];
  if (kind && ev.resource.id) {
    const amount = ev.resource.amount ?? ev.resource.purchase_units?.[0]?.amount;
    rt.store.upsertObject({
      id: ev.resource.id, kind, status: ev.resource.status ?? null,
      amount_minor: amount?.value ? parseMoneyToMinor(amount.value) : null, currency: amount?.currency_code ?? null,
      created_by_payguard: 0, raw_json: JSON.stringify(ev.resource), updated_at: now,
    });
  }
  rt.audit.append({
    actor: "paypal", event: "WEBHOOK", tool: null, decision: null, inputHash: sha256Hex(raw),
    detail: { eventId: ev.id, eventType: ev.event_type, resourceId, method: verified.value.method },
  });
  return json(200, { received: true, duplicate: false });
}
