/**
 * User↔agent conversation threads — PURE logic (Phase 8, stage 7). Renderer-safe:
 * MUST stay free of any `node:*` / better-sqlite3 import so the thread UI, the IPC
 * surface and the IO layer share ONE definition of the status ladder, the message
 * validation, the prompt window and the unread count — every rule unit-testable
 * via `node --experimental-strip-types`.
 *
 * The IO/db side lives in core/threads.ts; this module holds only total functions.
 *
 * ONE ladder for BOTH surfaces. Every message the USER sends — to Alfred in the
 * main chat (`messages.status`) or to a team agent in a thread
 * (`agent_thread_messages.status`) — walks the SAME ladder, so the UI renders one
 * vocabulary of ticks everywhere:
 *
 *   queued → delivered → read → executing → done | error   (+ dropped)
 *
 * Forward-only with SKIPS allowed (Alfred's own chat jumps queued→executing: there
 * is no inbox to deliver to), and the three terminals ABSORB — once a message is
 * done/error/dropped nothing may move it again. That is what makes a crash-recovery
 * pass (reconcileStaleStatus) safe to run over every row on boot.
 */

// ── the ladder ────────────────────────────────────────────────────────────────

/** The unified user-message lifecycle, in ladder order. */
export const USER_MSG_STATUSES = ['queued', 'delivered', 'read', 'executing', 'done', 'error', 'dropped'] as const;
export type UserMsgStatus = (typeof USER_MSG_STATUSES)[number];

/** Narrow an arbitrary value (a DB cell, an IPC arg) to a known status. */
export function isUserMsgStatus(v: unknown): v is UserMsgStatus {
  return typeof v === 'string' && (USER_MSG_STATUSES as readonly string[]).includes(v);
}

/** The settled statuses: a message here is finished and can never move again. */
export const TERMINAL_STATUSES = ['done', 'error', 'dropped'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminalStatus(v: unknown): v is TerminalStatus {
  return typeof v === 'string' && (TERMINAL_STATUSES as readonly string[]).includes(v);
}

/**
 * Ladder rank. The three terminals share the TOP rank, so any non-terminal may
 * reach any of them (executing→error, queued→dropped) while no terminal can reach
 * another (the terminal check below refuses that first, on identity not rank).
 */
const RANK: Record<UserMsgStatus, number> = {
  queued: 0,
  delivered: 1,
  read: 2,
  executing: 3,
  done: 4,
  error: 4,
  dropped: 4,
};

/**
 * The one legal-move decision for the whole ladder. Forward-only: `next` must rank
 * STRICTLY above `current` (so re-marking the same rung is refused — the caller
 * skips it rather than churning a write), skipping rungs is legal, and every
 * terminal absorbs. Junk on either side is refused, never coerced. Pure + total.
 */
export function statusTransition(current: UserMsgStatus, next: UserMsgStatus): { ok: true } | { ok: false; error: string } {
  if (!isUserMsgStatus(current)) return { ok: false, error: `unknown current status "${String(current)}"` };
  if (!isUserMsgStatus(next)) return { ok: false, error: `unknown next status "${String(next)}"` };
  if (isTerminalStatus(current)) return { ok: false, error: `"${current}" is terminal — cannot move to "${next}"` };
  if (RANK[next] <= RANK[current]) {
    return { ok: false, error: `cannot move "${current}" → "${next}" (the status ladder is forward-only)` };
  }
  return { ok: true };
}

/**
 * Crash recovery. A message still mid-ladder when the app died can never be
 * advanced by anyone (its runner is gone), so boot settles it as `error`; a
 * terminal row has nothing to reconcile → null (skip the write). Defensive: an
 * unrecognised value counts as non-terminal, i.e. it gets settled too. Pure.
 */
export function reconcileStaleStatus(status: UserMsgStatus): UserMsgStatus | null {
  return isTerminalStatus(status) ? null : 'error';
}

/**
 * The ONE PT-PT label per rung (Phase 8, stage 9). Lives next to the ladder on
 * purpose: the main chat's user bubbles and a thread's user bubbles render the SAME
 * vocabulary from the SAME function, so a tick can never mean two things in two
 * panels.
 *
 * Deliberately short — a chip is read at a glance, so the failure REASON is never
 * folded in here; the caller puts `error` in the element's `title` (tooltip) and,
 * for a thread row, under the bubble. Total: an unknown value (a legacy DB cell)
 * falls back to the bottom rung rather than rendering blank.
 */
export function statusChipPt(status: UserMsgStatus): string {
  switch (status) {
    case 'delivered':
      return 'entregue';
    case 'read':
      return 'lida';
    case 'executing':
      return 'em execução';
    case 'done':
      return '✓ concluída';
    case 'error':
      return '⚠ falhou';
    case 'dropped':
      return 'descartada (fila cheia)';
    default:
      return 'na fila';
  }
}

// ── user message validation ───────────────────────────────────────────────────

/** Hard cap on one user message. Past this the send is REFUSED, never truncated. */
export const USER_MSG_MAX_CHARS = 8000;

/**
 * Validate + normalise an untrusted user message (typed in the UI, arriving over
 * IPC). Trims, refuses blank and refuses anything over the cap — loud, because a
 * silent truncation would send the agent half a question. Pure.
 */
export function validateUserMessage(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'message must be a string' };
  const text = raw.trim();
  if (!text) return { ok: false, error: 'message is required' };
  if (text.length > USER_MSG_MAX_CHARS) {
    return { ok: false, error: `message too long (${text.length} chars; max ${USER_MSG_MAX_CHARS})` };
  }
  return { ok: true, text };
}

