import type { Db } from "@/db/db";
import type { Clock } from "@/lib/clock";
import { newId } from "@/lib/ids";

/**
 * Persistence for async chat turns (migration 002). A turn is `pending` while the agent runs in the
 * background, then `done` or `error`. The partial unique index allows one pending turn per conversation.
 */

export type TurnStatus = "pending" | "done" | "error";

/** Why a turn ended in `error`. Details stay in the server log; the audit log records any tool calls. */
export type TurnErrorCode = "AGENT_FAILED" | "SERVER_RESTARTED" | "INTERRUPTED";

export type ChatTurnRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  status: TurnStatus;
  stopped_at_limit: number;
  error_code: TurnErrorCode | null;
  created_at: string;
  finished_at: string | null;
};

export function getTurn(db: Db, id: string): ChatTurnRow | undefined {
  return db.prepare("SELECT * FROM chat_turns WHERE id = ?").get(id) as ChatTurnRow | undefined;
}

export function pendingTurn(db: Db, conversationId: string): ChatTurnRow | undefined {
  return db.prepare("SELECT * FROM chat_turns WHERE conversation_id = ? AND status = 'pending'").get(conversationId) as ChatTurnRow | undefined;
}

/** Inserts a pending turn; returns null if the conversation already has one (unique index). */
export function insertPendingTurn(db: Db, conversationId: string, userId: string, clock: Clock): string | null {
  const id = newId("turn");
  try {
    db.prepare("INSERT INTO chat_turns (id, conversation_id, user_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .run(id, conversationId, userId, clock().toISOString());
    return id;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "SQLITE_CONSTRAINT_UNIQUE") return null;
    throw e;
  }
}

export function completeTurn(db: Db, id: string, stoppedAtLimit: boolean, clock: Clock): void {
  db.prepare("UPDATE chat_turns SET status = 'done', stopped_at_limit = ?, finished_at = ? WHERE id = ? AND status = 'pending'")
    .run(stoppedAtLimit ? 1 : 0, clock().toISOString(), id);
}

export function failTurn(db: Db, id: string, code: TurnErrorCode, clock: Clock): void {
  db.prepare("UPDATE chat_turns SET status = 'error', error_code = ?, finished_at = ? WHERE id = ? AND status = 'pending'")
    .run(code, clock().toISOString(), id);
}

/** Called when a runtime starts: nothing can still be running for turns left pending by an earlier process. */
export function failStaleTurns(db: Db, clock: Clock): number {
  return db.prepare("UPDATE chat_turns SET status = 'error', error_code = 'SERVER_RESTARTED', finished_at = ? WHERE status = 'pending'")
    .run(clock().toISOString()).changes;
}
