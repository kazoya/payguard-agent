import type { DecisionKind, Policy, PolicyRule, Role } from "./policy";

/**
 * Pure policy evaluation: (policy, facts) => decision. No I/O, so it is exhaustively table-tested.
 * Built-in checks run before the YAML rules and cannot be configured away.
 */

export type Provenance = "trusted" | "untrusted";

export type CallFacts = {
  tool: string;
  role: Role;
  /** Explicit amount of the call in minor units; null when the call carries none. */
  amountMinor: number | null;
  currency: string | null;
  provenance: Provenance;
  /** Refunds already executed today (policy time zone), minor units. */
  dailyRefundTotalMinor: number;
  orderCreatedByPayguard?: boolean;
  /** Captured amount still refundable, when PayGuard knows the capture. */
  refundableRemainingMinor?: number | null;
};

export type BuiltInRuleId =
  | "UNKNOWN_TOOL"
  | "UNTRUSTED_SOURCE"
  | "AMOUNT_REQUIRED"
  | "INVALID_AMOUNT"
  | "CURRENCY_NOT_ALLOWED"
  | "REFUND_EXCEEDS_CAPTURE"
  | "NO_MATCHING_RULE";

export type Decision = { decision: DecisionKind; ruleId: string; reason: string };

/** Tools that move money and therefore carry an amount the policy reasons about. */
export const AMOUNT_TOOLS = new Set(["create_refund", "create_order"]);

const deny = (ruleId: BuiltInRuleId, reason: string): Decision => ({ decision: "DENY", ruleId, reason });

export function knownTools(policy: Policy): Set<string> {
  const tools = new Set(policy.sensitive_tools);
  for (const rule of policy.rules) for (const t of rule.tools) tools.add(t);
  return tools;
}

export function evaluate(policy: Policy, facts: CallFacts): Decision {
  if (!knownTools(policy).has(facts.tool)) {
    return deny("UNKNOWN_TOOL", `Tool "${facts.tool}" is not covered by the policy.`);
  }
  const sensitive = policy.sensitive_tools.includes(facts.tool);
  if (sensitive && facts.provenance === "untrusted") {
    return deny("UNTRUSTED_SOURCE", "Amounts, IDs or payees for this action came from untrusted text.");
  }
  if (AMOUNT_TOOLS.has(facts.tool)) {
    if (facts.amountMinor === null) {
      return deny("AMOUNT_REQUIRED", "An explicit amount is required (PayPal would otherwise refund the full capture).");
    }
    if (!Number.isInteger(facts.amountMinor) || facts.amountMinor <= 0) {
      return deny("INVALID_AMOUNT", "The amount must be greater than zero.");
    }
    if (facts.currency !== policy.currency) {
      return deny("CURRENCY_NOT_ALLOWED", `Only ${policy.currency} is allowed.`);
    }
  }
  if (
    facts.tool === "create_refund" &&
    facts.refundableRemainingMinor != null &&
    facts.amountMinor !== null &&
    facts.amountMinor > facts.refundableRemainingMinor
  ) {
    return deny("REFUND_EXCEEDS_CAPTURE", "The refund is larger than the amount still refundable on this capture.");
  }

  for (const rule of policy.rules) {
    if (matches(rule, facts)) {
      return { decision: rule.decision, ruleId: rule.id, reason: rule.reason ?? defaultReason(rule.decision) };
    }
  }
  return deny("NO_MATCHING_RULE", "No policy rule matched, so the action is denied by default.");
}

function matches(rule: PolicyRule, f: CallFacts): boolean {
  if (!rule.tools.includes(f.tool)) return false;
  if (rule.roles && !rule.roles.includes(f.role)) return false;
  const w = rule.when;
  if (!w) return true;
  // A missing amount never satisfies an amount condition, so it falls through to stricter rules.
  if (w.amount_gt !== undefined && !(f.amountMinor !== null && f.amountMinor > w.amount_gt)) return false;
  if (w.amount_lte !== undefined && !(f.amountMinor !== null && f.amountMinor <= w.amount_lte)) return false;
  if (
    w.daily_refund_total_after_gt !== undefined &&
    !(f.dailyRefundTotalMinor + (f.amountMinor ?? 0) > w.daily_refund_total_after_gt)
  ) {
    return false;
  }
  if (w.order_created_by_payguard !== undefined && (f.orderCreatedByPayguard ?? false) !== w.order_created_by_payguard) {
    return false;
  }
  return true;
}

function defaultReason(d: DecisionKind): string {
  if (d === "ALLOW") return "Allowed by policy.";
  if (d === "REQUIRE_APPROVAL") return "Needs approval by a manager.";
  return "Denied by policy.";
}
