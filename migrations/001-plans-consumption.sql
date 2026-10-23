-- Explicit, additive migration. Never run automatically at server startup.
BEGIN;
CREATE TABLE IF NOT EXISTS ai_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'basic' CHECK (plan IN ('basic', 'pro'))
);
CREATE TABLE IF NOT EXISTS ai_budget_periods (
  period_start TIMESTAMPTZ PRIMARY KEY,
  consumed_requests INTEGER NOT NULL DEFAULT 0 CHECK (consumed_requests >= 0)
);
CREATE TABLE IF NOT EXISTS ai_requests (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'mobile', 'alexa')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'failed', 'uncertain')),
  input_tokens BIGINT,
  output_tokens BIGINT,
  total_tokens BIGINT,
  usage_reported BOOLEAN NOT NULL DEFAULT false,
  result JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS ai_requests_period ON ai_requests(period_start, status);
COMMIT;
