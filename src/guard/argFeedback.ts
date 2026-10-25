import type { ZodIssue } from "zod";
import { extractMoneyFacts, OrderArgs, RefundArgs } from "./toolArgs";

/**
 * Actionable INVALID_ARGS feedback for the model: concise issue paths with expected types, and a
 * minimal valid example for the tool. Examples use placeholders for ids and contain no secrets.
 * The UI keeps showing the short, translated reason; this detail goes only to the model.
 */

export const TOOL_EXAMPLES: Record<string, Record<string, unknown>> = {
  create_order: {
    currencyCode: "USD",
    items: [{ name: "Coffee mug", quantity: 1, itemCost: 12.5, itemTotal: 12.5 }],
  },
  create_refund: { capture_id: "<capture id from list_transactions>", amount: { currency_code: "USD", value: "20.00" } },
  get_order: { id: "<order id>" },
  pay_order: { id: "<order id>" },
  get_refund: { refund_id: "<refund id>" },
  list_disputes: { dispute_state: "OPEN_INQUIRIES" },
  get_dispute: { dispute_id: "<dispute id>" },
  list_transactions: {},
  check_approval_status: { approval_id: "apr_..." },
  explain_policy: {},
};

export const ARG_TYPE_HINT =
  "Send arguments as one JSON object with native JSON types: arrays as JSON arrays (not strings), numbers as numbers, " +
  "create_refund amount.value as a decimal string. Use the user's real values, not the example's.";

const MAX_ISSUES = 5;

export function formatZodIssues(issues: readonly ZodIssue[]): string[] {
  return issues.slice(0, MAX_ISSUES).map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`.slice(0, 160));
}

/** Concise reasons why the arguments are invalid for this tool, or [] when they are fine. */
export function describeArgIssues(tool: string, args: unknown): string[] {
  const schema = tool === "create_order" ? OrderArgs : tool === "create_refund" ? RefundArgs : null;
  if (schema) {
    const p = schema.safeParse(args);
    if (!p.success) return formatZodIssues(p.error.issues);
  }
  const money = extractMoneyFacts(tool, args);
  return money.ok ? [] : [money.error];
}

/** The model-facing payload for an INVALID_ARGS denial. */
export function invalidArgsFeedback(tool: string, issues: readonly string[]): Record<string, unknown> {
  return {
    issues,
    ...(TOOL_EXAMPLES[tool] ? { example: TOOL_EXAMPLES[tool] } : {}),
    hint: ARG_TYPE_HINT,
  };
}
