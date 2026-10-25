import { describe, expect, it } from "vitest";
import { approver, clerk, makeHarness, refundArgs } from "../helpers/setup";

const CAP = "CAPTURE_FIXTURE_1";
const harness = () => {
  const h = makeHarness();
  h.paypal.addCapture(CAP, "2000.00");
  return h;
};
const refund = (value?: string, provenance: "trusted" | "untrusted" = "trusted") =>
  ({ actor: clerk, conversationId: null, tool: "create_refund", args: refundArgs(CAP, value), provenance }) as const;

describe("PolicyGuard end-to-end (mock PayPal, in-memory DB)", () => {
  it("refund $20 -> ALLOW and executes once", async () => {
    const h = harness();
    const out = await h.guard.handle(refund("20.00"));
    expect(out).toMatchObject({ status: "executed", tool: "create_refund", data: { status: "COMPLETED" } });
    expect(h.paypal.calls).toHaveLength(1);
    expect(h.paypal.calls[0]!.requestId).toMatch(/^exe_/);
    expect(h.audit.all().map((r) => r.event)).toEqual(["PROPOSED", "ALLOWED", "EXECUTED"]);
  });

  it("refund $120 -> PENDING, not executed", async () => {
    const h = harness();
    expect(await h.guard.handle(refund("120.00"))).toMatchObject({ status: "pending_approval", ruleId: "refund-large" });
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("refund $1,500 -> DENY", async () => {
    const h = harness();
    expect(await h.guard.handle(refund("1500.00"))).toMatchObject({ status: "denied", ruleId: "refund-hard-limit" });
    expect(h.paypal.calls).toHaveLength(0);
    expect(h.audit.all().map((r) => r.event)).toEqual(["PROPOSED", "DENIED"]);
  });

  it("refund without an amount -> DENY (AMOUNT_REQUIRED)", async () => {
    const h = harness();
    expect(await h.guard.handle(refund(undefined))).toMatchObject({ status: "denied", ruleId: "AMOUNT_REQUIRED" });
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("malformed args -> DENY (INVALID_ARGS)", async () => {
    const h = harness();
    const out = await h.guard.handle({ ...refund(), args: { capture_id: CAP, amount: { currency_code: "USD", value: "1e9" } } });
    expect(out).toMatchObject({ status: "denied", ruleId: "INVALID_ARGS" });
  });

  it("untrusted provenance -> DENY", async () => {
    const h = harness();
    expect(await h.guard.handle(refund("10.00", "untrusted"))).toMatchObject({ status: "denied", ruleId: "UNTRUSTED_SOURCE" });
  });

  it("unknown tool -> DENY", async () => {
    const h = harness();
    expect(await h.guard.handle({ ...refund(), tool: "create_payout", args: {} })).toMatchObject({ status: "denied", ruleId: "UNKNOWN_TOOL" });
  });

  it("daily refund cap: 4 x $50 allowed, the 5th needs approval; resets next Amman day", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) expect((await h.guard.handle(refund("50.00"))).status).toBe("executed");
    expect(await h.guard.handle(refund("10.00"))).toMatchObject({ status: "pending_approval", ruleId: "refund-daily-cap" });
    h.time.set("2026-10-24T21:30:00.000Z"); // 00:30 on Oct 25 in Asia/Amman
    expect((await h.guard.handle(refund("10.00"))).status).toBe("executed");
  });

  it("approved refunds count towards the daily cap", async () => {
    const h = harness();
    const p = await h.guard.handle(refund("151.00"));
    if (p.status !== "pending_approval") throw new Error("expected pending");
    await h.approvals.approve(p.approvalId, approver);
    expect(await h.guard.handle(refund("50.00"))).toMatchObject({ status: "pending_approval", ruleId: "refund-daily-cap" });
  });

  it("refund larger than what is left on a known capture -> DENY", async () => {
    const h = makeHarness();
    const order = await h.guard.handle({ actor: clerk, conversationId: null, tool: "create_order", args: { currencyCode: "USD", items: [{ name: "Mug", itemCost: 30, itemTotal: 30 }] }, provenance: "trusted" });
    if (order.status !== "executed") throw new Error("order not created");
    const orderId = (order.data as { id: string }).id;
    const paid = await h.guard.handle({ actor: clerk, conversationId: null, tool: "pay_order", args: { id: orderId }, provenance: "trusted" });
    if (paid.status !== "executed") throw new Error("capture failed");
    const captureId = (paid.data as { purchase_units: { payments: { captures: { id: string }[] } }[] }).purchase_units[0]!.payments.captures[0]!.id;
    expect(h.store.getObject(captureId)).toMatchObject({ kind: "capture", amount_minor: 3000 });
    expect((await h.guard.handle({ ...refund(), args: refundArgs(captureId, "20.00") })).status).toBe("executed");
    expect(await h.guard.handle({ ...refund(), args: refundArgs(captureId, "10.01") })).toMatchObject({ status: "denied", ruleId: "REFUND_EXCEEDS_CAPTURE" });
  });

  it("pay_order: PayGuard-created order is allowed, an external one needs approval", async () => {
    const h = makeHarness();
    const order = await h.guard.handle({ actor: clerk, conversationId: null, tool: "create_order", args: { currencyCode: "USD", items: [{ name: "Tea", itemCost: 40, itemTotal: 40 }] }, provenance: "trusted" });
    expect(order.status).toBe("executed");
    const orderId = (order.status === "executed" ? order.data : {}) as { id: string };
    expect(h.store.getObject(orderId.id)).toMatchObject({ kind: "order", amount_minor: 4000, created_by_payguard: 1 });
    expect((await h.guard.handle({ actor: clerk, conversationId: null, tool: "pay_order", args: { id: orderId.id }, provenance: "trusted" })).status).toBe("executed");
    expect(await h.guard.handle({ actor: clerk, conversationId: null, tool: "pay_order", args: { id: "EXTERNAL_ORDER_1" }, provenance: "trusted" })).toMatchObject({ status: "pending_approval", ruleId: "capture-other" });
  });

  it("order > $500 needs approval", async () => {
    const h = makeHarness();
    const out = await h.guard.handle({ actor: clerk, conversationId: null, tool: "create_order", args: { currencyCode: "USD", items: [{ name: "Laptop", itemCost: 900, itemTotal: 900 }] }, provenance: "trusted" });
    expect(out).toMatchObject({ status: "pending_approval", ruleId: "order-large" });
  });

  it("read tools run directly", async () => {
    const h = makeHarness();
    expect(await h.guard.handle({ actor: clerk, conversationId: null, tool: "list_transactions", args: {}, provenance: "untrusted" })).toMatchObject({ status: "executed" });
  });

  it("PayPal failures are returned and audited without leaking payloads", async () => {
    const h = harness();
    h.paypal.failNext = { status: 500, message: "INTERNAL_SERVICE_ERROR" };
    expect(await h.guard.handle(refund("5.00"))).toMatchObject({ status: "failed", error: { code: "PAYPAL_ERROR", status: 500 } });
    expect(h.audit.verifyChain().ok).toBe(true);
  });
});