// ── correlation ids ───────────────────────────────────────────────────────────

/** Hard cap on a caller-supplied message id (a primary key, not free text). */
export const MESSAGE_ID_MAX_CHARS = 64;

/**
 * The one shape a message id may have: `[A-Za-z0-9-]{1,64}` — enough for a
 * `crypto.randomUUID()` minted by the renderer for its optimistic bubble and for
 * our own `TM-<8hex>`, and nothing else.
 *
 * WHY a whitelist: this value arrives over IPC from the renderer and becomes a
 * PRIMARY KEY the status events are keyed on, so anything outside the charset (SQL
 * punctuation, path separators, whitespace, unicode homoglyphs, an unbounded blob)
 * is refused at the boundary and the caller mints its own id instead. Pure + total:
 * a non-string is `false`, never coerced.
 */
const MESSAGE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function isValidMessageId(v: unknown): v is string {
  return typeof v === 'string' && MESSAGE_ID_RE.test(v);
}

// ── shapes ────────────────────────────────────────────────────────────────────

/** One message in a user↔agent thread. `author` is 'user' or the agentId. */
export interface ThreadMessage {
  id: string;
  threadId: string;
  /** 'user' or the agentId — the ONLY authorship signal (no role column). */
  author: string;
  body: string;
  status: UserMsgStatus;
  /** Why it failed (status 'error'). */
  error?: string;
  createdTs: number;
  /**
   * Dual meaning by authorship: on a USER row, when the agent read it; on an
   * AGENT row, when the user opened it (that is what the unread badge counts).
   */
  readTs?: number;
  /** When the agent's run on this user message started (status 'executing'). */
  startedTs?: number;
  /** When it settled (done/error). */
  doneTs?: number;
}

/** Thread list projection: the row behind one line of the threads sidebar. */
export interface ThreadInfo {
  id: string;
  agentId: string;
  /** Body of the most recent message in the thread ('' when empty). */
  lastBody: string;
  /** Timestamp of that message (falls back to the thread's updatedTs). */
  lastTs: number;
  /** Agent-authored messages the user has not opened yet. */
  unread: number;
}

// ── the "new conversation" sentinel ───────────────────────────────────────────

/**
 * A thread row only exists once the FIRST message is sent (getOrCreateThread runs
 * inside sendUserMessage), so the UI needs a way to have a conversation OPEN before
 * it has an id. That is this sentinel: `new:<agentId>` is an openThreadId the view
 * understands as "this agent, empty history, nothing persisted yet". The real id
 * replaces it from the send's `{ ok, threadId }` ack.
 */
