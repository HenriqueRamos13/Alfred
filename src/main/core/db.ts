/**
 * SQLite (better-sqlite3). Single file at <workspace-adjacent> data/alfred.db.
 * This is the only core module that value-imports the native driver.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isUserMsgStatus, statusTransition, type UserMsgStatus } from './thread-pure.ts';

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
  updated  INTEGER NOT NULL,
  -- P7 "PARAR": 1 while the user has the project stopped → no agent may work it
  -- (delegation refuses, heartbeat skips it). The user is never blocked.
  paused   INTEGER NOT NULL DEFAULT 0
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
  ts          INTEGER NOT NULL,
  -- Unified user-message status ladder (Phase 8 stage 7, see core/thread-pure.ts):
  -- queued|delivered|read|executing|done|error|dropped on USER rows; NULL on
  -- assistant/tool rows and on every row written before the ladder existed.
  -- ponytail: messages_fts_au re-indexes the row on EVERY update, so each status
  -- bump churns the FTS index. Accepted — a handful of updates per turn on a
  -- personal transcript; revisit if history ever grows to millions of rows.
  status      TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);

-- Full-text search over the transcript (Phase 6 stage 4): zero-LLM "what did we
-- say weeks ago" recall. Standalone FTS5 (not external-content) so the schema is
-- self-contained; only content is indexed, the rest are UNINDEXED so they are
-- returned verbatim. Kept in sync with messages by the triggers below, and
-- backfilled idempotently on open (see openDb). better-sqlite3 ships FTS5.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, ts UNINDEXED
);
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(id, session_id, role, content, ts)
  VALUES (new.id, new.session_id, new.role, new.content, new.ts);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE id = old.id;
  INSERT INTO messages_fts(id, session_id, role, content, ts)
  VALUES (new.id, new.session_id, new.role, new.content, new.ts);
END;

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
  study              TEXT,                     -- JSON {agentId, topic} (study kind)
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
  delegation_role TEXT NOT NULL DEFAULT 'leaf',  -- PRIVILEGE role: 'leaf' (default-deny) | 'orchestrator' (may spawn, bounded)
  daily_token_budget INTEGER,                    -- per-agent daily token cap; null → unlimited (global kill-switch only)
  parent_id   TEXT,                              -- manager this agent reports to (Phase 7); null → top of the org
  can_message_user INTEGER NOT NULL DEFAULT 0,   -- inbox power (Phase 7); 0 → fail-closed (no direct user messaging)
  created_ts  INTEGER NOT NULL,
  updated_ts  INTEGER                            -- last edit (Phase 8 updateAgent); null → never edited
);

-- Kanban board (Phase 7): one row per work card, project-scoped by project_slug
-- (FK-by-convention to projects.slug). A card is a WORK SUBSTRATE — artifact +
-- acceptance-criteria + definition-of-done + a dependency DAG — so it can only
-- reach Done when its artifact exists AND every DoD item is ticked (see
-- kanban-pure.ts doneGateDecision). The FULL column set is created up-front so the
-- later stages (claim/heartbeat/timeouts/notifications) never re-migrate it. The
-- struct-y fields are JSON columns; "column" is quoted (it is a SQLite keyword).
-- Both the governed kanban tool (agent) and the user's UI drag (IPC) write this.
CREATE TABLE IF NOT EXISTS kanban_cards (
  id             TEXT PRIMARY KEY,
  project_slug   TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  "column"       TEXT NOT NULL DEFAULT 'backlog',  -- backlog|todo|doing|review|done|blocked|failed
  assignee_id    TEXT,
  reviewer_id    TEXT,
  created_by     TEXT NOT NULL DEFAULT 'user',      -- agentId or 'user'
  for_whom       TEXT,                              -- agentId or 'user' the deliverable is for
  priority       TEXT NOT NULL DEFAULT 'med',       -- low|med|high
  order_idx      INTEGER NOT NULL DEFAULT 0,
  artifact       TEXT NOT NULL DEFAULT '',
  acceptance_json TEXT NOT NULL DEFAULT '[]',       -- [{text,done}]
  dod_json       TEXT NOT NULL DEFAULT '[]',        -- [{text,done}] definition-of-done
  depends_on_json TEXT NOT NULL DEFAULT '[]',       -- [cardId] dependency DAG
  claimed_by     TEXT,                              -- atomic claim owner (agentId) or null
  claimed_ts     INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  timeout_ms     INTEGER,
  stop_condition TEXT NOT NULL DEFAULT '',
  -- Async-HITL checkpoint (Phase 7 stage 3): 1 while an inbox ask on this card is
  -- pending (the agent wrote, checkpointed, and yielded). The user's answer clears it.
  awaiting_human INTEGER NOT NULL DEFAULT 0,
  created_ts     INTEGER NOT NULL,
  updated_ts     INTEGER NOT NULL,
  done_ts        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kanban_project ON kanban_cards(project_slug, order_idx);

-- Human INBOX (Phase 7 stage 3): async HITL — a background/delegated agent writes
-- a message HERE and yields; the user answers later (the resume is stage 4). SEPARATE
-- from the formal T0–T3 tool approvals (two-tier). Only an agent with resolved
-- can_message_user power may write (gated in the tool). Indexed by status + project.
CREATE TABLE IF NOT EXISTS inbox_messages (
  id              TEXT PRIMARY KEY,
  from_agent_id   TEXT NOT NULL,
  project_slug    TEXT,
  card_id         TEXT,
  kind            TEXT NOT NULL,                 -- ask_user_questions|request_confirmation|suggest_tasks
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,                          -- dedupe a retried ask (see dedupeByIdempotency)
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|answered|rejected|superseded
  action          TEXT,                          -- accept|edit|respond|reject (null while pending)
  answer          TEXT,                          -- user's answer / edited args / reject reason
  created_ts      INTEGER NOT NULL,
  read_ts         INTEGER,                       -- null = unread
  answered_ts     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_messages(status, created_ts);
CREATE INDEX IF NOT EXISTS idx_inbox_project ON inbox_messages(project_slug, created_ts);

-- Agent notifications (Phase 7 stage 4): the self-orchestration wake feed. A card
-- lifecycle event (assigned/review_requested/done), a dependency clearing
-- (dep_ready), an inbox answer (reply), a heartbeat poke (nudge) or its self-limited
-- escalation writes a TARGETED row here (one recipient — never a broadcast). Writing
-- a row is a safe internal write, so the heartbeat runs fail-closed-safe unattended.
-- The Activity feed reads it as the project's append-only audit; agents read their
-- own unseen rows to know they were woken. Indexed by recipient + unseen.
CREATE TABLE IF NOT EXISTS agent_notifications (
  id            TEXT PRIMARY KEY,
  to_agent_id   TEXT NOT NULL,                  -- recipient agentId or 'user'
  project_slug  TEXT,
  card_id       TEXT,
  kind          TEXT NOT NULL,                  -- assigned|review_requested|done|dep_ready|reply|nudge|escalation
  text          TEXT NOT NULL DEFAULT '',
  created_ts    INTEGER NOT NULL,
  seen_ts       INTEGER                         -- null = unseen (badge)
);
CREATE INDEX IF NOT EXISTS idx_notify_to ON agent_notifications(to_agent_id, seen_ts);
CREATE INDEX IF NOT EXISTS idx_notify_project ON agent_notifications(project_slug, created_ts);

-- User↔agent conversation threads (Phase 8 stage 7). SEPARATE from inbox_messages:
-- the inbox is the AGENT asking the user a typed question (ask/answer, HITL); a
-- thread is the USER opening a plain conversation WITH an agent. v1 = one thread per
-- agent (see core/threads.ts getOrCreateThread), so "subject" is reserved for the
-- multi-thread step and defaults to ''. updated_ts is bumped by EVERY writer, and is
-- what the sidebar orders by.
CREATE TABLE IF NOT EXISTS agent_threads (
  id          TEXT PRIMARY KEY,               -- TH-<8hex>
  agent_id    TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  created_ts  INTEGER NOT NULL,
  updated_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_agent ON agent_threads(agent_id, updated_ts);

-- Messages inside a thread. "author" is the ONLY authorship signal: 'user' or the
-- agentId (no role column). "status" walks the SAME ladder as messages.status
-- (core/thread-pure.ts): queued→delivered→read→executing→done|error, +dropped;
-- forward-only, terminals absorbing, every write routed through statusTransition.
-- read_ts is dual-meaning by authorship: on a USER row it is when the AGENT read it,
-- on an AGENT row it is when the USER opened it (that is what the badge counts).
CREATE TABLE IF NOT EXISTS agent_thread_messages (
  id          TEXT PRIMARY KEY,               -- TM-<8hex>
  thread_id   TEXT NOT NULL,
  author      TEXT NOT NULL,                  -- 'user' | agentId
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued',
  error       TEXT,                            -- why it failed (status 'error')
  created_ts  INTEGER NOT NULL,
  read_ts     INTEGER,
  started_ts  INTEGER,                         -- run start (status 'executing')
  done_ts     INTEGER                          -- settled (done|error)
);
CREATE INDEX IF NOT EXISTS idx_thread_msgs ON agent_thread_messages(thread_id, created_ts);
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
  // Idempotent migration: `team_agents.daily_token_budget` (per-agent cap, Phase 5 stage 4).
  const hasAgentBudget = (db.prepare('PRAGMA table_info(team_agents)').all() as { name: string }[]).some(
    (c) => c.name === 'daily_token_budget',
  );
  if (!hasAgentBudget) db.exec('ALTER TABLE team_agents ADD COLUMN daily_token_budget INTEGER');
  // Idempotent migration: `team_agents.delegation_role` (privilege role, Phase 6 stage 2).
  // Rows written before it existed default to 'leaf' (default-deny); rowToAgent tolerates null too.
  const hasDelegationRole = (db.prepare('PRAGMA table_info(team_agents)').all() as { name: string }[]).some(
    (c) => c.name === 'delegation_role',
  );
  if (!hasDelegationRole) db.exec("ALTER TABLE team_agents ADD COLUMN delegation_role TEXT NOT NULL DEFAULT 'leaf'");
  // Idempotent migration: `team_agents.parent_id` + `can_message_user` (org hierarchy, Phase 7 stage 2).
  // Rows written before they existed → parent_id NULL (top of the org) + can_message_user 0 (fail-closed);
  // rowToAgent tolerates both. Guarded by an existence check so re-running on every boot is a no-op.
  const teamCols = (db.prepare('PRAGMA table_info(team_agents)').all() as { name: string }[]).map((c) => c.name);
  if (!teamCols.includes('parent_id')) db.exec('ALTER TABLE team_agents ADD COLUMN parent_id TEXT');
  if (!teamCols.includes('can_message_user')) db.exec('ALTER TABLE team_agents ADD COLUMN can_message_user INTEGER NOT NULL DEFAULT 0');
  // Idempotent migration: `team_agents.updated_ts` (last edit, Phase 8 stage 3). Nullable —
  // a row created before the edit path existed (or never edited) has no edit timestamp.
  if (!teamCols.includes('updated_ts')) db.exec('ALTER TABLE team_agents ADD COLUMN updated_ts INTEGER');
  // Idempotent migration: `kanban_cards.awaiting_human` (async-HITL checkpoint, Phase 7 stage 3)
  // for boards created before it existed. Guarded so re-running on every boot is a no-op.
  const hasAwaiting = (db.prepare('PRAGMA table_info(kanban_cards)').all() as { name: string }[]).some(
    (c) => c.name === 'awaiting_human',
  );
  if (!hasAwaiting) db.exec('ALTER TABLE kanban_cards ADD COLUMN awaiting_human INTEGER NOT NULL DEFAULT 0');
  // Idempotent migration: `scheduled_jobs.study` (study-job params, Phase 5 stage 4).
  const hasStudy = (db.prepare('PRAGMA table_info(scheduled_jobs)').all() as { name: string }[]).some(
    (c) => c.name === 'study',
  );
  if (!hasStudy) db.exec('ALTER TABLE scheduled_jobs ADD COLUMN study TEXT');
  // Idempotent migration: `projects.paused` (P7 "PARAR") for indexes created before it existed.
  const hasPaused = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).some(
    (c) => c.name === 'paused',
  );
  if (!hasPaused) db.exec('ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
  // Idempotent migration: `messages.status` (unified user-message ladder, Phase 8
  // stage 7) for transcripts written before it existed. NULL on every legacy row and
  // on assistant/tool rows — only USER rows walk the ladder, and rowToStored drops a
  // null so the type stays `status?: UserMsgStatus`.
  const hasMsgStatus = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some(
    (c) => c.name === 'status',
  );
  if (!hasMsgStatus) db.exec('ALTER TABLE messages ADD COLUMN status TEXT');
  // Idempotent FTS5 backfill: index any pre-existing messages the triggers never
  // saw (DBs created before messages_fts existed, or rows inserted while it was
  // absent). Insert only the missing ids, so re-running on every boot is a no-op.
  // ponytail: NOT IN subquery scans messages_fts; fine for a personal transcript,
  // revisit only if history grows to millions of rows.
  db.exec(
    `INSERT INTO messages_fts(id, session_id, role, content, ts)
     SELECT id, session_id, role, content, ts FROM messages
     WHERE id NOT IN (SELECT id FROM messages_fts)`,
  );
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
  /** Ladder status — USER rows only (see core/thread-pure.ts); absent otherwise. */
  status?: UserMsgStatus;
}

