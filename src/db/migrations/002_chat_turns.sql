-- Async chat turns: POST /api/chat starts a turn and returns 202; the UI polls its status.
-- Persisted so a page reload can resume polling and a restart can fail turns that were in flight.
CREATE TABLE chat_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending','done','error')),
  stopped_at_limit INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX chat_turns_conversation ON chat_turns(conversation_id, created_at);
-- At most one in-flight turn per conversation, enforced by the database.
CREATE UNIQUE INDEX chat_turns_one_pending ON chat_turns(conversation_id) WHERE status = 'pending';
