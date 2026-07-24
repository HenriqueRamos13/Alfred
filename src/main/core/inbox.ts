/**
 * Human INBOX — persistence (inbox_messages table). MAIN-only: takes the Database
 * by PARAMETER (never value-imports the driver), so the pure logic (inbox-pure.ts)
 * stays testable and this file is a thin IO wrapper. Shared by the governed `inbox`
 * TOOL (agent) and the IPC surface (the user reads/answers from the UI).
 *
 * The invariants live in inbox-pure.ts — this module only reads/writes rows and
 * routes writes through validateAsk / answerTransition / dedupeByIdempotency /
 * supersedeDecision, and keeps the card's awaiting_human checkpoint in step
 * (set on a card-scoped pending ask, cleared on answer/reject/supersede).
 */
import { randomUUID } from 'node:crypto';
import {
  validateAsk,
  answerTransition,
  dedupeByIdempotency,
  supersedeDecision,
  type AskInput,
  type InboxAction,
  type InboxMessage,
} from './inbox-pure.ts';

type DB = import('better-sqlite3').Database;

interface Row {
  id: string;
  from_agent_id: string;
  project_slug: string | null;
  card_id: string | null;
  kind: string;
  subject: string;
  body: string;
  idempotency_key: string | null;
  status: string;
  action: string | null;
  answer: string | null;
  created_ts: number;
  read_ts: number | null;
  answered_ts: number | null;
}

function rowToMessage(r: Row): InboxMessage {
  return {
    id: r.id,
    fromAgentId: r.from_agent_id,
    projectSlug: r.project_slug ?? null,
    cardId: r.card_id ?? null,
    kind: r.kind as InboxMessage['kind'],
    subject: r.subject,
    body: r.body ?? '',
    idempotencyKey: r.idempotency_key ?? null,
    status: r.status as InboxMessage['status'],
    action: (r.action as InboxAction | null) ?? null,
    answer: r.answer ?? null,
    createdTs: r.created_ts,
    readTs: r.read_ts ?? null,
    answeredTs: r.answered_ts ?? null,
  };
}

export interface InboxFilter {
  /** Only messages for this project (board Inbox tab). */
  projectSlug?: string;
  /** Only messages with this status. */
  status?: string;
  /** Only messages from this agent. */
  agentId?: string;
}

/** List messages (newest first), optionally filtered by project / status / agent. */
export function listInbox(db: DB, filter: InboxFilter = {}): InboxMessage[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.projectSlug) { where.push('project_slug = ?'); args.push(filter.projectSlug); }
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  if (filter.agentId) { where.push('from_agent_id = ?'); args.push(filter.agentId); }
  const sql = `SELECT * FROM inbox_messages${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_ts DESC, rowid DESC`;
  return (db.prepare(sql).all(...args) as Row[]).map(rowToMessage);
}

export function getInbox(db: DB, id: string): InboxMessage | undefined {
  const r = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToMessage(r) : undefined;
}

export type InboxResult =
  | { ok: true; message: InboxMessage; deduped?: boolean }
  | { ok: false; error: string };

/** Set/clear a card's awaiting_human checkpoint (no-op when cardId is null/unknown). */
function setAwaitingHuman(db: DB, cardId: string | null, awaiting: boolean): void {
  if (!cardId) return;
  db.prepare('UPDATE kanban_cards SET awaiting_human = ?, updated_ts = ? WHERE id = ?').run(
    awaiting ? 1 : 0,
    Date.now(),
    cardId,
  );
}

/**
 * Persist an ask. `fromAgentId` is TRUSTED (the runner sets it from ctx — never
 * the model). Validates the untrusted args, DEDUPES by idempotencyKey (a retried
 * ask returns the original, deduped:true, and does not re-checkpoint), then inserts
 * and — if the ask is card-scoped — checkpoints the card (awaiting_human=1). Async:
 * the caller emits inbox.changed and returns immediately (NEVER blocks on an answer).
 */
