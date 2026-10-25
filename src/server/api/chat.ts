import { z } from "zod";
import { runAgentTurn } from "@/agent/orchestrator";
import { appendTurn, createConversation, displayMessages, getConversation, historyFor, latestConversation } from "../chatService";
import type { Runtime } from "../runtime";
import type { DemoUser } from "../users";
import { apiError, json, parseBody, type ApiResponse } from "./http";

const PostChat = z.object({
  conversationId: z.string().min(1).max(100).optional(),
  text: z.string().trim().min(1).max(4000),
  lang: z.enum(["en", "ar"]).default("en"),
});

const actorOf = (u: DemoUser) => ({ id: u.id, role: u.role });

/** GET: the user's conversation (explicit id or their latest), rendered for the UI. */
export function getChat(rt: Runtime, user: DemoUser, conversationId: string | null): ApiResponse {
  const conv = conversationId ? getConversation(rt.db, conversationId) : latestConversation(rt.db, user.id);
  if (!conv) return json(200, { conversationId: null, messages: [] });
  if (conv.user_id !== user.id) return apiError(404, "NOT_FOUND", "Conversation not found.");
  return json(200, { conversationId: conv.id, messages: displayMessages(rt.db, conv.id, rt.approvals) });
}

/** POST: run one agent turn. History comes from the DB, never from the request. */
export async function postChat(rt: Runtime, user: DemoUser, body: unknown): Promise<ApiResponse> {
  const parsed = parseBody(PostChat, body);
  if (!parsed.ok) return parsed.error;
  const { text, lang } = parsed.value;

  let conversationId = parsed.value.conversationId ?? null;
  if (conversationId) {
    const conv = getConversation(rt.db, conversationId);
    if (!conv || conv.user_id !== user.id) return apiError(404, "NOT_FOUND", "Conversation not found.");
  } else {
    conversationId = createConversation(rt.db, user.id, lang, rt.clock);
  }

  const history = historyFor(rt.db, conversationId);
  const turn = await runAgentTurn(
    { llm: rt.llm, guard: rt.guard, approvals: rt.approvals, store: rt.store, policy: rt.policy, paypalTools: rt.paypalTools },
    { actor: actorOf(user), conversationId, history, userText: text },
  );
  appendTurn(rt.db, conversationId, turn.messages.slice(1 + history.length), turn.cards, rt.clock);
  return json(200, { conversationId, messages: displayMessages(rt.db, conversationId, rt.approvals), stoppedAtLimit: turn.stoppedAtLimit });
}
