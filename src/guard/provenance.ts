import type { Provenance } from "./policyEngine";

/**
 * Prompt-injection guard (SPEC section 7, "Provenance").
 * A user turn is trusted text, except spans wrapped in <customer_message>...</customer_message>,
 * which are untrusted (pasted customer emails, notes). For a sensitive call, every amount and every
 * PayPal id in the arguments must come from trusted text or from PayPal objects the tool layer
 * already knows. A value that only appears in untrusted text, or nowhere, makes the call untrusted.
 * Amounts are never taken from tool results: dispute messages and notes are customer-controlled.
 */

const UNTRUSTED_SPAN = /<customer_message>([\s\S]*?)(?:<\/customer_message>|$)/gi;

export type TaggedText = { trusted: string; untrusted: string };

export function splitTrustedText(userText: string): TaggedText {
  const untrusted: string[] = [];
  const trusted = userText.replace(UNTRUSTED_SPAN, (_m, inner: string) => {
    untrusted.push(inner);
    return " ";
  });
  return { trusted, untrusted: untrusted.join("\n") };
}

const INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

/** Maps Arabic-Indic and Persian digits (and the Arabic decimal/thousands marks) to ASCII. */
export function normalizeDigits(text: string): string {
  return text
    .replace(INDIC_DIGITS, (d) => String(d.charCodeAt(0) - (d.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660)))
    .replace(/\u066B/g, ".")
    .replace(/\u066C/g, ",");
}

/** All money-looking numbers in a text, as minor units ("$1,200.5" -> 120050). Indic digits count too. */
export function amountsInText(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of normalizeDigits(text).matchAll(/\d[\d,]*(?:\.\d{1,2})?(?!\d)/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(Math.round(n * 100));
  }
  return out;
}

export type ProvenanceContext = {
  /** Trusted text of the conversation so far (user turns minus untrusted spans). */
  trustedText: string;
  /** Raw tool-result text from this conversation: ids seen there were fetched from PayPal. */
  fetchedText: string;
  isKnownObject: (id: string) => boolean;
  knownAmountsMinor: Set<number>;
};

type Claims = { ids: string[]; amountsMinor: number[] };

const toMinor = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

export function claimsOf(tool: string, args: Record<string, unknown>): Claims {
  const ids: string[] = [];
  const amounts: number[] = [];
  const pushId = (v: unknown) => typeof v === "string" && v.length > 0 && ids.push(v);
  const pushAmount = (v: unknown) => {
    const m = toMinor(v);
    if (m !== null && m > 0) amounts.push(m);
  };
  if (tool === "create_refund") {
    pushId(args.capture_id);
    pushAmount((args.amount as { value?: unknown } | undefined)?.value);
  } else if (tool === "pay_order") {
    pushId(args.id);
  } else if (tool === "create_order") {
    for (const item of Array.isArray(args.items) ? args.items : []) pushAmount((item as { itemCost?: unknown }).itemCost);
    pushAmount(args.shippingCost);
    pushAmount(args.discount);
  } else if (tool === "accept_dispute_claim") {
    pushId(args.dispute_id ?? args.id);
  }
  return { ids, amountsMinor: amounts };
}

export function deriveProvenance(tool: string, args: Record<string, unknown>, ctx: ProvenanceContext): Provenance {
  const { ids, amountsMinor } = claimsOf(tool, args);
  const trustedAmounts = amountsInText(ctx.trustedText);
  for (const id of ids) {
    if (!ctx.trustedText.includes(id) && !ctx.fetchedText.includes(id) && !ctx.isKnownObject(id)) return "untrusted";
  }
  for (const a of amountsMinor) {
    if (!trustedAmounts.has(a) && !ctx.knownAmountsMinor.has(a)) return "untrusted";
  }
  return "trusted";
}