export function createAsk(db: DB, fromAgentId: string, input: AskInput): InboxResult {
  const agent = (fromAgentId ?? '').trim();
  if (!agent) return { ok: false, error: 'fromAgentId is required' };
  const v = validateAsk(input);
  if (!v.ok) return v;
  const s = v.spec;
  if (s.idempotencyKey) {
    const dup = dedupeByIdempotency(listInbox(db, { agentId: agent }), s.idempotencyKey);
    if (dup) return { ok: true, message: dup, deduped: true };
  }
  const id = `IB-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO inbox_messages
       (id, from_agent_id, project_slug, card_id, kind, subject, body, idempotency_key, status, action, answer, created_ts, read_ts, answered_ts)
     VALUES (@id, @fromAgentId, @projectSlug, @cardId, @kind, @subject, @body, @idempotencyKey, 'pending', NULL, NULL, @now, NULL, NULL)`,
  ).run({
    id,
    fromAgentId: agent,
    projectSlug: s.projectSlug,
    cardId: s.cardId,
    kind: s.kind,
    subject: s.subject,
    body: s.body,
    idempotencyKey: s.idempotencyKey,
    now,
  });
  setAwaitingHuman(db, s.cardId, true);
  return { ok: true, message: getInbox(db, id)! };
}

/**
 * Apply the user's typed answer (accept/edit/respond/reject) via the pure
 * answerTransition (reject-requires-reason; only pending is answerable). On success
 * persists the status/action/answer + answered_ts and clears the card's
 * awaiting_human checkpoint (so the board badge drops). The agent's RESUME on this
 * answer is Stage 4 — here we persist the answer + let the caller emit inbox.changed.
 */
export function answerInbox(db: DB, id: string, action: string, text: string | undefined): InboxResult {
  const msg = getInbox(db, id);
  if (!msg) return { ok: false, error: `no inbox message with id "${id}"` };
  const t = answerTransition(msg, action, text);
  if (!t.ok) return t;
  const now = Date.now();
  db.prepare('UPDATE inbox_messages SET status = ?, action = ?, answer = ?, answered_ts = ?, read_ts = COALESCE(read_ts, ?) WHERE id = ?').run(
    t.next.status,
    t.next.action,
    t.next.answer,
    now,
    now,
    id,
  );
  setAwaitingHuman(db, msg.cardId, false);
  return { ok: true, message: getInbox(db, id)! };
}

/** Mark a message read (idempotent — only stamps read_ts the first time). */
export function markInboxRead(db: DB, id: string): InboxMessage | undefined {
  db.prepare('UPDATE inbox_messages SET read_ts = COALESCE(read_ts, ?) WHERE id = ?').run(Date.now(), id);
  return getInbox(db, id);
}

/**
 * Answered/rejected messages an agent reads to RESUME after a HITL yield. Newest
 * answered first; optionally scoped to one agent (its own answers). list_answers op.
 */
export function listAnswers(db: DB, agentId?: string): InboxMessage[] {
  const where = ["status IN ('answered', 'rejected')"];
  const args: unknown[] = [];
  if (agentId) { where.push('from_agent_id = ?'); args.push(agentId); }
  const sql = `SELECT * FROM inbox_messages WHERE ${where.join(' AND ')} ORDER BY answered_ts DESC, rowid DESC`;
  return (db.prepare(sql).all(...args) as Row[]).map(rowToMessage);
}

/**
 * Anti-zombie: a user comment on `cardId` at `commentTs` supersedes every pending
 * ask on that card raised BEFORE the comment (supersedeDecision), and clears the
 * card's awaiting_human. Returns the count superseded (0 → the caller skips the
 * inbox.changed emit). Called when the user comments on a card.
 */
export function supersedeCardAsks(db: DB, cardId: string, commentTs: number): number {
  const pending = listInbox(db, { status: 'pending' }).filter((m) => m.cardId === cardId);
  const stale = pending.filter((m) => supersedeDecision(m, commentTs));
  if (stale.length === 0) return 0;
  const upd = db.prepare("UPDATE inbox_messages SET status = 'superseded' WHERE id = ?");
  for (const m of stale) upd.run(m.id);
  setAwaitingHuman(db, cardId, false);
  return stale.length;
}