export const NEW_THREAD_PREFIX = 'new:';

export function newThreadSentinel(agentId: string): string {
  return `${NEW_THREAD_PREFIX}${agentId}`;
}

/**
 * Which agent an openThreadId talks to — the ONE resolver both surfaces share, so a
 * sentinel and a persisted thread take the same send path. A sentinel carries the id
 * inline; a real id is looked up in the list. Unknown / blank / nothing open → ''
 * (the caller shows its placeholder and never sends to an empty agent). Pure.
 */
export function openThreadAgentId(
  openThreadId: string | null | undefined,
  threads: readonly { id: string; agentId: string }[],
): string {
  if (!openThreadId) return '';
  if (openThreadId.startsWith(NEW_THREAD_PREFIX)) return openThreadId.slice(NEW_THREAD_PREFIX.length).trim();
  return threads.find((t) => t.id === openThreadId)?.agentId ?? '';
}

// ── prompt window ─────────────────────────────────────────────────────────────

/** Default window: the last N whole messages of history. */
export const THREAD_PROMPT_MAX_MESSAGES = 20;
/** Default window: history block char budget (whole messages dropped to fit). */
export const THREAD_PROMPT_MAX_CHARS = 8000;

/**
 * The framing. The agent is answering the USER, not writing a work report — the
 * thread is a conversation, not a board card. Kept as a stable constant so the
 * prompt does not drift between callers (and so the tests pin it).
 */
const FRAMING = [
  '# Mensagem direta do utilizador',
  'O utilizador enviou-te uma mensagem direta neste fio de conversa (não é uma tarefa do board).',
  'Responde-lhe diretamente, em texto corrido, na língua dele — sem relatório e sem preâmbulo.',
  'Sê breve e concreto. Se precisares de agir para responder, age e diz depois o que fizeste.',
].join('\n');

const HISTORY_HEADER = '# Conversa até agora';
const NEW_HEADER = '# Nova mensagem do utilizador';

/** Display label for a message author: the user, or the agent's name (id fallback). */
function authorLabel(author: string, agent: { id: string; name: string }): string {
  if (author === 'user') return 'Utilizador';
  return agent.name.trim() || agent.id;
}

/**
 * Build the prompt for one turn of a user↔agent thread: framing, then the windowed
 * history, then the new message LAST (so it is what the model acts on).
 *
 * Window, applied in this order: keep the last `maxMessages` (default 20) messages,
 * then — while the rendered history block is longer than `maxChars` (default 8000) —
 * drop the OLDEST message WHOLE. Never a half message: a truncated line would look
 * to the model like the user changed their mind mid-sentence. Blank bodies are
 * skipped, and an empty history omits the section entirely. Pure.
 */
export function buildThreadPrompt(
  agent: { id: string; name: string },
  history: readonly { author: string; body: string }[],
  newText: string,
  opts?: { maxMessages?: number; maxChars?: number },
): string {
  const maxMessages = opts?.maxMessages ?? THREAD_PROMPT_MAX_MESSAGES;
  const maxChars = opts?.maxChars ?? THREAD_PROMPT_MAX_CHARS;
  const lines = history
    .filter((m) => m.body?.trim())
    .map((m) => `${authorLabel(m.author, agent)}: ${m.body.trim()}`)
    .slice(-Math.max(0, maxMessages));
  // Drop whole messages from the oldest end until the block fits the budget.
  while (lines.length && lines.join('\n').length > maxChars) lines.shift();
  return [FRAMING, lines.length ? `${HISTORY_HEADER}\n${lines.join('\n')}` : '', `${NEW_HEADER}\n${newText.trim()}`]
    .filter(Boolean)
    .join('\n\n');
}

// ── unread count (badge) ──────────────────────────────────────────────────────

/**
 * Unread = an AGENT-authored message the user never opened. The user's own
 * messages are never unread to the user (their readTs tracks the agent's read).
 * Pure — shared by the sidebar badge and the IO projection.
 */
export function threadUnreadCount(messages: readonly { author: string; readTs?: number }[]): number {
  return messages.filter((m) => m.author !== 'user' && m.readTs == null).length;
}
