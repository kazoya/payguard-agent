import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parsePolicy } from "@/guard/policy";
import { DEFAULT_POLICY_PATH } from "../helpers/setup";

const valid = readFileSync(DEFAULT_POLICY_PATH, "utf8");

describe("policy loader", () => {
  it("loads the default policy with amounts in minor units", () => {
    const r = parsePolicy(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.limits.daily_refund_cap).toBe(20000);
    const hard = r.value.rules.find((x) => x.id === "refund-hard-limit");
    expect(hard?.when?.amount_gt).toBe(100000);
  });

  it.each([
    ["YAML syntax", "rules: [unclosed", /syntax error/],
    ["missing rules", "version: 1\ncurrency: USD", /rules/],
    ["unknown decision", valid.replace("decision: DENY", "decision: MAYBE"), /decision/],
    ["unknown condition key", valid.replace("amount_gt: 1000.00", "amount_greater: 1000.00"), /Unrecognized key/],
    ["3-decimal amount", valid.replace("amount_lte: 50.00", 'amount_lte: "50.001"'), /at most 2 decimals/],
    ["bad time zone", valid.replace("Asia/Amman", "Mars/Olympus"), /time zone/],
    ["duplicate rule id", valid.replace("id: refund-large", "id: refund-small"), /duplicate rule id/],
    ["wrong version", valid.replace("version: 1", "version: 2"), /version/],
  ])("rejects %s with a clear message", (_name, text, pattern) => {
    const r = parsePolicy(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(pattern);
  });
});
