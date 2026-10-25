import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { runAgentTurn } from "@/agent/orchestrator";
import { appendTurn, createConversation, displayMessages, getConversation, historyFor, latestConversation } from "../chatService";
import { completeTurn, failTurn, getTurn, insertPendingTurn, pendingTurn, type ChatTurnRow } from "../chatTurns";
import type { Runtime } from "../runtime";
import type { DemoUser } from "../users";
import { apiError, json, parseBody, type ApiResponse } from "./http";

/**
 * Chat API. A turn with a local LLM can take minutes, longer than a proxy such as a Cloudflare quick
 * tunnel keeps a request open (~100 s), so turns are asynchronous:
 *   POST /api/chat               validates, stores the user message, starts the turn in the background → 202 { conversationId, turnId }
 *   GET  /api/chat/turns/:id     → { status: pending | done | error, messages, stoppedAtLimit }
 *   GET  /api/chat               → the conversation plus its `activeTurn`, so a reloaded page resumes polling
 * One pending turn per conversation (409 TURN_IN_PROGRESS otherwise). Audit behaviour is unchanged:
 * every guarded tool call is audited by PolicyGuard as before.
 */

const PostChat = z.object({
  conversationId: z.string().min(1).max(100).optional(),
  text: z.string().trim().min(1).max(4000),
  lang: z.enum(["en", "ar"]).default("en"),
});

const actorOf = (u: DemoUser) => ({ id: u.id, role: u.role });

export type ActiveTurn = { turnId: string; startedAt: string };

export type TurnBody = {
  turnId: string;
  conversationId: string;
  status: ChatTurnRow["status"];
  startedAt: string;
  finishedAt: string | null;
  error: { code: string } | null;
  messages: ReturnType<typeof displayMessages>;
  stoppedAtLimit: boolean;
};

/**
 * A pending row with no task in this process cannot finish (the task died with a hot reload or an
 * earlier process); report it as interrupted instead of letting the UI poll forever.
 */
function settle(rt: Runtime, turn: ChatTurnRow): ChatTurnRow {
  if (turn.status !== "pending" || rt.turnTasks.has(turn.id)) return turn;
  failTurn(rt.db, turn.id, "INTERRUPTED", rt.clock);
  return getTurn(rt.db, turn.id) ?? turn;
}

function activeTurnOf(rt: Runtime, conversationId: string): ActiveTurn | null {
  const p = pendingTurn(rt.db, conversationId);
  if (!p || settle(rt, p).status !== "pending") return null;
  return { turnId: p.id, startedAt: p.created_at };
}

/** GET: the user's conversation (explicit id or their latest), rendered for the UI. */
export function getChat(rt: Runtime, user: DemoUser, conversationId: string | null): ApiResponse {
  const conv = conversationId ? getConversation(rt.db, conversationId) : latestConversation(rt.db, user.id);
  if (!conv) return json(200, { conversationId: null, messages: [], activeTurn: null });
  if (conv.user_id !== user.id) return apiError(404, "NOT_FOUND", "Conversation not found.");
  return json(200, { conversationId: conv.id, messages: displayMessages(rt.db, conv.id, rt.approvals), activeTurn: activeTurnOf(rt, conv.id) });
}

/** GET /api/chat/turns/:id: status of one turn; only its owner can see it. */
export function getChatTurn(rt: Runtime, user: DemoUser, turnId: string): ApiResponse {
  const row = getTurn(rt.db, turnId);
  if (!row || row.user_id !== user.id) return apiError(404, "NOT_FOUND", "Turn not found.");
  return json(200, turnBody(rt, settle(rt, row)));
}

function turnBody(rt: Runtime, t: ChatTurnRow): TurnBody {
  return {
    turnId: t.id, conversationId: t.conversation_id, status: t.status, startedAt: t.created_at, finishedAt: t.finished_at,
    error: t.error_code ? { code: t.error_code } : null,
    messages: displayMessages(rt.db, t.conversation_id, rt.approvals), stoppedAtLimit: t.stopped_at_limit === 1,
  };
}

type Started = { ok: true; conversationId: string; turnId: string; done: Promise<void> } | { ok: false; error: ApiResponse };

