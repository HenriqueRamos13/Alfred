/**
 * SQLite (better-sqlite3). Single file at <workspace-adjacent> data/alfred.db.
 * This is the only core module that value-imports the native driver.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type AlfredDb = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  tokens      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  tool_name   TEXT NOT NULL,
  args        TEXT,
  tier        TEXT NOT NULL,
  status      TEXT NOT NULL,
  result      TEXT,
  error       TEXT,
  duration_ms INTEGER,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit(session_id, ts);

CREATE TABLE IF NOT EXISTS budget (
  day     TEXT PRIMARY KEY,
  tokens  INTEGER NOT NULL DEFAULT 0
);

-- Cost visibility (estimated USD per model, per day, per session). The hard
-- kill-switch stays on the token counters above; this is additive.
CREATE TABLE IF NOT EXISTS usage_by_model (
  day           TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, session_id, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_by_model(day);

CREATE TABLE IF NOT EXISTS projects (
  slug     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  path     TEXT NOT NULL,
  summary  TEXT NOT NULL DEFAULT '',
  updated  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  email         TEXT NOT NULL,
  secret_ref    TEXT NOT NULL,
  connected_at  INTEGER NOT NULL
);

-- Key/value settings that must survive restart: the persisted active brain
-- (key 'active_brain') and per-session claude-code session ids
-- (key 'claude_session:<sessionId>').
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Persisted chat history. Every user + assistant message is stored so the UI
-- can reload the conversation and the model gets cross-restart continuity.
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);

-- Floating-card canvas layout. One row per card; geometry + visibility only
-- (title is a fixed label supplied by core/layout.ts). Both the user's drags
-- (via IPC) and the AI's ui_layout tool read/write this same table.
CREATE TABLE IF NOT EXISTS layout (
  cardId    TEXT PRIMARY KEY,
  x         INTEGER NOT NULL,
  y         INTEGER NOT NULL,
  w         INTEGER NOT NULL,
  h         INTEGER NOT NULL,
  z         INTEGER NOT NULL,
  visible   INTEGER NOT NULL DEFAULT 1,
  -- Concrete display.id, or the 'main' / 'all' sentinels (see core/layout.ts).
  displayId TEXT NOT NULL DEFAULT 'main'
);

-- Scheduled jobs (Phase 4): one row per persisted job; JSON columns for the
-- struct-y fields (schedule/source/render/placement/grant/runtime). The in-app
-- scheduler (core/jobs.ts) re-arms these on boot. See core/jobs.ts / jobs-pure.ts.
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  kind               TEXT NOT NULL,            -- 'fetch' | 'agent'
  schedule           TEXT NOT NULL,            -- JSON JobSchedule
  source             TEXT,                     -- JSON JobSource (fetch)
  prompt             TEXT,                     -- agent task prompt
  grant_json         TEXT,                     -- JSON Capability[] (default read+notify when null)
  token_budget_daily INTEGER,                  -- per-job daily cap (agent)
  render             TEXT NOT NULL,            -- JSON JobRender
  placement          TEXT,                     -- JSON JobPlacement
  enabled            INTEGER NOT NULL DEFAULT 1,
  runtime            TEXT NOT NULL DEFAULT '{}' -- JSON JobRuntime (lastRun/nextRun/tokens/pause)
);

-- Append-only run log for scheduled jobs.
CREATE TABLE IF NOT EXISTS job_runs (
  id       TEXT PRIMARY KEY,
  job_id   TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  ok       INTEGER NOT NULL,
  tokens   INTEGER NOT NULL DEFAULT 0,
  summary  TEXT,
  error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, ts);

-- Sensitive-action approval queue for unattended agent jobs (Phase 4, stage 2.5).
-- A sensitive tool call (send/pay/delete/secrets/egress) an agent job wants to
-- run is parked here instead of auto-executing; the user approves/denies later,
-- and an approval executes the stored tool+args through NORMAL governance.
CREATE TABLE IF NOT EXISTS job_approvals (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  tool_name    TEXT NOT NULL,
  args_json    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'denied'
  resolved_ts  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_job_approvals_status ON job_approvals(status, ts);

-- Agent roster (Phase 5): user-defined specialist agents that EXTEND the fixed
-- three (main/reference/curator in settings.agent_config). Each has its own model
-- and a private knowledge folder (<workspace>/agents/<id>/knowledge/). See core/team.ts.
CREATE TABLE IF NOT EXISTS team_agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT '',
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  grant_json  TEXT,                              -- per-agent autonomy allowlist; null → default read+notify
  created_ts  INTEGER NOT NULL
);
`;

export function openDb(dbPath: string): AlfredDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Idempotent migration: `audit.note` (auto-approval provenance) for DBs created
  // before it existed. CREATE TABLE IF NOT EXISTS above won't add columns.
  const hasNote = (db.prepare('PRAGMA table_info(audit)').all() as { name: string }[]).some((c) => c.name === 'note');
  if (!hasNote) db.exec('ALTER TABLE audit ADD COLUMN note TEXT');
  // Idempotent migration: `layout.displayId` (multi-monitor) for DBs created before it existed.
  const hasDisplayId = (db.prepare('PRAGMA table_info(layout)').all() as { name: string }[]).some(
    (c) => c.name === 'displayId',
  );
  if (!hasDisplayId) db.exec("ALTER TABLE layout ADD COLUMN displayId TEXT NOT NULL DEFAULT 'main'");
  // Idempotent migration: `team_agents.grant_json` (per-agent grant, Phase 5 stage 2)
  // for roster rows created before it existed. rowToAgent tolerates a null value.
  const hasGrant = (db.prepare('PRAGMA table_info(team_agents)').all() as { name: string }[]).some(
    (c) => c.name === 'grant_json',
  );
  if (!hasGrant) db.exec('ALTER TABLE team_agents ADD COLUMN grant_json TEXT');
  return db;
}

/** Read a persisted setting; undefined when absent. */
export function getSetting(db: AlfredDb, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

/** Upsert a persisted setting. */
export function setSetting(db: AlfredDb, key: string, value: string): void {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  ts: number;
}

/** Persist one chat message (idempotent on id). */
export function insertMessage(db: AlfredDb, m: StoredMessage): void {
  db.prepare('INSERT OR IGNORE INTO messages(id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)').run(
    m.id,
    m.sessionId,
    m.role,
    m.content,
    m.ts,
  );
}

/** Recent messages across all sessions, oldest→newest (for UI reload + model continuity). */
export function getRecentMessages(db: AlfredDb, limit = 100): StoredMessage[] {
  const rows = db
    .prepare('SELECT id, session_id AS sessionId, role, content, ts FROM messages ORDER BY ts DESC, rowid DESC LIMIT ?')
    .all(limit) as StoredMessage[];
  return rows.reverse();
}
