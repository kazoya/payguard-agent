import { describe, expect, it } from "vitest";
import { createExecutor, interpretToolkitResponse } from "@/guard/executor";
import { MockPayPal } from "@/paypal/mockPayPal";
import { refundArgs } from "../helpers/setup";

function setup() {
  const paypal = new MockPayPal();
  paypal.addCapture("CAPTURE_FIXTURE_1", "80.00");
  return { paypal, exec: createExecutor(paypal.factory) };
}

describe("executor (PayPal tool wrapper)", () => {
  it("refuses create_refund without an explicit amount and never calls PayPal", async () => {
    const { paypal, exec } = setup();
    const r = await exec.execute({ tool: "create_refund", args: refundArgs("CAPTURE_FIXTURE_1"), requestId: "exe_1" });
    expect(r).toMatchObject({ ok: false, error: { code: "AMOUNT_REQUIRED" } });
    expect(paypal.calls).toHaveLength(0);
    expect(paypal.refundedMinor("CAPTURE_FIXTURE_1")).toBe(0);
  });

  it("enforces USD on create_order and on refunds", async () => {
    const { paypal, exec } = setup();
    const order = await exec.execute({ tool: "create_order", args: { currencyCode: "EUR", items: [{ name: "Mug", itemCost: 10, itemTotal: 10 }] }, requestId: "exe_2" });
    expect(order).toMatchObject({ ok: false, error: { code: "CURRENCY_NOT_USD" } });
    const refund = await exec.execute({ tool: "create_refund", args: { capture_id: "CAPTURE_FIXTURE_1", amount: { currency_code: "EUR", value: "5" } }, requestId: "exe_3" });
    expect(refund).toMatchObject({ ok: false, error: { code: "CURRENCY_NOT_USD" } });
    expect(paypal.calls).toHaveLength(0);
  });

  it("refuses tools outside the allowlist", async () => {
    const { paypal, exec } = setup();
    expect(await exec.execute({ tool: "accept_dispute_claim", args: {}, requestId: "exe_4" })).toMatchObject({ ok: false, error: { code: "TOOL_NOT_ALLOWED" } });
    expect(paypal.calls).toHaveLength(0);
  });

  it("sends a PayPal-Request-Id per action, so a replay does not refund twice", async () => {
    const { paypal, exec } = setup();
    const req = { tool: "create_refund", args: refundArgs("CAPTURE_FIXTURE_1", "20.00"), requestId: "apr_same" };
    const a = await exec.execute(req);
    const b = await exec.execute(req);
    expect(a.ok && b.ok).toBe(true);
    expect(paypal.calls.map((c) => c.requestId)).toEqual(["apr_same", "apr_same"]);
    expect(paypal.refundedMinor("CAPTURE_FIXTURE_1")).toBe(2000);
    if (a.ok && b.ok) expect(a.value.data).toEqual(b.value.data);
  });

  it("maps toolkit error payloads to PAYPAL_ERROR", () => {
    expect(interpretToolkitResponse('{"error":{"message":"RESOURCE_NOT_FOUND","type":"paypal_error"}}')).toMatchObject({ ok: false, error: { code: "PAYPAL_ERROR", message: "RESOURCE_NOT_FOUND" } });
    expect(interpretToolkitResponse('{"ok":false,"code":"PAYPAL_API_HTTP_ERROR","status":422,"message":"UNPROCESSABLE"}')).toMatchObject({ ok: false, error: { status: 422 } });
    expect(interpretToolkitResponse("not json")).toMatchObject({ ok: false });
    expect(interpretToolkitResponse('{"id":"R1","status":"COMPLETED"}')).toMatchObject({ ok: true, value: { data: { id: "R1" } } });
  });
});
