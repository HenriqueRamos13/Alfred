/**
 * Kanban board — persistence (kanban_cards table). MAIN-only: takes the Database
 * by PARAMETER (never value-imports the driver), so the pure logic (kanban-pure.ts)
 * stays testable and this file stays a thin IO wrapper. Shared by BOTH write
 * surfaces: the governed `kanban` tool (agent) and the user's UI drag/edit (IPC).
 *
 * The invariants live in kanban-pure.ts — this module only reads/writes rows and
 * routes column changes through canMoveColumn + the Done-gate so neither surface
 * can slip a card into Done without its artifact + a green DoD.
 */
import { randomUUID } from 'node:crypto';
import {
  validateCardInput,
  canMoveColumn,
  doneGateDecision,
  claimDecision,
  parseChecklist,
  parseStringList,
  isCardColumn,
  isPriority,
  type CardInput,
  type ChecklistItem,
  type KanbanCard,
} from './kanban-pure.ts';

type DB = import('better-sqlite3').Database;

interface Row {
  id: string;
  project_slug: string;
  title: string;
  body: string;
  column: string;
  assignee_id: string | null;
  reviewer_id: string | null;
  created_by: string;
  for_whom: string | null;
  priority: string;
  order_idx: number;
  artifact: string;
  acceptance_json: string;
  dod_json: string;
  depends_on_json: string;
  claimed_by: string | null;
  claimed_ts: number | null;
  attempts: number;
  max_attempts: number;
  timeout_ms: number | null;
  stop_condition: string;
  awaiting_human: number;
  created_ts: number;
  updated_ts: number;
  done_ts: number | null;
}

function rowToCard(r: Row): KanbanCard {
  return {
    id: r.id,
    projectSlug: r.project_slug,
    title: r.title,
    body: r.body,
    column: isCardColumn(r.column) ? r.column : 'backlog',
    assigneeId: r.assignee_id ?? null,
    reviewerId: r.reviewer_id ?? null,
    createdBy: r.created_by ?? 'user',
    forWhom: r.for_whom ?? null,
    priority: isPriority(r.priority) ? r.priority : 'med',
    orderIdx: r.order_idx,
    artifact: r.artifact ?? '',
    acceptance: parseChecklist(r.acceptance_json),
    dod: parseChecklist(r.dod_json),
    dependsOn: parseStringList(r.depends_on_json),
    claimedBy: r.claimed_by ?? null,
    claimedTs: r.claimed_ts ?? null,
    attempts: r.attempts ?? 0,
    maxAttempts: r.max_attempts ?? 3,
    timeoutMs: r.timeout_ms ?? null,
    stopCondition: r.stop_condition ?? '',
    awaitingHuman: r.awaiting_human === 1,
    createdTs: r.created_ts,
    updatedTs: r.updated_ts,
    doneTs: r.done_ts ?? null,
  };
}

// `SELECT *` returns `column` as the property key; alias not needed, but the
// identifier is quoted everywhere in DDL/DML because COLUMN is a SQLite keyword.
export function listCards(db: DB, projectSlug: string): KanbanCard[] {
  return (
    db
      .prepare('SELECT * FROM kanban_cards WHERE project_slug = ? ORDER BY order_idx, created_ts')
      .all(projectSlug) as Row[]
  ).map(rowToCard);
}

export function getCard(db: DB, id: string): KanbanCard | undefined {
  const r = db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToCard(r) : undefined;
}

