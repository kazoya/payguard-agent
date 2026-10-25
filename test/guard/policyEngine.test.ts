import { describe, expect, it } from "vitest";
import { evaluate, type CallFacts } from "@/guard/policyEngine";
import { parseMoneyToMinor } from "@/lib/money";
import { defaultPolicy } from "../helpers/setup";

const policy = defaultPolicy();
const usd = (v: string) => parseMoneyToMinor(v)!;

const f = (over: Partial<CallFacts>): CallFacts => ({
  tool: "create_refund",
  role: "clerk",
  amountMinor: null,
  currency: "USD",
  provenance: "trusted",
  dailyRefundTotalMinor: 0,
  ...over,
});

type Case = [name: string, facts: CallFacts, decision: string, ruleId: string];

// Covers every row of SPEC section 8 plus the built-in checks.
const cases: Case[] = [
  ["read tool, clerk", f({ tool: "get_order" }), "ALLOW", "read-only"],
  ["read tool, owner", f({ tool: "list_transactions", role: "owner" }), "ALLOW", "read-only"],
  ["list_disputes", f({ tool: "list_disputes", role: "approver" }), "ALLOW", "read-only"],
  ["unknown tool", f({ tool: "delete_invoice" }), "DENY", "UNKNOWN_TOOL"],
  ["unknown tool even for owner", f({ tool: "create_payout", role: "owner", amountMinor: 100 }), "DENY", "UNKNOWN_TOOL"],
  ["refund $20", f({ amountMinor: usd("20.00") }), "ALLOW", "refund-small"],
  ["refund exactly $50.00", f({ amountMinor: usd("50.00") }), "ALLOW", "refund-small"],
  ["refund $50.01", f({ amountMinor: usd("50.01") }), "REQUIRE_APPROVAL", "refund-large"],
  ["refund $120", f({ amountMinor: usd("120") }), "REQUIRE_APPROVAL", "refund-large"],
  ["refund exactly 1000 USD (also over the daily cap)", f({ amountMinor: usd("1000.00") }), "REQUIRE_APPROVAL", "refund-daily-cap"],
  ["refund 1000.01 USD", f({ amountMinor: usd("1000.01") }), "DENY", "refund-hard-limit"],
  ["refund 1500 USD by owner", f({ amountMinor: usd("1500"), role: "owner" }), "DENY", "refund-hard-limit"],
  ["refund without amount", f({ amountMinor: null }), "DENY", "AMOUNT_REQUIRED"],
  ["refund of zero", f({ amountMinor: 0 }), "DENY", "INVALID_AMOUNT"],
  ["refund in EUR", f({ amountMinor: usd("10"), currency: "EUR" }), "DENY", "CURRENCY_NOT_ALLOWED"],
  ["refund $40 at daily $150 (=190, under cap)", f({ amountMinor: usd("40"), dailyRefundTotalMinor: usd("150") }), "ALLOW", "refund-small"],
  ["refund $40 at daily $160 (=200, at cap)", f({ amountMinor: usd("40"), dailyRefundTotalMinor: usd("160") }), "ALLOW", "refund-small"],
  ["refund $40 at daily $180 (cap exceeded)", f({ amountMinor: usd("40"), dailyRefundTotalMinor: usd("180") }), "REQUIRE_APPROVAL", "refund-daily-cap"],
  ["refund larger than refundable", f({ amountMinor: usd("30"), refundableRemainingMinor: usd("25") }), "DENY", "REFUND_EXCEEDS_CAPTURE"],
  ["refund equal to refundable", f({ amountMinor: usd("25"), refundableRemainingMinor: usd("25") }), "ALLOW", "refund-small"],
  ["refund from untrusted text", f({ amountMinor: usd("900"), provenance: "untrusted" }), "DENY", "UNTRUSTED_SOURCE"],
  ["small refund from untrusted text", f({ amountMinor: usd("5"), provenance: "untrusted" }), "DENY", "UNTRUSTED_SOURCE"],
  ["read tool with untrusted provenance is fine", f({ tool: "get_order", provenance: "untrusted" }), "ALLOW", "read-only"],
  ["order $40", f({ tool: "create_order", amountMinor: usd("40") }), "ALLOW", "order-small"],
  ["order exactly $500", f({ tool: "create_order", amountMinor: usd("500") }), "ALLOW", "order-small"],
  ["order $500.01", f({ tool: "create_order", amountMinor: usd("500.01") }), "REQUIRE_APPROVAL", "order-large"],
  ["order without amount", f({ tool: "create_order", amountMinor: null }), "DENY", "AMOUNT_REQUIRED"],
  ["order in EUR", f({ tool: "create_order", amountMinor: 100, currency: "EUR" }), "DENY", "CURRENCY_NOT_ALLOWED"],
  ["capture own order $40", f({ tool: "pay_order", amountMinor: usd("40"), orderCreatedByPayguard: true }), "ALLOW", "capture-own-order"],
  ["capture own order $600", f({ tool: "pay_order", amountMinor: usd("600"), orderCreatedByPayguard: true }), "REQUIRE_APPROVAL", "capture-other"],
  ["capture external order", f({ tool: "pay_order", amountMinor: usd("40"), orderCreatedByPayguard: false }), "REQUIRE_APPROVAL", "capture-other"],
  ["capture order with unknown amount", f({ tool: "pay_order", amountMinor: null, orderCreatedByPayguard: true }), "REQUIRE_APPROVAL", "capture-other"],
  ["accept dispute claim", f({ tool: "accept_dispute_claim", role: "owner" }), "REQUIRE_APPROVAL", "dispute-accept"],
  ["send_invoice is known but has no rule", f({ tool: "send_invoice" }), "DENY", "NO_MATCHING_RULE"],
];

describe("policyEngine.evaluate (default policy)", () => {
  it("has at least 20 cases", () => expect(cases.length).toBeGreaterThanOrEqual(20));

  it.each(cases)("%s", (_name, facts, decision, ruleId) => {
    const d = evaluate(policy, facts);
    expect(d).toMatchObject({ decision, ruleId });
    expect(d.reason.length).toBeGreaterThan(0);
  });
});
