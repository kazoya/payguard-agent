import { parseLiteral } from "./literal";

/**
 * Safe argument normalization, applied before validation. Local models often send structured
 * parameters as strings (`"items": "[{'name': 'Mug', ...}]"`) or numbers as strings (`"25.0"`).
 * Only known parameters of known tools are touched, only plain data is accepted (never eval),
 * and the result is still fully validated afterwards: money still goes through the cents and
 * provenance checks in the guard.
 */

type Kind = "array" | "object" | "number";
type Shape = { params: Record<string, Kind>; itemNumbers?: readonly string[] };

const SHAPES: Record<string, Shape> = {
  create_order: {
    params: { items: "array", shippingAddress: "object", discount: "number", shippingCost: "number" },
    itemNumbers: ["itemCost", "itemTotal", "quantity", "taxPercent"],
  },
  create_refund: { params: { amount: "object" } },
  list_disputes: { params: { page_size: "number", page: "number" } },
  list_transactions: { params: { page_size: "number", page: "number", search_months: "number" } },
};

const DECIMAL = /^\s*-?\d{1,12}(?:\.\d{1,12})?\s*$/;

export type Normalized = { args: Record<string, unknown>; notes: string[] };

/** Parses a JSON or Python-style string into a value of the expected kind, or returns undefined. */
export function coerceStructured(raw: string, kind: "array" | "object"): unknown {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    const lit = parseLiteral(raw);
    if (!lit.ok) return undefined;
    v = lit.value;
  }
  const isArray = Array.isArray(v);
  if (kind === "array" && isArray) return v;
  if (kind === "object" && !isArray && typeof v === "object" && v !== null) return v;
  return undefined;
}

function coerceNumber(v: unknown): number | undefined {
  if (typeof v !== "string" || !DECIMAL.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Returns a normalized copy of the arguments plus notes describing every change (for the audit log). */
export function normalizeToolArgs(tool: string, args: Record<string, unknown>): Normalized {
  const shape = SHAPES[tool];
  if (!shape) return { args, notes: [] };
  const out: Record<string, unknown> = { ...args };
  const notes: string[] = [];
  for (const [key, kind] of Object.entries(shape.params)) {
    const v = out[key];
    if (typeof v !== "string") continue;
    const coerced = kind === "number" ? coerceNumber(v) : coerceStructured(v, kind);
    if (coerced === undefined) continue;
    out[key] = coerced;
    notes.push(`${key}: string -> ${kind}`);
  }
  const amount = out.amount;
  if (tool === "create_refund" && typeof amount === "object" && amount !== null && !Array.isArray(amount)) {
    const value = (amount as Record<string, unknown>).value;
    if (typeof value === "number" && Number.isFinite(value)) {
      // String(n) keeps every decimal, so "15.005" is still rejected by the cents check later.
      out.amount = { ...(amount as Record<string, unknown>), value: String(value) };
      notes.push("amount.value: number -> string");
    }
  }
  if (shape.itemNumbers && Array.isArray(out.items)) {
    out.items = out.items.map((item: unknown, i) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
      const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
      for (const f of shape.itemNumbers!) {
        const n = coerceNumber(copy[f]);
        if (n === undefined) continue;
        copy[f] = n;
        notes.push(`items.${i}.${f}: string -> number`);
      }
      return copy;
    });
  }
  return { args: out, notes };
}

/** Parses raw tool-call arguments into an object: JSON first, then the strict literal parser. */
export function parseRawArgs(raw: string): Record<string, unknown> | null {
  const text = raw.trim() === "" ? "{}" : raw;
  const v = coerceStructured(text, "object");
  return v === undefined ? null : (v as Record<string, unknown>);
}
