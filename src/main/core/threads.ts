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
 * Stage 8 adds the ORCHESTRATION on top (sendUserMessage + the per-thread drain);
 * the IPC/renderer wiring is stage 9.
 */
import { randomUUID } from 'node:crypto';
import {
  statusTransition,
  reconcileStaleStatus,
  isUserMsgStatus,
  isValidMessageId,
  validateUserMessage,
  buildThreadPrompt,
  type ThreadInfo,
  type ThreadMessage,
  type UserMsgStatus,
} from './thread-pure.ts';
import { enqueueTurnItem, coalesceTurnItems, type TurnItem } from './turn-queue-pure.ts';
import { getAgent } from './team.ts';
// core→tools import (precedent: jobs.ts importing runStudy) — the ATTENDED roster
// runner is a tool-layer concern (spawn gate + provider branch) that both the
// delegate tool and a thread turn share verbatim.
import { runRosterAgentAttended } from '../tools/delegate-to-agent.ts';
import type { StreamEvent, ToolCtx } from './types.ts';

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

// ── orchestration: one user send → one ATTENDED agent turn ────────────────────

/** What a thread turn needs from the orchestrator (nothing Electron, nothing global). */
export interface ThreadDeps {
  db: DB;
  /**
   * The orchestrator's governed ToolCtx. Its `delegationDepth` is 0, which is what
   * makes a thread turn ATTENDED: the user is right there, so a sensitive action
   * takes the NORMAL approval path (approval.request reaches the UI) exactly like
   * answerInbox. Every tool the agent then calls still hits its grant floor, its
   * role blocklist and both budgets — the send authorises the TURN, not the tools.
   */
  ctx: ToolCtx;
  emit: (e: StreamEvent) => void;
}

/** Ack of a send: the ids the caller correlates its optimistic bubble with. */
export type SendUserMessageResult =
  | { ok: true; threadId: string; messageId: string }
  | { ok: false; error: string };

/** Per-thread FIFO + its single-flight flag. */
interface ThreadQueue {
  queue: TurnItem[];
  draining: boolean;
}

/**
 * Pending turns per thread. In-module (one orchestrator process, same reasoning as
 * the delegate tool's activeByParent) and keyed by threadId, so SAME-agent sends
 * serialise ("na fila") while DIFFERENT agents run in parallel — bounded by the
 * shared maxConcurrentChildren ceiling in the spawn gate, which reports its refusal
 * as an errored message instead of silently dropping the turn.
 */
const queues = new Map<string, ThreadQueue>();

/** turn.status without leaking undefined keys into the event (optional fields). */
function emitStatus(
  deps: ThreadDeps,
  messageId: string,
  state: UserMsgStatus,
  extra?: { queueDepth?: number; error?: string },
): void {
  const e: Extract<StreamEvent, { kind: 'turn.status' }> = { kind: 'turn.status', messageId, state };
  if (extra?.queueDepth !== undefined) e.queueDepth = extra.queueDepth;
  if (extra?.error !== undefined) e.error = extra.error;
  deps.emit(e);
}

function emitChanged(deps: ThreadDeps, threadId: string, agentId: string): void {
  deps.emit({ kind: 'thread.changed', threadId, agentId });
}

/**
 * The user sent `text` to `agentId`. Validates, persists the message at the bottom
 * of the ladder, enqueues it on that thread's FIFO and kicks the drain.
 *
 * Returns as soon as the message is PERSISTED AND QUEUED — deliberately NOT when
 * the agent has replied: the composer must clear immediately and every later rung
 * (delivered/read/executing/done|error) plus the reply itself arrives as events. The
 * drain is therefore detached and swallows its own errors (it can never reject into
 * a caller that already went away).
 *
 * `messageId` lets the renderer mint the correlation id for its optimistic bubble;
 * anything that is not `[A-Za-z0-9-]{1,64}` (or already taken) is ignored and we
 * mint our own — the returned id is always the authoritative one.
 */
export async function sendUserMessage(
  deps: ThreadDeps,
  agentId: string,
  text: string,
  messageId?: string,
): Promise<SendUserMessageResult> {
  const valid = validateUserMessage(text);
  if (!valid.ok) return { ok: false, error: valid.error };
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id) return { ok: false, error: 'agentId is required' };
  // A removed agent has no runner and no context to load: refuse the COMPOSE rather
  // than persisting a message that could only ever end as an error.
  const agent = getAgent(deps.db, id);
  if (!agent) return { ok: false, error: `o agente "${id}" já não existe na equipa` };

  const thread = getOrCreateThread(deps.db, agent.id);
  // Reuse the renderer's id when it is well-formed AND free (a retry of an already
  // stored id must not blow up the INSERT on the primary key).
  const wanted = isValidMessageId(messageId) && !getThreadMessage(deps.db, messageId) ? messageId : undefined;
  const row = insertUserThreadMessage(deps.db, thread.id, valid.text, wanted);
  emitChanged(deps, thread.id, agent.id);

  const q = queues.get(thread.id) ?? { queue: [], draining: false };
  queues.set(thread.id, q);
  const { dropped } = enqueueTurnItem(q.queue, { id: row.id, text: valid.text });
  emitStatus(deps, row.id, 'queued', { queueDepth: q.queue.length });
  // Runaway: the OLDEST pending message is dropped — loudly, on the ladder and in
  // the UI, never a silent vanish.
  if (dropped) {
    console.warn(`[alfred:threads] thread ${thread.id} queue over cap — dropped ${dropped.id}: ${dropped.text.slice(0, 80)}`);
    markDropped(deps.db, [dropped.id]);
    emitStatus(deps, dropped.id, 'dropped');
    emitChanged(deps, thread.id, agent.id);
  }

  // Detached on purpose (see above). The drain settles its own failures; the .catch
  // is the last resort for a DB-level throw, so it can never become an unhandled
  // rejection in the main process.
  if (!q.draining) {
    void drainThread(deps, agent.id, thread.id, q).catch((err) => {
      console.error(`[alfred:threads] drain of ${thread.id} failed:`, err instanceof Error ? err.message : err);
    });
  }
  return { ok: true, threadId: thread.id, messageId: row.id };
}

