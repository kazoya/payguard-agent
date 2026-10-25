import { describe, expect, it } from "vitest";
import { extractCaptureId, extractMoneyFacts, extractOrderId } from "@/guard/toolArgs";

describe("extractMoneyFacts", () => {
  it("reads an explicit refund amount", () => {
    expect(extractMoneyFacts("create_refund", { capture_id: "CAP1234567890123", amount: { currency_code: "usd", value: "20.50" } }))
      .toEqual({ ok: true, value: { amountMinor: 2050, currency: "USD" } });
  });

  it("reports a missing refund amount as null (policy denies it)", () => {
    expect(extractMoneyFacts("create_refund", { capture_id: "CAP1234567890123" })).toEqual({ ok: true, value: { amountMinor: null, currency: null } });
  });

  it("rejects malformed refund amounts", () => {
    expect(extractMoneyFacts("create_refund", { capture_id: "C", amount: { currency_code: "USD", value: "20.555" } }).ok).toBe(false);
    expect(extractMoneyFacts("create_refund", { amount: { currency_code: "USD", value: "1" } }).ok).toBe(false);
  });

  it("computes the order total like the toolkit (qty, tax, shipping, discount), ignoring model-provided itemTotal", () => {
    const r = extractMoneyFacts("create_order", {
      currencyCode: "USD",
      items: [
        { name: "Mug", itemCost: 12.5, quantity: 2, itemTotal: 1 },
        { name: "Tea", itemCost: 10, taxPercent: 16, itemTotal: 1 },
      ],
      shippingCost: 5,
      discount: 2.5,
    });
    // 25 + 10 + 1.60 tax + 5 - 2.5 = 39.10
    expect(r).toEqual({ ok: true, value: { amountMinor: 3910, currency: "USD" } });
  });

  it("rounds fractional-cent tax up, to stay conservative", () => {
    const r = extractMoneyFacts("create_order", { currencyCode: "USD", items: [{ name: "x", itemCost: 0.99, taxPercent: 7, itemTotal: 0.99 }] });
    expect(r).toEqual({ ok: true, value: { amountMinor: 99 + 7, currency: "USD" } });
  });

  it("rejects orders that total zero or have no items", () => {
    expect(extractMoneyFacts("create_order", { currencyCode: "USD", items: [{ name: "x", itemCost: 5, itemTotal: 5 }], discount: 5 }).ok).toBe(false);
    expect(extractMoneyFacts("create_order", { currencyCode: "USD", items: [] }).ok).toBe(false);
  });

  it("returns no amount for read tools and extracts ids", () => {
    expect(extractMoneyFacts("get_order", { id: "X" })).toEqual({ ok: true, value: { amountMinor: null, currency: null } });
    expect(extractOrderId({ id: "ORDER123" })).toBe("ORDER123");
    expect(extractCaptureId({ capture_id: "CAP1" })).toBe("CAP1");
    expect(extractCaptureId({})).toBeNull();
  });
});
