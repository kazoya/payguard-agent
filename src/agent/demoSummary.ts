import { reasonText } from "@/i18n/reasons";
import { say, type Lang } from "./demoText";

/** Turns guarded tool results (orchestrator `toModelResult` JSON) into a short reply. */

type R = { status?: string; tool?: string; data?: unknown; checkout_url?: string; capture?: { id?: string; status?: string | null }; rule?: string; reason?: string; approval_id?: string; error?: { code?: string; message?: string } };
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});
const s = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

function executed(r: R, lang: Lang): string {
  const d = obj(r.data);
  switch (r.tool) {
    case "create_refund":
      return say(lang, "done.refund", { value: s(obj(d.amount).value), id: s(d.id), status: s(d.status) });
    case "create_order": {
      // Only the verified link the guard returned (never PayPal's raw links or model text).
      return r.checkout_url
        ? say(lang, "done.createOrder", { id: s(d.id), status: s(d.status), link: r.checkout_url })
        : say(lang, "done.createOrderNoLink", { id: s(d.id), status: s(d.status) });
    }
    case "pay_order":
      return say(lang, "done.capture", { id: s(d.id), status: s(d.status), captureId: s(r.capture?.id) ?? "-", captureStatus: s(r.capture?.status) ?? "-" });
    case "get_order":
      return say(lang, "done.getOrder", { id: s(d.id), status: s(d.status) });
    case "explain_policy": {
      const rules = Array.isArray(d.rules) ? (d.rules as { id: string; decision: string; reason?: string }[]) : [];
      return [say(lang, "done.policyHead", { cap: s(d.daily_refund_cap) }), ...rules.map((x) => `- ${x.id}: ${x.decision}${x.reason ? ` (${reasonText(lang, x.id, x.reason)})` : ""}`)].join("\n");
    }
    case "check_approval_status":
      return say(lang, "done.approvalStatus", { id: s(d.approval_id), status: s(d.status) });
    default: {
      const list = [d.items, d.transaction_details].find(Array.isArray) as unknown[] | undefined;
      const lines = (list ?? []).slice(0, 6).map(listLine).filter(Boolean);
      return [say(lang, "done.list", { n: list?.length ?? 0 }), ...lines].join("\n");
    }
  }
}

type Money = { currency_code?: string; value?: string };
const amt = (m: Money | undefined) => (m?.value ? `${m.value} ${m.currency_code ?? ""}`.trim() : "");

/** One language-neutral line per Transaction Search or Disputes item (ids, amounts, status codes). */
function listLine(item: unknown): string {
  const o = (item ?? {}) as Record<string, unknown>;
  const tx = o.transaction_info as { transaction_id?: string; transaction_event_code?: string; transaction_amount?: Money; transaction_initiation_date?: string } | undefined;
  if (tx) return `- ${tx.transaction_id ?? "?"} · ${tx.transaction_event_code ?? ""} · ${amt(tx.transaction_amount)} · ${(tx.transaction_initiation_date ?? "").slice(0, 10)}`;
  if (typeof o.dispute_id === "string") return `- ${o.dispute_id} · ${String(o.reason ?? "")} · ${String(o.status ?? "")} · ${amt(o.dispute_amount as Money | undefined)}`;
  return "";
}

export function summarizeResults(results: unknown[], lang: Lang): string {
  return results
    .map((x) => {
      const r = x as R;
      switch (r.status) {
        case "executed":
          return executed(r, lang);
        case "pending_approval":
          return say(lang, "pending", { reason: reasonText(lang, r.rule, r.reason) ?? undefined, id: r.approval_id });
        case "denied":
          return say(lang, "denied", { rule: r.rule, reason: reasonText(lang, r.rule, r.reason) ?? undefined });
        default:
          return say(lang, "failed", { code: r.error?.code, message: r.error?.message ?? "" });
      }
    })
    .join("\n\n");
}
