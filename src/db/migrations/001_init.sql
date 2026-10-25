-- PayGuard initial schema (SPEC.md section 9). Money is integer minor units.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('clerk','approver','owner'))
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  lang TEXT
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'trusted',
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  requested_by TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT,
  policy_rule TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','EXECUTED','REJECTED','FAILED','EXPIRED')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX approvals_status ON approvals(status);

-- Every PayPal call PayGuard executes (directly allowed or approved). Feeds daily caps.
CREATE TABLE executions (
  id TEXT PRIMARY KEY,                 -- also sent as PayPal-Request-Id
  approval_id TEXT REFERENCES approvals(id),
  requested_by TEXT NOT NULL,
  tool TEXT NOT NULL,
  target_id TEXT,                      -- capture id for refunds, order id for captures
  amount_minor INTEGER,
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN ('EXECUTED','FAILED')),
  day_key TEXT NOT NULL,               -- YYYY-MM-DD in the policy time zone
  created_at TEXT NOT NULL
);
CREATE INDEX executions_day_tool ON executions(day_key, tool, status);

CREATE TABLE paypal_objects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT,
  amount_minor INTEGER,
  currency TEXT,
  created_by_payguard INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  verified INTEGER NOT NULL,
  resource_id TEXT,
  received_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  tool TEXT,
  decision TEXT,
  approval_id TEXT,
  input_hash TEXT,
  output_hash TEXT,
  detail_json TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- The audit log is append-only at the database level, not just by convention.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
