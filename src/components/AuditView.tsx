"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditRow, VerifyResult } from "@/audit/log";
import { formatTime } from "@/lib/format";
import { useI18n } from "./I18nProvider";

export function AuditView() {
  const { lang, t } = useI18n();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [event, setEvent] = useState("");
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/audit?limit=500", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { total: number; rows: AuditRow[] };
      setRows(body.rows);
      setTotal(body.total);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function runVerify() {
    try {
      const res = await fetch("/api/audit/verify", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      setVerify((await res.json()) as VerifyResult);
    } catch {
      setState("error");
      return;
    }
    await load();
  }

  const events = useMemo(() => [...new Set(rows.map((r) => r.event))].sort(), [rows]);
  const shown = event ? rows.filter((r) => r.event === event) : rows;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("audit.title")}</h1>
        <p className="text-sm text-slate-600">{t("audit.subtitle")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-testid="verify-btn" onClick={() => void runVerify()} className="rounded-md bg-sky-700 px-3 py-1.5 text-sm font-semibold text-white">{t("audit.verify")}</button>
        <a href="/api/audit/export?format=json" className="rounded-md bg-white px-3 py-1.5 text-sm ring-1 ring-slate-300">{t("audit.exportJson")}</a>
        <a href="/api/audit/export?format=csv" className="rounded-md bg-white px-3 py-1.5 text-sm ring-1 ring-slate-300">{t("audit.exportCsv")}</a>
        <label className="ms-auto flex items-center gap-2 text-sm text-slate-600">
          {t("audit.filter")}
          <select value={event} onChange={(e) => setEvent(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
            <option value="">{t("audit.filterAll")} ({total})</option>
            {events.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>
      </div>
      {verify && (
        <p data-testid="verify-result" role="status"
          className={`rounded-md px-3 py-2 text-sm font-medium ring-1 ${verify.ok ? "bg-emerald-50 text-emerald-900 ring-emerald-200" : "bg-rose-50 text-rose-900 ring-rose-200"}`}>
          {verify.ok ? `✓ ${t("audit.intact", { n: verify.count })}` : `✗ ${t("audit.broken", { seq: verify.firstBadSeq, reason: verify.reason })}`}
        </p>
      )}
      {state === "error" && <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">{t("error.loadFailed")}</p>}
      {state === "loading" ? <p className="text-sm text-slate-500">{t("common.loading")}</p> : shown.length === 0 ? (
        <p data-testid="audit-empty" className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">{t("audit.emptyHint")}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-start text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>{["seq", "time", "actor", "event", "tool", "decision", "detail", "hash"].map((h) => <th key={h} className="px-3 py-2 text-start">{t(`audit.${h}`)}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.seq} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-1.5 font-mono">{r.seq}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">{formatTime(r.ts, lang)}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{r.actor}</td>
                  <td className="px-3 py-1.5 font-semibold">{r.event}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{r.tool ?? ""}</td>
                  <td className="px-3 py-1.5 text-xs">{r.decision ?? ""}</td>
                  <td className="max-w-xs truncate px-3 py-1.5 font-mono text-xs text-slate-600" dir="ltr" title={r.detail_json ?? ""}>{r.detail_json ?? ""}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-400" dir="ltr">{r.hash.slice(0, 10)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
