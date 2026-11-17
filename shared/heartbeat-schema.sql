CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  identity_json TEXT NOT NULL DEFAULT '{}',
  token_hash TEXT NOT NULL,
  last_seen INTEGER,
  last_ip TEXT,
  alert_state TEXT NOT NULL DEFAULT 'unknown',
  alert_sent_at INTEGER
);
CREATE TABLE IF NOT EXISTS alert_outbox (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  identity_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
