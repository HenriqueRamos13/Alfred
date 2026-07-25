/**
 * User↔agent conversation threads — persistence (agent_threads +
 * agent_thread_messages). MAIN-only: takes the Database by PARAMETER (never
 * value-imports the driver), so the pure logic (thread-pure.ts) stays testable and
 * this file is a thin IO wrapper. Mirrors core/inbox.ts.
 *
 * SEPARATE from inbox_messages by design: the inbox is the AGENT asking the user a
 * typed question and yielding (async HITL); a thread is the USER opening a plain
 * conversation WITH an agent. v1 = ONE thread per agent (getOrCreateThread) —
 * `subject` is reserved for the multi-thread step.
 *
 * Every status write goes through statusTransition (thread-pure.ts): an illegal move
 * (backwards, or out of a terminal) is SKIPPED and logged, never thrown and never
 * silently applied — a late-arriving marker from a dead runner must not resurrect a
 * message the boot reconcile already settled. Every writer bumps the thread's
 * updated_ts, which is what the sidebar orders by.
 *
 * The orchestrator/IPC/renderer wiring is stage 8; this module is the IO surface.
 */
import { randomUUID } from 'node:crypto';
import {
  statusTransition,
  reconcileStaleStatus,
  isUserMsgStatus,
  type ThreadInfo,
  type ThreadMessage,
  type UserMsgStatus,
} from './thread-pure.ts';

type DB = import('better-sqlite3').Database;

/** Reason stamped on every message left mid-ladder by a crash/restart. */
export const BOOT_INTERRUPTED_ERROR = 'interrompida por reinício da app';

// ── rows ──────────────────────────────────────────────────────────────────────

interface ThreadRow {
  id: string;
  agent_id: string;
  subject: string;
  created_ts: number;
  updated_ts: number;
}

interface MessageRow {
  id: string;
  thread_id: string;
  author: string;
  body: string;
  status: string;
  error: string | null;
  created_ts: number;
  read_ts: number | null;
  started_ts: number | null;
  done_ts: number | null;
}

/** One thread (v1: one per agent). */
export interface AgentThread {
  id: string;
  agentId: string;
  subject: string;
  createdTs: number;
  updatedTs: number;
}

function rowToThread(r: ThreadRow): AgentThread {
  return {
    id: r.id,
    agentId: r.agent_id,
    subject: r.subject ?? '',
    createdTs: r.created_ts,
    updatedTs: r.updated_ts,
  };
}

/** Row → ThreadMessage. Nulls are DROPPED (not mapped to null) so the optional
 *  fields stay `?: number | string`; an unrecognised status degrades to 'error'
 *  rather than leaking junk into the ladder types. */
function rowToThreadMessage(r: MessageRow): ThreadMessage {
  const m: ThreadMessage = {
    id: r.id,
    threadId: r.thread_id,
    author: r.author,
    body: r.body ?? '',
    status: isUserMsgStatus(r.status) ? r.status : 'error',
    createdTs: r.created_ts,
  };
  if (r.error != null) m.error = r.error;
  if (r.read_ts != null) m.readTs = r.read_ts;
  if (r.started_ts != null) m.startedTs = r.started_ts;
  if (r.done_ts != null) m.doneTs = r.done_ts;
  return m;
}

const newThreadId = (): string => `TH-${randomUUID().slice(0, 8)}`;
const newMessageId = (): string => `TM-${randomUUID().slice(0, 8)}`;

/** Bump a thread's updated_ts — every writer calls this (sidebar ordering). */
function touchThread(db: DB, threadId: string, ts: number): void {
  db.prepare('UPDATE agent_threads SET updated_ts = ? WHERE id = ?').run(ts, threadId);
}

// ── threads ───────────────────────────────────────────────────────────────────

/**
 * The agent's thread, created on first use. v1 is one thread per agent, so this is
 * SELECT-else-INSERT keyed on agent_id (most recently updated wins if a
 * multi-thread future ever leaves several behind).
 */
export function getOrCreateThread(db: DB, agentId: string): AgentThread {
  const id = (agentId ?? '').trim();
  if (!id) throw new Error('getOrCreateThread: agentId is required');
  const existing = db
    .prepare('SELECT * FROM agent_threads WHERE agent_id = ? ORDER BY updated_ts DESC, rowid DESC LIMIT 1')
    .get(id) as ThreadRow | undefined;
  if (existing) return rowToThread(existing);
  const now = Date.now();
  const row: ThreadRow = { id: newThreadId(), agent_id: id, subject: '', created_ts: now, updated_ts: now };
  db.prepare(
    'INSERT INTO agent_threads(id, agent_id, subject, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?)',
  ).run(row.id, row.agent_id, row.subject, row.created_ts, row.updated_ts);
  return rowToThread(row);
}

export function getThread(db: DB, threadId: string): AgentThread | undefined {
  const r = db.prepare('SELECT * FROM agent_threads WHERE id = ?').get(threadId) as ThreadRow | undefined;
  return r ? rowToThread(r) : undefined;
}

