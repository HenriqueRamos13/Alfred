/**
 * Kanban board — PURE logic (Phase 7, stage 1). Renderer-safe: MUST stay free of
 * any `node:*` / better-sqlite3 import so the Board UI and the tool share ONE
 * definition of the column graph, the Done-gate, the atomic claim, and the
 * lifecycle→recipient mapping, and every rule is unit-testable via
 * `node --experimental-strip-types` (see jobs-pure.ts / team-pure.ts).
 *
 * The IO/db side lives in core/kanban.ts; this module holds only total functions.
 * A card is a WORK SUBSTRATE, not a note (MetaGPT/ChatDev/Backlog.md ethos):
 * artifact + acceptance-criteria + definition-of-done + a dependency list, so a
 * card can only reach Done when its concrete artifact exists AND every DoD item
 * is ticked — never an agent's self-declaration (§11, anti-pattern "hallucinated
 * completion").
 */

// ── columns + priority ────────────────────────────────────────────────────────

/** The 6+1 board lanes. blocked/failed are the "never silently drop" lanes (§11). */
export const CARD_COLUMNS = ['backlog', 'todo', 'doing', 'review', 'done', 'blocked', 'failed'] as const;
export type CardColumn = (typeof CARD_COLUMNS)[number];
export function isCardColumn(v: unknown): v is CardColumn {
  return typeof v === 'string' && (CARD_COLUMNS as readonly string[]).includes(v);
}

export const PRIORITIES = ['low', 'med', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];
export function isPriority(v: unknown): v is Priority {
  return typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);
}

/** One acceptance-criteria / definition-of-done line: text + a self-tick. */
export interface ChecklistItem {
  text: string;
  done: boolean;
}

// ── the card ───────────────────────────────────────────────────────────────────

export interface KanbanCard {
  id: string;
  projectSlug: string;
  title: string;
  body: string;
  column: CardColumn;
  assigneeId: string | null;
  reviewerId: string | null;
  /** agentId or 'user'. */
  createdBy: string;
  /** agentId or 'user' the deliverable is FOR (notified on Done). */
  forWhom: string | null;
  priority: Priority;
  orderIdx: number;
  /** The concrete expected deliverable (spec/design/code/test-report). Gate input. */
  artifact: string;
  acceptance: ChecklistItem[];
  /** Definition-of-Done checklist — the Done-gate needs every item ticked. */
  dod: ChecklistItem[];
  /** Card ids this card depends on (a DAG, not a linear chain). */
  dependsOn: string[];
  /** Atomic claim owner (agentId) or null. */
  claimedBy: string | null;
  claimedTs: number | null;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number | null;
  stopCondition: string;
  createdTs: number;
  updatedTs: number;
  doneTs: number | null;
}

// ── tolerant parsers (shared by validateCardInput + the db row mapper) ──────────

/** Parse a checklist from unknown: array of {text,done} objects, or bare strings. */
export function parseChecklist(value: unknown): ChecklistItem[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: ChecklistItem[] = [];
  for (const it of value) {
    if (typeof it === 'string') {
      if (it.trim()) out.push({ text: it.trim(), done: false });
    } else if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>;
      const text = typeof o.text === 'string' ? o.text.trim() : '';
      if (text) out.push({ text, done: o.done === true });
    }
  }
  return out;
}

/** Parse a string list from unknown: a JSON/real array of non-empty strings, deduped. */
export function parseStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const it of value) {
    if (typeof it === 'string' && it.trim() && !out.includes(it.trim())) out.push(it.trim());
  }
  return out;
}

// ── create input validation ─────────────────────────────────────────────────────

/** Untrusted create input as it arrives from the tool / IPC boundary. */
export interface CardInput {
  projectSlug?: unknown;
  title?: unknown;
  body?: unknown;
  column?: unknown;
  assigneeId?: unknown;
  reviewerId?: unknown;
  createdBy?: unknown;
  forWhom?: unknown;
  priority?: unknown;
  artifact?: unknown;
  acceptance?: unknown;
  dod?: unknown;
  dependsOn?: unknown;
  maxAttempts?: unknown;
  timeoutMs?: unknown;
  stopCondition?: unknown;
}

