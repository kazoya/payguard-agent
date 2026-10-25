/**
 * Deterministic intent parser used by the demo/mock LLM and the eval suite.
 * It is deliberately naive: it reads the WHOLE message, including <customer_message> content,
 * like a model that fell for a prompt injection. PayGuard's provenance check must catch that.
 */

import { normalizeDigits } from "@/guard/provenance";
import arWords from "@/i18n/intent.ar.json";
import type { Lang } from "./demoText";

export type { Lang };

export type Intent =
  | { kind: "refund"; captureId: string | null; amount: string | null; full: boolean }
  | { kind: "create_order"; amount: string | null; itemName: string }
  | { kind: "capture"; orderId: string | null }
  | { kind: "get_order"; orderId: string | null }
  | { kind: "list_transactions" }
  | { kind: "list_disputes" }
  | { kind: "policy" }
  | { kind: "approval_status"; approvalId: string }
  | { kind: "help" };

const ARABIC_CHARS = /[\u0600-\u06FF]/;

export function detectLang(text: string): Lang {
  return ARABIC_CHARS.test(text.replace(/<customer_message>[\s\S]*?(<\/customer_message>|$)/gi, "")) ? "ar" : "en";
}

export { normalizeDigits };

const ID = /\b[A-Z0-9][A-Z0-9_-]{7,}\b/g;
const APPROVAL_ID = /\bapr_[0-9a-f-]{36}\b/i;

export function idsIn(text: string): string[] {
  return [...text.matchAll(ID)].map((m) => m[0]).filter((s) => /\d/.test(s) || s.includes("_"));
}

/** First money amount in the text, ignoring digits that are part of ids. */
export function firstAmount(text: string): string | null {
  const withoutIds = text.replace(ID, " ").replace(APPROVAL_ID, " ");
  const m = withoutIds.match(/(\d[\d,]*(?:\.\d{1,2})?)/);
  return m?.[1] ? m[1].replace(/,/g, "") : null;
}

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** English stems match at a word start; Arabic phrases (from i18n) match anywhere. */
function words(en: string[], ar: string[]): RegExp {
  return new RegExp([...en.map((w) => `\\b${w}`), ...ar.map(escape)].join("|"), "i");
}

const RE = {
  refund: words(["refund", "reimburse"], arWords.refund),
  full: words(["full(y)?\\b", "entire", "whole"], arWords.full),
  createOrder: words(["(create|new|make|open)\\b[^.]*\\border\\b", "invoice", "charge\\b"], arWords.createOrder),
  capture: words(["capture\\b", "collect\\b"], arWords.capture),
  transactions: words(["transactions?\\b"], arWords.transactions),
  disputes: words(["disputes?\\b"], arWords.disputes),
  policy: words(["policy\\b", "rules?\\b", "limits?\\b"], arWords.policy),
  order: words(["order\\b"], arWords.order),
};

const ITEM_AR = new RegExp(`(?:${arWords.itemFor.map(escape).join("|")}) ?([\\u0600-\\u06FF ]{2,30}?)(?: \\d|\\u060C|$)`);

const has = (re: RegExp, s: string) => re.test(s);

export function parseIntent(raw: string): Intent {
  const text = normalizeDigits(raw);
  const lower = text.toLowerCase();
  const ids = idsIn(text);
  const amount = firstAmount(text);
  const approval = text.match(APPROVAL_ID);

  if (approval) return { kind: "approval_status", approvalId: approval[0] };
  if (has(RE.policy, lower) && ids.length === 0 && amount === null) return { kind: "policy" };
  if (has(RE.refund, lower)) return { kind: "refund", captureId: ids[0] ?? null, amount, full: has(RE.full, lower) };
  if (has(RE.createOrder, lower)) {
    const name = text.match(/\bfor (?:an? |the )?([A-Za-z][A-Za-z -]{1,40}?)(?: at| for| of|,|\.|$)/)?.[1]?.trim()
      ?? text.match(ITEM_AR)?.[1]?.trim()
      ?? "Item";
    return { kind: "create_order", amount, itemName: name };
  }
  if (has(RE.capture, lower)) return { kind: "capture", orderId: ids[0] ?? null };
  if (has(RE.transactions, lower)) return { kind: "list_transactions" };
  if (has(RE.disputes, lower)) return { kind: "list_disputes" };
  if (has(RE.policy, lower)) return { kind: "policy" };
  if (has(RE.order, lower) && ids[0]) return { kind: "get_order", orderId: ids[0] };
  return { kind: "help" };
}
