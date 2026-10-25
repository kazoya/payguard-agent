"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DisplayMessage } from "@/server/chatService";
import { formatMoney } from "@/lib/format";
import { elapsedSeconds, fetchChat, MAX_WAIT_MS, pollTurn, startTurn, type ActiveTurn, type ChatState } from "./chatClient";
import type { Lang } from "@/i18n";
import { useI18n } from "./I18nProvider";
import { CheckoutButton, PlanCard } from "./PlanCard";
import { StatusBadge } from "./StatusBadge";

type T = (key: string, vars?: Record<string, string | number>) => string;
type Turn = { id: string; startedAtMs: number };
type ChatError = { key: string; vars?: Record<string, string | number>; checkAudit: boolean };

const EXAMPLES = ["chat.ex1", "chat.ex2", "chat.ex3", "chat.ex4"];

function hasPending(messages: DisplayMessage[]): boolean {
  return messages.some((m) => m.cards.some((c) => c.status === "pending_approval" && (c.approvalStatus === "PENDING" || c.approvalStatus === "APPROVED")));
}

const turnFrom = (a: ActiveTurn): Turn => ({ id: a.turnId, startedAtMs: Date.parse(a.startedAt) || Date.now() });

/**
 * Chat turns are asynchronous: POST /api/chat returns 202 with a turn id and this view polls
 * GET /api/chat/turns/:id until the agent finishes, so slow local models never hit a proxy timeout.
 */
export function ChatView({ userId }: { userId: string }) {
  const { lang, t } = useI18n();
  const [state, setState] = useState<ChatState>({ conversationId: null, messages: [] });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [failures, setFailures] = useState(0);
  const [error, setError] = useState<ChatError | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  /** Loads a conversation; resumes polling if it has a turn in flight (e.g. after a page reload). */
  const load = useCallback(async (conversationId: string | null): Promise<boolean> => {
    const chat = await fetchChat(fetch, conversationId);
    if (!chat) return false;
    setState(chat);
    if (chat.activeTurn) setTurn((cur) => (cur?.id === chat.activeTurn!.turnId ? cur : turnFrom(chat.activeTurn!)));
    return true;
  }, []);

  useEffect(() => { void load(null); }, [load, userId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [state.messages.length, turn?.id]);

  // Poll the in-flight turn until it is done or failed.
  const turnId = turn?.id ?? null;
  useEffect(() => {
    if (!turnId) return;
    const ac = new AbortController();
    void pollTurn(turnId, {
      fetchFn: fetch,
      signal: ac.signal,
      onUpdate: (tu, f) => {
        setFailures(f);
        if (tu) setState((s) => ({ ...s, conversationId: tu.conversationId, messages: tu.messages }));
      },
    }).then((out) => {
      if (out.kind === "aborted") return;
      if (out.kind === "done" || out.kind === "error") setState({ conversationId: out.turn.conversationId, messages: out.turn.messages });
      if (out.kind === "error") setError({ key: "chat.turnError", checkAudit: true });
      if (out.kind === "gone") setError({ key: "chat.turnError", checkAudit: true });
      if (out.kind === "timeout") setError({ key: "chat.turnTimeout", vars: { minutes: Math.round(MAX_WAIT_MS / 60_000) }, checkAudit: true });
      setFailures(0);
      setTurn(null);
    });
    return () => ac.abort();
  }, [turnId]);

  // Elapsed-seconds ticker for the thinking indicator.
  useEffect(() => {
    if (!turnId) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [turnId]);

  // Poll while an approval is outstanding so the executed result appears without a manual refresh.
  useEffect(() => {
    if (turnId || !state.conversationId || !hasPending(state.messages)) return;
    const id = setInterval(() => void load(state.conversationId), 4000);
    return () => clearInterval(id);
  }, [state, load, turnId]);

  const busy = sending || turn !== null;

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setSending(true);
    setError(null);
    try {
      const r = await startTurn(fetch, { conversationId: state.conversationId ?? undefined, text: message, lang });
      if (r.kind === "started") {
        setState({ conversationId: r.conversationId, messages: r.messages });
        setTurn({ id: r.turnId, startedAtMs: Date.now() });
        setText("");
      } else if (r.kind === "busy") {
        setError({ key: "chat.busy", checkAudit: false });
        await load(state.conversationId);
      } else if (r.kind === "rejected") {
        setError({ key: "chat.rejected", vars: { status: r.status }, checkAudit: false });
      } else {
        // The response was lost or unreadable: the turn may have started. Reload to find out.
        const chat = await fetchChat(fetch, state.conversationId);
        if (chat) setState(chat);
        if (chat?.activeTurn) {
          setTurn(turnFrom(chat.activeTurn));
          setText("");
        } else {
          setError({ key: "chat.error", checkAudit: true });
        }
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("chat.title")}</h1>
        <button type="button" disabled={busy} onClick={() => { setState({ conversationId: null, messages: [] }); setError(null); }}
          className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-50">{t("chat.new")}</button>
      </div>

      <div data-testid="chat-log" className="flex min-h-[18rem] flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
        {state.messages.length === 0 && !turn && <p className="text-sm text-slate-500">{t("chat.empty")}</p>}
        {state.messages.map((m) => <Message key={m.id} m={m} lang={lang} t={t} />)}
        {turn && (
          <div data-testid="chat-thinking" role="status" aria-live="polite" className="flex flex-col items-start">
            <span className="mb-1 text-xs text-slate-500">{t("chat.agent")}</span>
            <div className="flex items-center gap-2 rounded-2xl bg-slate-100 px-4 py-2 text-sm text-slate-700">
              <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-sky-600" />
              <span>{t("chat.thinking", { seconds: elapsedSeconds(turn.startedAtMs, now) })}</span>
            </div>
            <span className="mt-1 text-xs text-slate-500">{failures >= 2 ? t("chat.reconnecting") : t("chat.thinkingHint")}</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          {t(error.key, error.vars)}
          {error.checkAudit && (
            <>
              {" "}<a href="/audit" className="font-semibold underline">{t("nav.audit")}</a>
              {" · "}<a href="/approvals" className="font-semibold underline">{t("nav.approvals")}</a>
            </>
          )}
        </p>
      )}

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
        {n.checkoutUrl && <CheckoutButton url={n.checkoutUrl} t={t} />}
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