interface MessageRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  ts: number;
  status: string | null;
}

/** Drop a null/unknown status so the shape stays `status?: UserMsgStatus`. */
function rowToStored(r: MessageRow): StoredMessage {
  const m: StoredMessage = { id: r.id, sessionId: r.sessionId, role: r.role, content: r.content, ts: r.ts };
  if (isUserMsgStatus(r.status)) m.status = r.status;
  return m;
}

/** Persist one chat message (idempotent on id). `status` is optional (user rows). */
export function insertMessage(db: AlfredDb, m: StoredMessage): void {
  db.prepare('INSERT OR IGNORE INTO messages(id, session_id, role, content, ts, status) VALUES (?, ?, ?, ?, ?, ?)').run(
    m.id,
    m.sessionId,
    m.role,
    m.content,
    m.ts,
    m.status ?? null,
  );
}

/** Recent messages across all sessions, oldest→newest (for UI reload + model continuity). */
export function getRecentMessages(db: AlfredDb, limit = 100): StoredMessage[] {
  const rows = db
    .prepare(
      'SELECT id, session_id AS sessionId, role, content, ts, status FROM messages ORDER BY ts DESC, rowid DESC LIMIT ?',
    )
    .all(limit) as MessageRow[];
  return rows.reverse().map(rowToStored);
}

/**
 * Advance one transcript message on the unified ladder. Routed through
 * statusTransition, so a backwards/terminal move is SKIPPED and logged instead of
 * silently corrupting the row (same rule the thread markers in core/threads.ts
 * apply). A row with no status yet (legacy row, or an assistant row being adopted)
 * has nothing to compare against, so the first stamp is always accepted. Returns
 * true when a write happened.
 */
export function setMessageStatus(db: AlfredDb, id: string, status: UserMsgStatus): boolean {
  const row = db.prepare('SELECT status FROM messages WHERE id = ?').get(id) as { status: string | null } | undefined;
  if (!row) {
    console.warn(`[alfred:db] no message "${id}" to mark "${status}"`);
    return false;
  }
  if (isUserMsgStatus(row.status)) {
    const t = statusTransition(row.status, status);
    if (!t.ok) {
      console.warn(`[alfred:db] skipping status change on message "${id}": ${t.error}`);
      return false;
    }
  }
  db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, id);
  return true;
}
