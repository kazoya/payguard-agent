"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApprovalView } from "@/server/api/approvals";
import type { DemoUser } from "@/server/users";
import { errorText, reasonText } from "@/i18n/reasons";
import { formatMoney, formatTime } from "@/lib/format";
import { useI18n } from "./I18nProvider";
import { StatusBadge } from "./StatusBadge";

type Filter = "PENDING" | "ALL";

export function ApprovalsView({ user }: { user: DemoUser }) {
  const { lang, t } = useI18n();
  const [filter, setFilter] = useState<Filter>("PENDING");
  const [items, setItems] = useState<ApprovalView[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/approvals${filter === "PENDING" ? "?status=PENDING" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setItems(((await res.json()) as { approvals: ApprovalView[] }).approvals);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load, user.id]);

  async function decide(id: string, action: "approve" | "reject", reason?: string) {
    let res: Response;
    let body: { approval?: ApprovalView; error?: { code: string; message: string } };
    try {
      res = await fetch(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "reject" ? { reason: reason ?? "" } : {}),
      });
      body = (await res.json()) as typeof body;
    } catch {
      setMessage({ ok: false, text: t("error.loadFailed") });
      return;
    }
    setMessage(res.ok && body.approval
      ? { ok: body.approval.status === "EXECUTED" || body.approval.status === "REJECTED", text: `${t(`approvals.status.${body.approval.status}`)} · ${id.slice(0, 12)}…` }
      : { ok: false, text: errorText(lang, body.error?.code) ?? `${body.error?.code ?? res.status}: ${body.error?.message ?? t("error.generic")}` });
    await load();
  }

  const canDecide = user.role === "approver" || user.role === "owner";
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("approvals.title")}</h1>
        <p className="text-sm text-slate-600">{t("approvals.subtitle")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(["PENDING", "ALL"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)}
            className={`rounded-md px-3 py-1 text-sm ${filter === f ? "bg-sky-700 text-white" : "bg-white ring-1 ring-slate-300"}`}>
            {t(`approvals.filter.${f}`)}
          </button>
        ))}
        <button type="button" onClick={() => void load()} className="ms-auto rounded-md bg-white px-3 py-1 text-sm ring-1 ring-slate-300">{t("approvals.refresh")}</button>
      </div>
      {!canDecide && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">{t("approvals.notAllowedRole")}</p>}
      {message && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ring-1 ${message.ok ? "bg-emerald-50 text-emerald-900 ring-emerald-200" : "bg-rose-50 text-rose-900 ring-rose-200"}`}>{message.text}</p>
      )}
      {state === "loading" && <p className="text-sm text-slate-500">{t("common.loading")}</p>}
      {state === "error" && <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">{t("error.loadFailed")}</p>}
      {state === "ready" && items.length === 0 && (
        <p data-testid="approvals-empty" className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          {t(filter === "PENDING" ? "approvals.emptyPending" : "approvals.empty")}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {items.map((a) => <ApprovalItem key={a.id} a={a} user={user} canDecide={canDecide} onDecide={decide} lang={lang} t={t} />)}
      </ul>
    </section>
  );
}

type ItemProps = {
  a: ApprovalView; user: DemoUser; canDecide: boolean; lang: "en" | "ar";
  onDecide: (id: string, action: "approve" | "reject", reason?: string) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

function ApprovalItem({ a, user, canDecide, onDecide, lang, t }: ItemProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const own = a.requested_by === user.id;
  const run = async (action: "approve" | "reject") => { setBusy(true); await onDecide(a.id, action, reason); setBusy(false); };
  const target = (a.args as Record<string, unknown>).capture_id ?? (a.args as Record<string, unknown>).id;
  const result = a.result as { id?: string; status?: string } | null;

  return (
    <li data-testid="approval-item" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={a.status} label={t(`approvals.status.${a.status}`)} />
        <span className="font-semibold">{t(`tool.${a.tool}`)} {formatMoney(a.amount_minor, a.currency, lang)}</span>
        {typeof target === "string" && <bdi dir="ltr" className="font-mono text-xs text-slate-600">{target}</bdi>}
        <bdi dir="ltr" className="ms-auto font-mono text-xs text-slate-400">{a.id.slice(0, 16)}…</bdi>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="inline text-slate-500">{t("approvals.requestedBy")}: </dt><dd className="inline">{a.requested_by_name}</dd></div>
        <div><dt className="inline text-slate-500">{t("card.rule")}: </dt><dd className="inline font-mono text-xs">{a.policy_rule}</dd></div>
        <div className="sm:col-span-2"><dt className="inline text-slate-500">{t("card.why")}: </dt><dd className="inline">{reasonText(lang, a.policy_rule, a.reason)}</dd></div>
        <div><dt className="inline text-slate-500">{t("approvals.created")}: </dt><dd className="inline">{formatTime(a.created_at, lang)}</dd></div>
        <div><dt className="inline text-slate-500">{t("approvals.expires")}: </dt><dd className="inline">{formatTime(a.expires_at, lang)}</dd></div>
        {a.decided_by_name && <div><dt className="inline text-slate-500">{t("approvals.decidedBy")}: </dt><dd className="inline">{a.decided_by_name}</dd></div>}
        {a.decision_note && <div><dt className="inline text-slate-500">{t("approvals.note")}: </dt><dd className="inline">{a.decision_note}</dd></div>}
        {result?.id && <div><dt className="inline text-slate-500">{t("card.result")}: </dt><dd className="inline font-mono text-xs">{result.id} {result.status}</dd></div>}
      </dl>
      {a.status === "PENDING" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {own && <p className="w-full text-xs text-slate-500">{t("approvals.selfRequest")}</p>}
          <button type="button" data-testid="approve-btn" disabled={!canDecide || own || busy} onClick={() => void run("approve")}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">{t("approvals.approve")}</button>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("approvals.reasonPlaceholder")} disabled={!canDecide || own || busy}
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
          <button type="button" data-testid="reject-btn" disabled={!canDecide || own || busy || !reason.trim()} onClick={() => void run("reject")}
            className="rounded-md bg-rose-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">{t("approvals.reject")}</button>
        </div>
      )}
    </li>
  );
}