/**
 * Sidebar projection: every thread with its last message + unread count, newest
 * activity first. The unread subquery mirrors threadUnreadCount (agent-authored
 * rows with no read_ts) in SQL, so the list is ONE query instead of N+1.
 */
export function listThreads(db: DB): ThreadInfo[] {
  return db
    .prepare(
      `SELECT t.id AS id,
              t.agent_id AS agentId,
              COALESCE((SELECT m.body FROM agent_thread_messages m
                         WHERE m.thread_id = t.id ORDER BY m.created_ts DESC, m.rowid DESC LIMIT 1), '') AS lastBody,
              COALESCE((SELECT m.created_ts FROM agent_thread_messages m
                         WHERE m.thread_id = t.id ORDER BY m.created_ts DESC, m.rowid DESC LIMIT 1), t.updated_ts) AS lastTs,
              (SELECT COUNT(*) FROM agent_thread_messages m
                WHERE m.thread_id = t.id AND m.author <> 'user' AND m.read_ts IS NULL) AS unread
         FROM agent_threads t
        ORDER BY t.updated_ts DESC, t.rowid DESC`,
    )
    .all() as ThreadInfo[];
}

// ── messages ──────────────────────────────────────────────────────────────────

/** One thread's messages, oldest→newest (the transcript order the UI renders). */
export function listThreadMessages(db: DB, threadId: string): ThreadMessage[] {
  const rows = db
    .prepare('SELECT * FROM agent_thread_messages WHERE thread_id = ? ORDER BY created_ts ASC, rowid ASC')
    .all(threadId) as MessageRow[];
  return rows.map(rowToThreadMessage);
}

export function getThreadMessage(db: DB, id: string): ThreadMessage | undefined {
  const r = db.prepare('SELECT * FROM agent_thread_messages WHERE id = ?').get(id) as MessageRow | undefined;
  return r ? rowToThreadMessage(r) : undefined;
}

/**
 * Persist the user's message at the BOTTOM of the ladder ('queued'). `body` is
 * expected pre-validated (validateUserMessage at the IPC boundary); `id` may be
 * supplied so the caller can mint it before the write (optimistic UI / queue item).
 */
export function insertUserThreadMessage(db: DB, threadId: string, body: string, id?: string): ThreadMessage {
  const now = Date.now();
  const mid = id ?? newMessageId();
  db.prepare(
    `INSERT INTO agent_thread_messages
       (id, thread_id, author, body, status, error, created_ts, read_ts, started_ts, done_ts)
     VALUES (?, ?, 'user', ?, 'queued', NULL, ?, NULL, NULL, NULL)`,
  ).run(mid, threadId, body, now);
  touchThread(db, threadId, now);
  return getThreadMessage(db, mid)!;
}

/**
 * Persist the agent's reply. An agent message is born SETTLED ('done' + done_ts):
 * the ladder tracks the USER's message through the system, not the agent's own
 * text. read_ts stays null until the user opens the thread (markThreadRead) — that
 * null is what the unread badge counts.
 */
export function insertAgentReply(db: DB, threadId: string, agentId: string, body: string): ThreadMessage {
  const now = Date.now();
  const mid = newMessageId();
  db.prepare(
    `INSERT INTO agent_thread_messages
       (id, thread_id, author, body, status, error, created_ts, read_ts, started_ts, done_ts)
     VALUES (?, ?, ?, ?, 'done', NULL, ?, NULL, NULL, ?)`,
  ).run(mid, threadId, agentId, body, now, now);
  touchThread(db, threadId, now);
  return getThreadMessage(db, mid)!;
}

/**
 * The user opened the thread: stamp read_ts on the AGENT-authored rows that had
 * none (idempotent — COALESCE keeps the first stamp). Deliberately NOT a status
 * change: agent rows are already terminal ('done'), and "read" here means the USER
 * read the agent, which is a different axis from the user-message ladder. Returns
 * how many rows were stamped (0 → the caller can skip its change event).
 */
export function markThreadRead(db: DB, threadId: string): number {
  const info = db
    .prepare("UPDATE agent_thread_messages SET read_ts = ? WHERE thread_id = ? AND author <> 'user' AND read_ts IS NULL")
    .run(Date.now(), threadId);
  return info.changes;
}

// ── ladder markers (batch) ────────────────────────────────────────────────────

/**
 * Move a batch of messages one (or more) rungs up the ladder. EVERY row is checked
 * against statusTransition first: an illegal move — backwards, or out of a terminal
 * the boot reconcile already settled — is skipped WITH A LOG, never thrown (one
 * stale id must not abort the whole batch) and never silently applied. The
 * status-specific timestamp is stamped in the same UPDATE, and each touched thread
 * gets ONE updated_ts bump. Returns the number of rows actually moved.
 */