/**
 * Single-flight drain of ONE thread. Each pass takes every message that piled up
 * (coalesced into a single prompt, Claude-Code-style: the pile-up is one turn, not
 * N) and walks it up the ladder — delivered → read → executing → done|error —
 * emitting a turn.status per message id at every rung so each bubble shows its own
 * chip while sharing the turn.
 *
 * Never throws: an unexpected failure settles that batch as 'error' and the loop
 * continues, because a row left 'executing' would only be cleaned up by the next
 * boot reconcile (i.e. the UI would lie until the app restarts).
 *
 * The agent row is re-read PER BATCH (by id, which is immutable), so an edit lands
 * on the next run — and a roster deletion mid-thread errors the queued messages
 * instead of running a ghost.
 */
async function drainThread(deps: ThreadDeps, agentId: string, threadId: string, q: ThreadQueue): Promise<void> {
  if (q.draining) return;
  q.draining = true;
  try {
    while (q.queue.length) {
      const batch = q.queue.splice(0);
      const batchIds = batch.map((b) => b.id);
      deliverMessages(deps.db, batchIds);
      for (const id of batchIds) emitStatus(deps, id, 'delivered');

      const { text, ids } = coalesceTurnItems(batch);
      // A blank-only entry contributes nothing to the prompt, so it can never be
      // answered — settle it instead of leaving it mid-ladder.
      const skipped = batchIds.filter((id) => !ids.includes(id));
      if (skipped.length) {
        markDropped(deps.db, skipped);
        for (const id of skipped) emitStatus(deps, id, 'dropped');
      }
      if (!ids.length) continue;

      const agent = getAgent(deps.db, agentId);
      if (!agent) {
        const error = `o agente "${agentId}" já não existe na equipa`;
        markError(deps.db, ids, error);
        deps.emit({ kind: 'agent.chat.error', threadId, message: error });
        for (const id of ids) emitStatus(deps, id, 'error', { error });
        deps.emit({ kind: 'thread.changed', threadId, agentId });
        continue;
      }

      try {
        // History EXCLUDES this batch: those messages are the "new message" block
        // that buildThreadPrompt puts last, and sending them twice would read to
        // the model like the user repeated himself.
        const inBatch = new Set(batchIds);
        const history = listThreadMessages(deps.db, threadId)
          .filter((m) => !inBatch.has(m.id))
          .map((m) => ({ author: m.author, body: m.body }));
        const prompt = buildThreadPrompt(agent, history, text);

        markMessagesRead(deps.db, ids);
        for (const id of ids) emitStatus(deps, id, 'read');
        markExecuting(deps.db, ids);
        for (const id of ids) emitStatus(deps, id, 'executing');

        const res = await runRosterAgentAttended(deps.ctx, agent, prompt, {
          onDelta: (t) => deps.emit({ kind: 'agent.chat.delta', threadId, text: t }),
        });

        if (res.ok) {
          const body = res.result?.text?.trim() || '(o agente terminou sem resposta)';
          const reply = insertAgentReply(deps.db, threadId, agent.id, body);
          markDone(deps.db, ids);
          deps.emit({ kind: 'agent.chat.message', threadId, message: reply });
          deps.emit({ kind: 'agent.chat.done', threadId });
          for (const id of ids) emitStatus(deps, id, 'done');
        } else {
          // Budget exhausted, spawn ceiling, brain not connected, a failed run: the
          // reason lands on the USER's own bubble (no half-reply row is persisted).
          const error = res.error || 'a corrida do agente falhou';
          markError(deps.db, ids, error);
          deps.emit({ kind: 'agent.chat.error', threadId, message: error });
          for (const id of ids) emitStatus(deps, id, 'error', { error });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[alfred:threads] thread ${threadId} turn threw:`, err);
        markError(deps.db, ids, error);
        deps.emit({ kind: 'agent.chat.error', threadId, message: error });
        for (const id of ids) emitStatus(deps, id, 'error', { error });
      }
      emitChanged(deps, threadId, agentId);
    }
  } finally {
    q.draining = false;
    // Drop the empty bucket (a fresh send recreates it) so the map can't grow with
    // one dead entry per thread ever touched.
    if (queues.get(threadId) === q && !q.queue.length) queues.delete(threadId);
  }
}