/** Normalised, validated create spec (id/orderIdx/timestamps are assigned by createCard). */
export interface ValidCardSpec {
  projectSlug: string;
  title: string;
  body: string;
  column: CardColumn;
  assigneeId: string | null;
  reviewerId: string | null;
  createdBy: string;
  forWhom: string | null;
  priority: Priority;
  artifact: string;
  acceptance: ChecklistItem[];
  dod: ChecklistItem[];
  dependsOn: string[];
  maxAttempts: number;
  timeoutMs: number | null;
  stopCondition: string;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
/** Trimmed string → null when empty (assignee/reviewer/forWhom are nullable). */
const nullable = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};

/**
 * Validate + normalise an untrusted create spec. Pure so the tool/IPC can reject
 * bad input before touching the DB and the tests exercise every rejection.
 */
export function validateCardInput(input: CardInput): { ok: true; spec: ValidCardSpec } | { ok: false; error: string } {
  const projectSlug = str(input.projectSlug).trim();
  if (!projectSlug) return { ok: false, error: 'projectSlug is required' };
  const title = str(input.title).trim();
  if (!title) return { ok: false, error: 'title is required' };

  let column: CardColumn = 'backlog';
  if (input.column !== undefined) {
    if (!isCardColumn(input.column)) return { ok: false, error: `column must be one of: ${CARD_COLUMNS.join(', ')}` };
    column = input.column;
  }

  let priority: Priority = 'med';
  if (input.priority !== undefined) {
    if (!isPriority(input.priority)) return { ok: false, error: `priority must be one of: ${PRIORITIES.join(', ')}` };
    priority = input.priority;
  }

  let maxAttempts = 3;
  if (input.maxAttempts !== undefined) {
    if (typeof input.maxAttempts !== 'number' || !Number.isInteger(input.maxAttempts) || input.maxAttempts <= 0) {
      return { ok: false, error: 'maxAttempts must be a positive integer' };
    }
    maxAttempts = input.maxAttempts;
  }

  let timeoutMs: number | null = null;
  if (input.timeoutMs !== undefined && input.timeoutMs !== null) {
    if (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      return { ok: false, error: 'timeoutMs must be a positive number' };
    }
    timeoutMs = input.timeoutMs;
  }

  return {
    ok: true,
    spec: {
      projectSlug,
      title,
      body: str(input.body),
      column,
      assigneeId: nullable(input.assigneeId),
      reviewerId: nullable(input.reviewerId),
      createdBy: str(input.createdBy).trim() || 'user',
      forWhom: nullable(input.forWhom),
      priority,
      artifact: str(input.artifact),
      acceptance: parseChecklist(input.acceptance),
      dod: parseChecklist(input.dod),
      dependsOn: parseStringList(input.dependsOn),
      maxAttempts,
      timeoutMs,
      stopCondition: str(input.stopCondition),
    },
  };
}

// ── column transitions ───────────────────────────────────────────────────────

/** Forward/backward flow between the active lanes (excludes blocked/failed handling). */
const FLOW: Record<CardColumn, CardColumn[]> = {
  backlog: ['todo', 'doing'],
  todo: ['backlog', 'doing'],
  doing: ['todo', 'review', 'done'],
  review: ['doing', 'done'],
  done: ['review'], // re-open a done card (no rigid waterfall — §12)
  blocked: [],
  failed: [],
};

/** Lanes a blocked/failed card may be re-opened into (never straight to Done). */
const RECOVERABLE: readonly CardColumn[] = ['backlog', 'todo', 'doing', 'review'];

/**
 * Is a column transition structurally allowed? blocked/failed are reachable from
 * ANY lane (never silently drop a failed card), and a blocked/failed card re-opens
 * into any active lane. from===to is not a move. Reaching `done` is structurally
 * allowed only from doing/review — but ALSO requires the Done-gate to pass
 * (doneGateDecision), enforced by the caller since that needs the whole card.
 */