/**
 * Validates, stores the user message and a pending turn in one transaction, then runs the agent in
 * the background. Synchronous up to the insert, so two concurrent POSTs cannot both start a turn.
 */
function beginTurn(rt: Runtime, user: DemoUser, body: unknown): Started {
  const parsed = parseBody(PostChat, body);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { text, lang } = parsed.value;

  let conversationId = parsed.value.conversationId ?? null;
  if (conversationId) {
    const conv = getConversation(rt.db, conversationId);
    if (!conv || conv.user_id !== user.id) return { ok: false, error: apiError(404, "NOT_FOUND", "Conversation not found.") };
  } else {
    conversationId = createConversation(rt.db, user.id, lang, rt.clock);
  }
  const busy = (turnId: string): Started => ({
    ok: false,
    error: json(409, { error: { code: "TURN_IN_PROGRESS", message: "The previous message in this conversation is still being processed.", turnId } }),
  });
  const active = activeTurnOf(rt, conversationId);
  if (active) return busy(active.turnId);

  // History is read before the new message is stored; the orchestrator appends the user message itself.
  const history = historyFor(rt.db, conversationId);
  const userMsg: ChatCompletionMessageParam = { role: "user", content: text };
  const convId = conversationId;
  const turnId = rt.db.transaction(() => {
    const id = insertPendingTurn(rt.db, convId, user.id, rt.clock);
    if (id) appendTurn(rt.db, convId, [userMsg], [], rt.clock);
    return id;
  })();
  if (!turnId) return busy(pendingTurn(rt.db, convId)?.id ?? "");

  const done = runInBackground(rt, user, convId, turnId, history, text);
  return { ok: true, conversationId: convId, turnId, done };
}

function runInBackground(rt: Runtime, user: DemoUser, conversationId: string, turnId: string, history: ChatCompletionMessageParam[], text: string): Promise<void> {
  const task = (async () => {
    try {
      const turn = await runAgentTurn(
        { llm: rt.llm, guard: rt.guard, approvals: rt.approvals, store: rt.store, policy: rt.policy, paypalTools: rt.paypalTools },
        { actor: actorOf(user), conversationId, history, userText: text },
      );
      // messages = [system, ...history, user, ...new]; the user message is already stored.
      rt.db.transaction(() => {
        appendTurn(rt.db, conversationId, turn.messages.slice(2 + history.length), turn.cards, rt.clock);
        completeTurn(rt.db, turnId, turn.stoppedAtLimit, rt.clock);
      })();
    } catch (e) {
      console.error("[payguard] chat turn failed:", e instanceof Error ? `${e.name}: ${e.message}` : "unknown error");
      try {
        failTurn(rt.db, turnId, "AGENT_FAILED", rt.clock);
      } catch (e2) {
        console.error("[payguard] could not mark chat turn as failed:", e2 instanceof Error ? e2.message : "unknown error");
      }
    } finally {
      rt.turnTasks.delete(turnId);
    }
  })();
  rt.turnTasks.set(turnId, task);
  return task;
}

/** POST /api/chat: start one agent turn and return 202 at once. History comes from the DB, never from the request. */
export async function postChat(rt: Runtime, user: DemoUser, body: unknown): Promise<ApiResponse> {
  const s = beginTurn(rt, user, body);
  if (!s.ok) return s.error;
  return json(202, {
    conversationId: s.conversationId, turnId: s.turnId, status: "pending",
    messages: displayMessages(rt.db, s.conversationId, rt.approvals),
  });
}

/**
 * In-process callers (demo seed, eval runner, tests): start a turn and wait for it. Same code path
 * as POST; returns 200 with the finished turn, or 500 if the turn failed.
 */
export async function chatAndWait(rt: Runtime, user: DemoUser, body: unknown): Promise<ApiResponse> {
  const s = beginTurn(rt, user, body);
  if (!s.ok) return s.error;
  await s.done;
  const row = getTurn(rt.db, s.turnId)!;
  if (row.status !== "done") return apiError(500, row.error_code ?? "AGENT_FAILED", "The agent turn failed.");
  return json(200, turnBody(rt, row));
}
