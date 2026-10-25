import { describe, expect, it } from "vitest";
import { describeArgIssues, invalidArgsFeedback } from "@/guard/argFeedback";
import { normalizeToolArgs, parseRawArgs } from "@/guard/argNormalize";
import { extractMoneyFacts } from "@/guard/toolArgs";

const MUG_AR = "\u0643\u0648\u0628 \u0642\u0647\u0648\u0629";
// Exact live payloads (create_order with `items` as a Python-literal string).
const LIVE_EN = `{"currencyCode":"USD","items":"[{'name': 'Test T-shirt', 'itemCost': 25.0, 'itemTotal': 25.0, 'quantity': 1}]"}`;
const LIVE_AR = JSON.stringify({
  currencyCode: "USD",
  items: `[{'name': '${MUG_AR}', 'itemCost': 15.0, 'itemTotal': 15.0, 'quantity': 1}]`,
  returnUrl: "https://example.com/return",
  cancelUrl: "https://example.com/cancel",
});

describe("normalizeToolArgs", () => {
  it("turns the live English payload into a valid order", () => {
    const n = normalizeToolArgs("create_order", parseRawArgs(LIVE_EN)!);
    expect(n.args.items).toEqual([{ name: "Test T-shirt", itemCost: 25, itemTotal: 25, quantity: 1 }]);
    expect(n.notes).toEqual(["items: string -> array"]);
    expect(extractMoneyFacts("create_order", n.args)).toEqual({ ok: true, value: { amountMinor: 2500, currency: "USD" } });
  });

  it("turns the live Arabic payload into a valid order and keeps the URLs", () => {
    const n = normalizeToolArgs("create_order", parseRawArgs(LIVE_AR)!);
    expect(n.args).toMatchObject({ items: [{ name: MUG_AR, itemCost: 15 }], returnUrl: "https://example.com/return", cancelUrl: "https://example.com/cancel" });
    expect(extractMoneyFacts("create_order", n.args)).toMatchObject({ ok: true, value: { amountMinor: 1500 } });
  });

  it("accepts a JSON string too, and numeric strings for known number fields", () => {
    const n = normalizeToolArgs("create_order", { currencyCode: "USD", items: '[{"name":"Mug","itemCost":"12.50","itemTotal":"12.5","quantity":"2"}]', shippingCost: "3" });
    expect(n.args).toMatchObject({ items: [{ itemCost: 12.5, itemTotal: 12.5, quantity: 2 }], shippingCost: 3 });
  });

  it("parses a stringified refund amount and turns a numeric value into a string", () => {
    expect(normalizeToolArgs("create_refund", { capture_id: "CAP", amount: "{'currency_code': 'USD', 'value': '15.00'}" }).args.amount).toEqual({ currency_code: "USD", value: "15.00" });
    expect(normalizeToolArgs("create_refund", { capture_id: "CAP", amount: { currency_code: "USD", value: 15 } }).args.amount).toEqual({ currency_code: "USD", value: "15" });
  });

  it("does not hide sub-cent amounts: 15.005 still fails the cents check", () => {
    const n = normalizeToolArgs("create_refund", { capture_id: "CAP", amount: { currency_code: "USD", value: 15.005 } });
    expect(extractMoneyFacts("create_refund", n.args).ok).toBe(false);
  });

  it.each([
    ["python call", "__import__('os').system('id')"],
    ["eval", "eval(\"[{'name':'x','itemCost':1}]\")"],
    ["object instead of array", "{'name': 'x'}"],
    ["expression", "[{'name': 'x', 'itemCost': 2*100}]"],
  ])("leaves %s as a string, so validation rejects it", (_l, items) => {
    const n = normalizeToolArgs("create_order", { currencyCode: "USD", items });
    expect(n.args.items).toBe(items);
    expect(n.notes).toEqual([]);
    expect(describeArgIssues("create_order", n.args)).toEqual(["items: Expected array, received string"]);
  });

  it("does not touch unknown tools or unknown params", () => {
    const args = { items: "[1]", other: "[2]" };
    expect(normalizeToolArgs("some_tool", args)).toEqual({ args, notes: [] });
    expect(normalizeToolArgs("create_order", { other: "[2]" }).args).toEqual({ other: "[2]" });
  });

  it("does not coerce number-like strings with junk", () => {
    const n = normalizeToolArgs("create_order", { currencyCode: "USD", items: [{ name: "x", itemCost: "25; DROP TABLE", itemTotal: 1 }] });
    expect((n.args.items as Record<string, unknown>[])[0]!.itemCost).toBe("25; DROP TABLE");
  });
});

describe("parseRawArgs", () => {
  it("accepts JSON, a Python-literal object and empty input", () => {
    expect(parseRawArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseRawArgs("{'a': True}")).toEqual({ a: true });
    expect(parseRawArgs("")).toEqual({});
  });
  it("rejects non-objects and code", () => {
    expect(parseRawArgs("[1]")).toBeNull();
    expect(parseRawArgs("__import__('os')")).toBeNull();
  });
});

describe("INVALID_ARGS feedback", () => {
  it("lists issue paths with expected types and a minimal valid example", () => {
    const issues = describeArgIssues("create_order", { currencyCode: "USD", items: [{ itemCost: "x" }] });
    expect(issues).toEqual(expect.arrayContaining(["items.0.name: Required", "items.0.itemCost: Expected number, received string"]));
    const fb = invalidArgsFeedback("create_order", issues);
    expect(fb.example).toMatchObject({ currencyCode: "USD", items: [expect.objectContaining({ name: expect.any(String), itemCost: expect.any(Number) })] });
    expect(JSON.stringify(fb)).not.toMatch(/secret|token|client_id/i);
  });
  it("caps the number of issues", () => {
    const items = Array.from({ length: 10 }, () => ({}));
    expect(describeArgIssues("create_order", { currencyCode: "USD", items }).length).toBeLessThanOrEqual(5);
  });
});
