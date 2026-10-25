"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DisplayMessage } from "@/server/chatService";
import { formatMoney } from "@/lib/format";
import type { Lang } from "@/i18n";
import { useI18n } from "./I18nProvider";
import { PlanCard } from "./PlanCard";
import { StatusBadge } from "./StatusBadge";

type T = (key: string, vars?: Record<string, string | number>) => string;
type ChatState = { conversationId: string | null; messages: DisplayMessage[] };

const EXAMPLES = ["chat.ex1", "chat.ex2", "chat.ex3", "chat.ex4"];

function hasPending(messages: DisplayMessage[]): boolean {
  return messages.some((m) => m.cards.some((c) => c.status === "pending_approval" && (c.approvalStatus === "PENDING" || c.approvalStatus === "APPROVED")));
}

export function ChatView({ userId }: { userId: string }) {
  const { lang, t } = useI18n();
  const [state, setState] = useState<ChatState>({ conversationId: null, messages: [] });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (conversationId: string | null) => {
    const q = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
    const res = await fetch(`/api/chat${q}`, { cache: "no-store" });
    if (res.ok) setState((await res.json()) as ChatState);
  }, []);

  useEffect(() => { void load(null); }, [load, userId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [state.messages.length]);

  // Poll while an approval is outstanding so the executed result appears without a manual refresh.
  useEffect(() => {
    if (!state.conversationId || !hasPending(state.messages)) return;
    const id = setInterval(() => void load(state.conversationId), 4000);
    return () => clearInterval(id);
  }, [state, load]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: state.conversationId ?? undefined, text: message, lang }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState((await res.json()) as ChatState);
      setText("");
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("chat.title")}</h1>
        <button type="button" onClick={() => setState({ conversationId: null, messages: [] })}
          className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100">{t("chat.new")}</button>
      </div>

      <div data-testid="chat-log" className="flex min-h-[18rem] flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
        {state.messages.length === 0 && <p className="text-sm text-slate-500">{t("chat.empty")}</p>}
        {state.messages.map((m) => <Message key={m.id} m={m} lang={lang} t={t} />)}
        <div ref={endRef} />
      </div>

      {error && <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">{t("chat.error")}</p>}

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <textarea data-testid="chat-input" value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder={t("chat.placeholder")}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }}
          className="min-w-0 flex-1 resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none" />
        <button type="submit" disabled={busy || !text.trim()}
          className="rounded-lg bg-sky-700 px-5 text-sm font-semibold text-white disabled:opacity-50">{busy ? t("chat.sending") : t("chat.send")}</button>
      </form>
      <p className="text-xs text-slate-500">{t("chat.customerHint")}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">{t("chat.examples")}:</span>
        {EXAMPLES.map((k) => (
          <button key={k} type="button" dir="auto" onClick={() => setText(t(k))}
            className="max-w-full truncate rounded-full bg-slate-100 px-3 py-1 text-slate-700 hover:bg-slate-200">{t(k)}</button>
        ))}
      </div>
    </section>
  );
}

function Message({ m, lang, t }: { m: DisplayMessage; lang: Lang; t: T }) {
  if (m.role === "notice" && m.notice) {
    const n = m.notice;
    return (
      <div data-testid="approval-notice" className="flex flex-wrap items-center gap-2 self-center rounded-lg bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200">
        <StatusBadge status={n.status} label={t(`approvals.status.${n.status}`)} />
        <span>{t(`tool.${n.tool}`)} {formatMoney(n.amountMinor, n.currency, lang)}</span>
        <span className="text-slate-600">{t(`notice.${n.status}`, { by: n.decidedBy })}</span>
        {n.note && <span className="text-slate-500">“{n.note}”</span>}
        {n.resultId && <bdi dir="ltr" className="font-mono text-xs">{n.resultId}</bdi>}
      </div>
    );
  }
  const mine = m.role === "user";
  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <span className="mb-1 text-xs text-slate-500">{mine ? t("chat.you") : t("chat.agent")}</span>
      {m.cards.length > 0 && (
        <div className="w-full max-w-[85%] mb-2">{m.cards.map((c) => <PlanCard key={c.callId} card={c} lang={lang} t={t} />)}</div>
      )}
      <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${mine ? "bg-sky-700 text-white" : "bg-slate-100 text-slate-900"}`}>
        {/* Per-line direction so mixed Arabic/English replies (ids, policy rules) stay readable. */}
        {m.text.split("\n").map((line, i) => <span key={i} dir="auto" className="block">{line || "\u00a0"}</span>)}
      </div>
    </div>
  );
}
