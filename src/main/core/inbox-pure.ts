/**
 * Human INBOX — PURE logic (Phase 7, stage 3). Renderer-safe: MUST stay free of
 * any `node:*` / better-sqlite3 import so the Inbox UI and the tool/IO share ONE
 * definition of the ask shape, the answer state-machine, the reject-requires-reason
 * rule, the idempotency dedupe, the anti-zombie supersede rule, and the unread
 * count — every rule unit-testable via `node --experimental-strip-types`.
 *
 * The IO/db side lives in core/inbox.ts; this module holds only total functions.
 *
 * The lesson #1 of the research (§3/§11): HITL is ASYNC, NEVER blocking. An agent
 * writes an ask, checkpoints the card (awaiting_human), and yields; the user's
 * answer re-wakes it later (the resume itself is Stage 4). The inbox is SEPARATE
 * from the formal T0–T3 tool approvals — a two-tier design (see docs/tools/inbox.md).
 */

// ── message shape ────────────────────────────────────────────────────────────

/** The three interaction kinds an agent may raise (NOT free-text yes/no). */
export const INBOX_KINDS = ['ask_user_questions', 'request_confirmation', 'suggest_tasks'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
export function isInboxKind(v: unknown): v is InboxKind {
  return typeof v === 'string' && (INBOX_KINDS as readonly string[]).includes(v);
}

/** Lifecycle status. pending → answered|rejected (typed action) OR superseded (zombie). */
export const INBOX_STATUSES = ['pending', 'answered', 'rejected', 'superseded'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export function isInboxStatus(v: unknown): v is InboxStatus {
  return typeof v === 'string' && (INBOX_STATUSES as readonly string[]).includes(v);
}

/** The typed answer actions (never a free-text guess): accept / edit / respond / reject. */
export const INBOX_ACTIONS = ['accept', 'edit', 'respond', 'reject'] as const;
export type InboxAction = (typeof INBOX_ACTIONS)[number];
export function isInboxAction(v: unknown): v is InboxAction {
  return typeof v === 'string' && (INBOX_ACTIONS as readonly string[]).includes(v);
}

export interface InboxMessage {
  id: string;
  /** The agent that raised it (TRUSTED — set by the runner from ctx, not the model). */
  fromAgentId: string;
  /** Optional project the ask belongs to (board filter). */
  projectSlug: string | null;
  /** Optional card checkpointed with awaiting_human while this ask is pending. */
  cardId: string | null;
  kind: InboxKind;
  subject: string;
  body: string;
  /** Dedupe key so a retried ask never duplicates (see dedupeByIdempotency). */
  idempotencyKey: string | null;
  status: InboxStatus;
  /** The typed action the user took (null while pending/superseded). */
  action: InboxAction | null;
  /** The user's answer / edited args / reject reason (null while pending). */
  answer: string | null;
  createdTs: number;
  /** When the user first opened it (null = unread). */
  readTs: number | null;
  answeredTs: number | null;
}

// ── create / ask validation ───────────────────────────────────────────────────

/** Untrusted ask args from the tool boundary (fromAgentId is added by the runner). */
export interface AskInput {
  kind?: unknown;
  subject?: unknown;
  body?: unknown;
  projectSlug?: unknown;
  cardId?: unknown;
  idempotencyKey?: unknown;
}

/** Normalised, validated ask (id/status/timestamps + fromAgentId assigned by the IO). */
export interface ValidAskSpec {
  kind: InboxKind;
  subject: string;
  body: string;
  projectSlug: string | null;
  cardId: string | null;
  idempotencyKey: string | null;
}

/** Trimmed string → null when empty. */
const nullable = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};

/**
 * Validate + normalise an untrusted ask. Pure, so the tool rejects bad input
 * before touching the DB and the tests exercise every rejection. kind must be one
 * of the three; subject required; body optional; project/card/idempotency nullable.
 */
export function validateAsk(input: AskInput): { ok: true; spec: ValidAskSpec } | { ok: false; error: string } {
  if (!isInboxKind(input.kind)) return { ok: false, error: `kind must be one of: ${INBOX_KINDS.join(', ')}` };
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  if (!subject) return { ok: false, error: 'subject is required' };
  return {
    ok: true,
    spec: {
      kind: input.kind,
      subject,
      body: typeof input.body === 'string' ? input.body : '',
      projectSlug: nullable(input.projectSlug),
      cardId: nullable(input.cardId),
      idempotencyKey: nullable(input.idempotencyKey),
    },
  };
}

// ── answer state-machine ───────────────────────────────────────────────────────

/** The next-state fields an answer produces (timestamp is stamped by the IO layer). */
export interface AnswerNext {
  status: 'answered' | 'rejected';
  action: InboxAction;
  answer: string;
}

/**
 * The answer transition. Only a PENDING message can be answered (answering an
 * already-resolved one is refused, never silently). accept/edit/respond →
 * answered; reject → rejected but ONLY with a non-empty reason (reject-requires-
 * reason — the reason goes back to the agent as context). Pure + total.
 */
export function answerTransition(
  msg: Pick<InboxMessage, 'status'>,
  action: string,
  text: string | undefined,
): { ok: true; next: AnswerNext } | { ok: false; error: string } {
  if (!isInboxAction(action)) return { ok: false, error: `action must be one of: ${INBOX_ACTIONS.join(', ')}` };
  if (msg.status !== 'pending') return { ok: false, error: `cannot answer a "${msg.status}" message (only pending)` };
  const answer = (text ?? '').trim();
  if (action === 'reject') {
    if (!answer) return { ok: false, error: 'reject requires reason' };
    return { ok: true, next: { status: 'rejected', action, answer } };
  }
  return { ok: true, next: { status: 'answered', action, answer } };
}

// ── anti-zombie supersede ──────────────────────────────────────────────────────

/**
 * A user comment on the SAME card, posted AFTER a still-pending ask, SUPERSEDES
 * that ask (the human already moved on — answering the stale question would be a
 * zombie). True = the caller marks the pending message superseded + clears the
 * card's awaiting_human. Callers scope `pending` to the card; this only decides on
 * status + ordering. Pure.
 */
export function supersedeDecision(pending: Pick<InboxMessage, 'status' | 'createdTs'>, userCommentTs: number): boolean {
  return pending.status === 'pending' && userCommentTs > pending.createdTs;
}

// ── idempotency dedupe ─────────────────────────────────────────────────────────

/**
 * Find an existing message carrying `key`, so a retried ask returns the original
 * instead of inserting a duplicate. A blank/absent key never dedupes (returns
 * undefined — every keyless ask is distinct). Pure.
 */
export function dedupeByIdempotency<T extends { idempotencyKey: string | null }>(
  existing: readonly T[],
  key: string | null | undefined,
): T | undefined {
  const k = (key ?? '').trim();
  if (!k) return undefined;
  return existing.find((m) => m.idempotencyKey === k);
}

// ── unread count (badge) ───────────────────────────────────────────────────────

/**
 * Unread = never opened (readTs null) and not a superseded zombie. Drives the
 * header badge + the "N NÃO LIDAS" chip. Pure.
 */
export function unreadCount(msgs: readonly Pick<InboxMessage, 'readTs' | 'status'>[]): number {
  return msgs.filter((m) => m.readTs == null && m.status !== 'superseded').length;
}