/** Human-friendly, per-project unique id: `<PREFIX>-<n>` (n = max numeric suffix + 1). */
function nextCardId(db: DB, projectSlug: string): string {
  const prefix = (projectSlug.replace(/[^a-z0-9]/gi, '').slice(0, 3) || 'card').toUpperCase();
  const rows = db.prepare('SELECT id FROM kanban_cards WHERE project_slug = ?').all(projectSlug) as { id: string }[];
  let max = 0;
  for (const r of rows) {
    const m = r.id.match(/-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  // Collision backstop (a manually-set id could clash): fall back to a uuid tail.
  const id = `${prefix}-${max + 1}`;
  return getCard(db, id) ? `${prefix}-${randomUUID().slice(0, 8)}` : id;
}

const j = (v: ChecklistItem[] | string[]): string => JSON.stringify(v);

/** Create a card from validated input; assigns id, order_idx (end of its lane), timestamps. */
export function createCard(db: DB, input: CardInput): CardResult {
  const v = validateCardInput(input);
  if (!v.ok) return v;
  const s = v.spec;
  // Same Done-gate as patchCard: creating a card straight into `done` must clear
  // the gate too, else create_card is a hole around the no-hallucinated-completion
  // invariant (an agent could open a card already "done" with no artifact/DoD).
  if (s.column === 'done') {
    const gate = doneGateDecision({ artifact: s.artifact, dod: s.dod });
    if (!gate.allowed) return { ok: false, error: 'Done-gate blocked this card', reasons: gate.reasons };
  }
  const id = nextCardId(db, s.projectSlug);
  const now = Date.now();
  const orderIdx =
    (db
      .prepare('SELECT COALESCE(MAX(order_idx), -1) + 1 AS n FROM kanban_cards WHERE project_slug = ? AND "column" = ?')
      .get(s.projectSlug, s.column) as { n: number }).n;
  db.prepare(
    `INSERT INTO kanban_cards
       (id, project_slug, title, body, "column", assignee_id, reviewer_id, created_by, for_whom, priority,
        order_idx, artifact, acceptance_json, dod_json, depends_on_json, claimed_by, claimed_ts,
        attempts, max_attempts, timeout_ms, stop_condition, created_ts, updated_ts, done_ts)
     VALUES
       (@id, @projectSlug, @title, @body, @column, @assigneeId, @reviewerId, @createdBy, @forWhom, @priority,
        @orderIdx, @artifact, @acceptance, @dod, @dependsOn, NULL, NULL,
        0, @maxAttempts, @timeoutMs, @stopCondition, @now, @now, @doneTs)`,
  ).run({
    id,
    projectSlug: s.projectSlug,
    title: s.title,
    body: s.body,
    column: s.column,
    assigneeId: s.assigneeId,
    reviewerId: s.reviewerId,
    createdBy: s.createdBy,
    forWhom: s.forWhom,
    priority: s.priority,
    orderIdx,
    artifact: s.artifact,
    acceptance: j(s.acceptance),
    dod: j(s.dod),
    dependsOn: j(s.dependsOn),
    maxAttempts: s.maxAttempts,
    timeoutMs: s.timeoutMs,
    stopCondition: s.stopCondition,
    now,
    doneTs: s.column === 'done' ? now : null,
  });
  return { ok: true, card: getCard(db, id)! };
}

/** Editable subset a patch may carry (column change is gated; see patchCard). */
export interface CardPatchInput {
  title?: unknown;
  body?: unknown;
  column?: unknown;
  assigneeId?: unknown;
  reviewerId?: unknown;
  forWhom?: unknown;
  priority?: unknown;
  artifact?: unknown;
  acceptance?: unknown;
  dod?: unknown;
  dependsOn?: unknown;
  stopCondition?: unknown;
}

export type CardResult = { ok: true; card: KanbanCard } | { ok: false; error: string; reasons?: string[] };

/**
 * Patch a card. A `column` change is routed through canMoveColumn AND, when the
 * target is `done`, the Done-gate (doneGateDecision) — so neither the agent tool
 * nor the user drag can slip a card into Done without its artifact + a green DoD.
 * Other fields are updated only when present in the patch. Field changes are
 * applied FIRST, so setting artifact/dod and moving to Done in one save passes
 * the gate against the new values.
 */
export function patchCard(db: DB, id: string, patch: CardPatchInput): CardResult {
  const card = getCard(db, id);
  if (!card) return { ok: false, error: `no card with id "${id}"` };
  const now = Date.now();

  const sets: string[] = [];
  const vals: Record<string, unknown> = { id, now };
  const set = (col: string, key: string, value: unknown) => {
    sets.push(`${col} = @${key}`);
    vals[key] = value;
  };

  if (patch.title !== undefined) {
    const t = String(patch.title).trim();
    if (!t) return { ok: false, error: 'title cannot be empty' };
    set('title', 'title', t);
  }
  if (patch.body !== undefined) set('body', 'body', String(patch.body));
  if (patch.artifact !== undefined) set('artifact', 'artifact', String(patch.artifact));
  if (patch.stopCondition !== undefined) set('stop_condition', 'stopCondition', String(patch.stopCondition));
  if (patch.assigneeId !== undefined) set('assignee_id', 'assigneeId', nullable(patch.assigneeId));
  if (patch.reviewerId !== undefined) set('reviewer_id', 'reviewerId', nullable(patch.reviewerId));
  if (patch.forWhom !== undefined) set('for_whom', 'forWhom', nullable(patch.forWhom));
  if (patch.priority !== undefined) {
    if (!isPriority(patch.priority)) return { ok: false, error: 'priority must be low|med|high' };
    set('priority', 'priority', patch.priority);
  }
  if (patch.acceptance !== undefined) set('acceptance_json', 'acceptance', j(parseChecklist(patch.acceptance)));
  if (patch.dod !== undefined) set('dod_json', 'dod', j(parseChecklist(patch.dod)));
  if (patch.dependsOn !== undefined) set('depends_on_json', 'dependsOn', j(parseStringList(patch.dependsOn)));

  // Column transition (gated). The Done-gate is checked against the effective
  // values AFTER this same patch, so setting artifact/dod and moving to Done in
  // one save is evaluated against the new values.
  if (patch.column !== undefined && patch.column !== card.column) {
    if (!isCardColumn(patch.column)) return { ok: false, error: 'column must be a valid lane' };
    const to = patch.column;
    if (!canMoveColumn(card.column, to)) {
      return { ok: false, error: `illegal transition ${card.column} → ${to}` };
    }
    if (to === 'done') {
      const gate = doneGateDecision({
        artifact: patch.artifact !== undefined ? String(patch.artifact) : card.artifact,
        dod: patch.dod !== undefined ? parseChecklist(patch.dod) : card.dod,
      });
      if (!gate.allowed) return { ok: false, error: 'Done-gate blocked this card', reasons: gate.reasons };
    }
    set('"column"', 'column', to);
    set('done_ts', 'doneTs', to === 'done' ? now : null);
  }

  if (sets.length === 0) return { ok: true, card }; // nothing to change
  sets.push('updated_ts = @now');
  db.prepare(`UPDATE kanban_cards SET ${sets.join(', ')} WHERE id = @id`).run(vals);
  return { ok: true, card: getCard(db, id)! };
}

function nullable(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

/** Assign / set reviewer (lifecycle notify lands in Stage 4). */
export function assignCard(db: DB, id: string, patch: { assigneeId?: unknown; reviewerId?: unknown }): CardResult {
  return patchCard(db, id, patch);
}

/** Move a card between lanes (drag). Gated by patchCard. */
export function moveCard(db: DB, id: string, to: unknown): CardResult {
  return patchCard(db, id, { column: to });
}

/** Complete a card = move it to Done (enforces the Done-gate). */
export function completeCard(db: DB, id: string): CardResult {
  return patchCard(db, id, { column: 'done' });
}

/** Atomic claim (409 never retried). Sets claimed_by/claimed_ts on success. */
export function claimCard(db: DB, id: string, agentId: string): CardResult {
  const card = getCard(db, id);
  if (!card) return { ok: false, error: `no card with id "${id}"` };
  const d = claimDecision(card, agentId);
  if (!d.ok) return { ok: false, error: d.reason };
  db.prepare('UPDATE kanban_cards SET claimed_by = ?, claimed_ts = ?, updated_ts = ? WHERE id = ?').run(
    agentId,
    Date.now(),
    Date.now(),
    id,
  );
  return { ok: true, card: getCard(db, id)! };
}

/**
 * Post a comment. No comments table exists in the data model, and the tool spec
 * says "persist in kanban_cards", so a comment is appended to `body` as a dated,
 * authored line.
 * ponytail: comments fold into `body` for Stage 1; a dedicated kanban_comments
 * table + thread UI is the upgrade path when the Activity/notification work
 * (Stage 4) needs a real feed.
 */
export function commentCard(db: DB, id: string, text: string, author: string): CardResult {
  const card = getCard(db, id);
  if (!card) return { ok: false, error: `no card with id "${id}"` };
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, error: 'comment text is required' };
  const line = `[${author || 'user'} @ ${new Date().toISOString()}] ${t}`;
  const body = card.body ? `${card.body}\n${line}` : line;
  db.prepare('UPDATE kanban_cards SET body = ?, updated_ts = ? WHERE id = ?').run(body, Date.now(), id);
  return { ok: true, card: getCard(db, id)! };
}

/** Delete a card. Returns whether a row was removed. */
export function deleteCard(db: DB, id: string): boolean {
  return db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id).changes > 0;
}
