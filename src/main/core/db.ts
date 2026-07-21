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
  duration_ms INTEGER
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

-- Floating-card canvas layout. One row per card; geometry + visibility only
-- (title is a fixed label supplied by core/layout.ts). Both the user's drags
-- (via IPC) and the AI's ui_layout tool read/write this same table.
CREATE TABLE IF NOT EXISTS layout (
  cardId   TEXT PRIMARY KEY,
  x        INTEGER NOT NULL,
  y        INTEGER NOT NULL,
  w        INTEGER NOT NULL,
  h        INTEGER NOT NULL,
  z        INTEGER NOT NULL,
  visible  INTEGER NOT NULL DEFAULT 1
);
`;

export function openDb(dbPath: string): AlfredDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
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
