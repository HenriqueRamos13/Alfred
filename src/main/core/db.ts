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
`;

export function openDb(dbPath: string): AlfredDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