export function canMoveColumn(from: CardColumn, to: CardColumn): boolean {
  if (from === to) return false;
  if (!isCardColumn(from) || !isCardColumn(to)) return false;
  if (to === 'blocked' || to === 'failed') return true;
  if (from === 'blocked' || from === 'failed') return RECOVERABLE.includes(to);
  return FLOW[from].includes(to);
}

// ── the Done-gate (never accept a hallucinated completion) ─────────────────────

export interface DoneGate {
  allowed: boolean;
  reasons: string[];
}

/**
 * A card may reach Done ONLY when its artifact exists AND every definition-of-done
 * item is ticked — never on an agent's say-so. Returns the blocking reasons so the
 * UI/tool can show WHY (no silent refusal — matches the never-catch-and-rewrap rule).
 */
export function doneGateDecision(card: Pick<KanbanCard, 'artifact' | 'dod'>): DoneGate {
  const reasons: string[] = [];
  if (!card.artifact || !card.artifact.trim()) {
    reasons.push('artifact is empty — declare the concrete deliverable before Done');
  }
  const pending = card.dod.filter((d) => !d.done).length;
  if (pending > 0) reasons.push(`${pending} definition-of-done item(s) still unchecked`);
  return { allowed: reasons.length === 0, reasons };
}

// ── atomic claim / checkout (409 never retried) ────────────────────────────────

export type ClaimDecision = { ok: true } | { ok: false; reason: string };

/**
 * Whether `agentId` may claim this card. An unclaimed card (or one already claimed
 * by the same agent — idempotent) → ok; a card claimed by someone ELSE → conflict
 * (a 409 that must NEVER be retried, so two agents never grab one card — Paperclip
 * heartbeat protocol, §11).
 */
export function claimDecision(card: Pick<KanbanCard, 'claimedBy'>, agentId: string): ClaimDecision {
  if (!agentId || !agentId.trim()) return { ok: false, reason: 'claim needs a non-empty agentId' };
  if (card.claimedBy && card.claimedBy !== agentId) {
    return { ok: false, reason: `card already claimed by "${card.claimedBy}" (409 — do not retry)` };
  }
  return { ok: true };
}

// ── manual reorder within a lane ───────────────────────────────────────────────

/**
 * Move card `id` to position `toIdx` and return the list with a dense, 0-based
 * orderIdx reassigned to every card. Input order is taken from the current
 * orderIdx (stable). An unknown id leaves the order unchanged (just re-densified);
 * toIdx is clamped into range. Pure — the caller persists the new orderIdx values.
 */
export function reorder<T extends { id: string; orderIdx: number }>(cards: readonly T[], id: string, toIdx: number): T[] {
  const arr = [...cards].sort((a, b) => a.orderIdx - b.orderIdx);
  const from = arr.findIndex((c) => c.id === id);
  if (from !== -1) {
    const [moved] = arr.splice(from, 1);
    const clamped = Math.max(0, Math.min(Math.trunc(toIdx), arr.length));
    arr.splice(clamped, 0, moved);
  }
  return arr.map((c, i) => ({ ...c, orderIdx: i }));
}

// ── lifecycle → who to notify (Stage 4 consumes this; here it's just the list) ──

export type LifecycleEvent = 'assign' | 'review' | 'done';

/**
 * Who must be told when a card lifecycle event fires (self-orchestration):
 *  - assign → the assignee
 *  - review (→review) → the reviewer
 *  - done (→done) → the creator + for_whom
 * Returns ONLY the recipient list (deduped, empties dropped); the notification
 * table lands in Stage 4. Pure.
 */
export function lifecycleRecipients(
  card: Pick<KanbanCard, 'assigneeId' | 'reviewerId' | 'createdBy' | 'forWhom'>,
  event: LifecycleEvent,
): string[] {
  const pick = (...ids: (string | null | undefined)[]): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      const s = typeof id === 'string' ? id.trim() : '';
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  };
  switch (event) {
    case 'assign':
      return pick(card.assigneeId);
    case 'review':
      return pick(card.reviewerId);
    case 'done':
      return pick(card.createdBy, card.forWhom);
  }
}