function applyStatus(db: DB, ids: readonly string[], next: UserMsgStatus, errorText?: string): number {
  if (!ids.length) return 0;
  const now = Date.now();
  const sel = db.prepare('SELECT * FROM agent_thread_messages WHERE id = ?');
  const threads = new Set<string>();
  let moved = 0;
  for (const id of ids) {
    const row = sel.get(id) as MessageRow | undefined;
    if (!row) {
      console.warn(`[alfred:threads] no thread message "${id}" to mark "${next}"`);
      continue;
    }
    const current: UserMsgStatus = isUserMsgStatus(row.status) ? row.status : 'error';
    const t = statusTransition(current, next);
    if (!t.ok) {
      console.warn(`[alfred:threads] skipping "${id}" (${current} → ${next}): ${t.error}`);
      continue;
    }
    if (next === 'read') {
      db.prepare('UPDATE agent_thread_messages SET status = ?, read_ts = COALESCE(read_ts, ?) WHERE id = ?').run(next, now, id);
    } else if (next === 'executing') {
      db.prepare('UPDATE agent_thread_messages SET status = ?, started_ts = ? WHERE id = ?').run(next, now, id);
    } else if (next === 'done' || next === 'dropped') {
      db.prepare('UPDATE agent_thread_messages SET status = ?, done_ts = ? WHERE id = ?').run(next, now, id);
    } else if (next === 'error') {
      db.prepare('UPDATE agent_thread_messages SET status = ?, error = ?, done_ts = ? WHERE id = ?').run(
        next,
        errorText ?? '',
        now,
        id,
      );
    } else {
      db.prepare('UPDATE agent_thread_messages SET status = ? WHERE id = ?').run(next, id);
    }
    threads.add(row.thread_id);
    moved++;
  }
  for (const threadId of threads) touchThread(db, threadId, now);
  return moved;
}

/** The message reached the agent's queue (its runner has it). */
export function deliverMessages(db: DB, ids: readonly string[]): number {
  return applyStatus(db, ids, 'delivered');
}

/** The agent read the user's message (it is in the prompt it is about to run). */
export function markMessagesRead(db: DB, ids: readonly string[]): number {
  return applyStatus(db, ids, 'read');
}

/** The turn carrying these messages started. */
export function markExecuting(db: DB, ids: readonly string[]): number {
  return applyStatus(db, ids, 'executing');
}

/** The turn carrying these messages finished (the reply is persisted separately). */
export function markDone(db: DB, ids: readonly string[]): number {
  return applyStatus(db, ids, 'done');
}

/** The turn failed — the reason is shown on the user's own bubble. */
export function markError(db: DB, ids: readonly string[], error: string): number {
  return applyStatus(db, ids, 'error', error);
}

/** A queue-runaway drop (enqueueTurnItem returned it) — never a silent vanish. */
export function markDropped(db: DB, ids: readonly string[]): number {
  return applyStatus(db, ids, 'dropped');
}

// ── boot reconcile ────────────────────────────────────────────────────────────

/**
 * Crash recovery, run ONCE at boot before anything can enqueue: a message left
 * mid-ladder (queued/delivered/read/executing) has no runner left to advance it, so
 * it is settled as 'error' — in BOTH ladders (thread messages and the main
 * transcript's messages.status). Terminal rows are skipped (reconcileStaleStatus
 * returns null), which is what makes re-running it a no-op. updated_ts is NOT
 * bumped: recovery must not reshuffle the sidebar.
 */
export function reconcileThreadsAtBoot(db: DB): { threadMessages: number; chatMessages: number } {
  let threadMessages = 0;
  let chatMessages = 0;
  const tmUpd = db.prepare(
    'UPDATE agent_thread_messages SET status = ?, error = COALESCE(error, ?), done_ts = COALESCE(done_ts, ?) WHERE id = ?',
  );
  const now = Date.now();
  const tmRows = db.prepare('SELECT id, status FROM agent_thread_messages').all() as { id: string; status: string }[];
  for (const r of tmRows) {
    const next = reconcileStaleStatus(isUserMsgStatus(r.status) ? r.status : 'queued');
    if (!next) continue;
    tmUpd.run(next, BOOT_INTERRUPTED_ERROR, now, r.id);
    threadMessages++;
  }
  const msgUpd = db.prepare('UPDATE messages SET status = ? WHERE id = ?');
  const msgRows = db.prepare('SELECT id, status FROM messages WHERE status IS NOT NULL').all() as {
    id: string;
    status: string;
  }[];
  for (const r of msgRows) {
    const next = reconcileStaleStatus(isUserMsgStatus(r.status) ? r.status : 'queued');
    if (!next) continue;
    msgUpd.run(next, r.id);
    chatMessages++;
  }
  if (threadMessages || chatMessages) {
    console.warn(
      `[alfred:threads] boot reconcile: ${threadMessages} thread message(s) + ${chatMessages} chat message(s) settled as error (${BOOT_INTERRUPTED_ERROR})`,
    );
  }
  return { threadMessages, chatMessages };
}
