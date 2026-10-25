import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MOCK_WEBHOOK_ID, signedMessage, type WebhookHeaders } from "@/paypal/webhookVerify";
import { receiveWebhook } from "@/server/api/webhooks";
import { mockRuntime } from "./helpers";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const deps = { fetchCert: async () => PEM };

function signed(body: string, id = "t-1"): Headers {
  const h: WebhookHeaders = {
    "paypal-transmission-id": id, "paypal-transmission-time": "2026-10-24T09:00:00Z", "paypal-transmission-sig": "",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test", "paypal-auth-algo": "SHA256withRSA",
  };
  h["paypal-transmission-sig"] = sign("sha256", Buffer.from(signedMessage(h, MOCK_WEBHOOK_ID, body)), privateKey).toString("base64");
  return new Headers(h);
}

const refundEvent = JSON.stringify({
  id: "WH-REFUND-1", event_type: "PAYMENT.CAPTURE.REFUNDED",
  resource: { id: "REFUND-77", status: "COMPLETED", amount: { currency_code: "USD", value: "20.00" } },
});

describe("POST /api/webhooks/paypal (mock runtime, webhook id WEBHOOK_ID)", () => {
  it("verifies, stores the event, updates local state and audits once; duplicates are ignored", async () => {
    const { rt } = mockRuntime();
    const first = await receiveWebhook(rt, refundEvent, signed(refundEvent), deps);
    expect(first).toMatchObject({ status: 200, body: { received: true, duplicate: false } });
    expect(rt.store.getObject("REFUND-77")).toMatchObject({ kind: "refund", status: "COMPLETED", amount_minor: 2000, currency: "USD" });

    const again = await receiveWebhook(rt, refundEvent, signed(refundEvent, "t-2"), deps);
    expect(again.body).toEqual({ received: true, duplicate: true });

    const hooks = rt.audit.all().filter((r) => r.event === "WEBHOOK");
    expect(hooks).toHaveLength(1);
    expect(JSON.parse(hooks[0]!.detail_json!)).toMatchObject({ eventId: "WH-REFUND-1", method: "self" });
    expect(rt.audit.verifyChain().ok).toBe(true);
  });

  it("rejects a tampered body with 401 and records nothing", async () => {
    const { rt } = mockRuntime();
    const res = await receiveWebhook(rt, refundEvent.replace("20.00", "2000.00"), signed(refundEvent), deps);
    expect(res.status).toBe(401);
    expect(rt.db.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()).toEqual({ n: 0 });
    expect(rt.audit.all()).toHaveLength(0);
  });

  it("returns 400 for missing headers or a bad event shape, 413 for huge bodies", async () => {
    const { rt } = mockRuntime();
    expect((await receiveWebhook(rt, refundEvent, new Headers(), deps)).status).toBe(400);
    const bad = JSON.stringify({ hello: "world" });
    expect((await receiveWebhook(rt, bad, signed(bad), deps)).status).toBe(400);
    expect((await receiveWebhook(rt, "x".repeat(300_000), signed("x"), deps)).status).toBe(413);
  });

  it("records dispute events without touching paypal_objects", async () => {
    const { rt } = mockRuntime();
    const ev = JSON.stringify({ id: "WH-D1", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1", status: "OPEN" } });
    expect((await receiveWebhook(rt, ev, signed(ev), deps)).status).toBe(200);
    expect(rt.store.getObject("PP-D-1")).toBeUndefined();
    expect(rt.db.prepare("SELECT resource_id FROM webhook_events WHERE id = 'WH-D1'").get()).toEqual({ resource_id: "PP-D-1" });
  });
});
