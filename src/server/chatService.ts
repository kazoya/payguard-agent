import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ApprovalQueue, ApprovalRow } from "@/approvals/queue";
import type { PlanCard } from "@/agent/planCard";
import type { Db } from "@/db/db";
import type { Clock } from "@/lib/clock";
import { newId } from "@/lib/ids";

/**
 * Server-side chat persistence. History lives in the DB, so a client cannot forge earlier turns
 * (and with them the "trusted" amounts the provenance check relies on).
 */

export type ApprovalNotice = {
  approvalId: string;
  status: "EXECUTED" | "FAILED" | "REJECTED";
  tool: string;
  amountMinor: number | null;
  currency: string | null;
  decidedBy: string;
  note: string | null;
  resultId: string | null;
  /** Verified buyer approval link for an approved create_order (sandbox checkout host only). */
  checkoutUrl?: string | null;
};

export type DisplayCard = PlanCard & { approvalStatus: string | null };

export type DisplayMessage = {
  id: string;
  role: "user" | "assistant" | "notice";
  text: string;
  cards: DisplayCard[];
  notice: ApprovalNotice | null;
  createdAt: string;
};

type Row = { id: string; role: string; content: string; created_at: string };
type Stored = { msg: ChatCompletionMessageParam; cards?: PlanCard[] };

export type ConversationRow = { id: string; user_id: string; created_at: string; lang: string | null };

export function createConversation(db: Db, userId: string, lang: string, clock: Clock): string {
  const id = newId("conv");
  db.prepare("INSERT INTO conversations (id, user_id, created_at, lang) VALUES (?, ?, ?, ?)").run(id, userId, clock().toISOString(), lang);
  return id;
}

export function getConversation(db: Db, id: string): ConversationRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
}

export function latestConversation(db: Db, userId: string): ConversationRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(userId) as ConversationRow | undefined;
}

function rows(db: Db, conversationId: string): Row[] {
  return db.prepare("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY rowid").all(conversationId) as Row[];
}

function provenanceOf(m: ChatCompletionMessageParam): string {
  if (m.role === "tool") return "tool";
  if (m.role === "user" && typeof m.content === "string" && /<customer_message>/i.test(m.content)) return "mixed";
  return m.role === "user" ? "trusted" : "model";
}

/** Persists the new messages of one turn; the plan cards ride on the final assistant message. */
export function appendTurn(db: Db, conversationId: string, msgs: ChatCompletionMessageParam[], cards: PlanCard[], clock: Clock): void {
  const stmt = db.prepare("INSERT INTO messages (id, conversation_id, role, content, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const now = clock().toISOString();
  db.transaction(() => {
    msgs.forEach((msg, i) => {
      const stored: Stored = i === msgs.length - 1 && cards.length > 0 ? { msg, cards } : { msg };
      stmt.run(newId("msg"), conversationId, msg.role, JSON.stringify(stored), provenanceOf(msg), now);
    });
  })();
}

export function appendNotice(db: Db, conversationId: string, notice: ApprovalNotice, clock: Clock): void {
  db.prepare("INSERT INTO messages (id, conversation_id, role, content, provenance, created_at) VALUES (?, ?, 'notice', ?, 'system', ?)")
    .run(newId("msg"), conversationId, JSON.stringify(notice), clock().toISOString());
}

/** LLM history: the stored turns, plus approval outcomes as plain assistant notes. */
export function historyFor(db: Db, conversationId: string): ChatCompletionMessageParam[] {
  return rows(db, conversationId).map((r): ChatCompletionMessageParam => {
    if (r.role === "notice") {
      const n = JSON.parse(r.content) as ApprovalNotice;
      return { role: "assistant", content: `(Approval ${n.approvalId} for ${n.tool} is now ${n.status}.)` };
    }
    return (JSON.parse(r.content) as Stored).msg;
  });
}

function textOf(m: ChatCompletionMessageParam): string {
  return typeof m.content === "string" ? m.content : "";
}

export function displayMessages(db: Db, conversationId: string, approvals: Pick<ApprovalQueue, "get">): DisplayMessage[] {
  const statusOf = (id: string | null) => (id ? (approvals.get(id) as ApprovalRow | undefined)?.status ?? null : null);
  const out: DisplayMessage[] = [];
  for (const r of rows(db, conversationId)) {
    if (r.role === "notice") {
      out.push({ id: r.id, role: "notice", text: "", cards: [], notice: JSON.parse(r.content) as ApprovalNotice, createdAt: r.created_at });
      continue;
    }
    const { msg, cards } = JSON.parse(r.content) as Stored;
    if (msg.role === "user") {
      out.push({ id: r.id, role: "user", text: textOf(msg), cards: [], notice: null, createdAt: r.created_at });
    } else if (msg.role === "assistant" && !("tool_calls" in msg && msg.tool_calls?.length)) {
      const display = (cards ?? []).map((c) => ({ ...c, approvalStatus: statusOf(c.approvalId) }));
      out.push({ id: r.id, role: "assistant", text: textOf(msg), cards: display, notice: null, createdAt: r.created_at });
    }
  }
  return out;
}
