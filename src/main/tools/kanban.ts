/**
 * kanban — the AGENT's machine-writable interface to a project board (Phase 7,
 * stage 1). Agents CRUD their own work through these structured verbs (ACI —
 * agent success depends on the interface being agent-shaped; SWE-agent §11),
 * SEPARATE from the human drag (which goes through the kanban IPC). Both persist
 * to kanban_cards and share the SAME invariants (core/kanban.ts + kanban-pure.ts):
 * gated column moves, the Done-gate (no hallucinated completion), and the atomic
 * claim (a 409 conflict is never retried).
 *
 * Governed like every other tool: risk tier per op (create/update/move/assign/
 * comment/claim/complete = T1; delete_card = T2; list/get = T0), routed through
 * the orchestrator's governance. NOT a core tool — deferrable. Emits the
 * `kanban.changed` StreamEvent after every write so the open board updates live.
 */
import type { Tool, RiskTier } from './types.ts';
import {
  createCard,
  listCards,
  getCard,
  patchCard,
  moveCard,
  assignCard,
  commentCard,
  claimCard,
  completeCard,
  deleteCard,
  type CardResult,
} from '../core/kanban.ts';
import { applyCardNotifications } from '../core/notify.ts';

type Op =
  | 'create_card'
  | 'list_cards'
  | 'get_card'
  | 'update_card'
  | 'move_card'
  | 'assign'
  | 'comment'
  | 'claim'
  | 'complete'
  | 'delete_card';

interface Args {
  op: Op;
  /** create_card / list_cards: the project slug. */
  projectSlug?: string;
  /** get/update/move/assign/comment/claim/complete/delete: the card id. */
  id?: string;
  title?: string;
  body?: string;
  column?: string;
  assigneeId?: string;
  reviewerId?: string;
  createdBy?: string;
  forWhom?: string;
  priority?: string;
  artifact?: string;
  acceptance?: unknown;
  dod?: unknown;
  dependsOn?: unknown;
  stopCondition?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  /** comment: the text. claim: the claiming agentId (defaults to createdBy/'alfred'). */
  text?: string;
  agentId?: string;
}

const RISK: Record<Op, RiskTier> = {
  create_card: 'T1',
  update_card: 'T1',
  move_card: 'T1',
  assign: 'T1',
  comment: 'T1',
  claim: 'T1',
  complete: 'T1',
  delete_card: 'T2',
  list_cards: 'T0',
  get_card: 'T0',
};

export const kanban: Tool<Args> = {
  name: 'kanban',
  description:
    'Machine-writable project Kanban board — agents CRUD their own work here (separate from the human drag). ' +
    'ops: create_card {projectSlug, title, body?, column?, assigneeId?, reviewerId?, forWhom?, priority?, artifact?, ' +
    'acceptance?[{text,done}], dod?[{text,done}], dependsOn?[cardId], maxAttempts?, timeoutMs?, stopCondition?} — ' +
    'columns are backlog|todo|doing|review|done|blocked|failed, priority low|med|high. ' +
    'list_cards {projectSlug} · get_card {id} · update_card {id, ...same fields} · move_card {id, column} — ' +
    'a card can only reach Done when its artifact exists AND every dod item is ticked (Done-gate; NEVER declare done yourself). ' +
    'assign {id, assigneeId?, reviewerId?} · comment {id, text} · claim {id, agentId} — an atomic checkout; a 409 conflict ' +
    '(another agent holds it) is NEVER retried · complete {id} — move to Done (enforces the gate) · delete_card {id} (T2). ' +
    'Create/update/move/assign/comment/claim/complete are T1; delete_card is T2; list/get are T0.',
  inputSchema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['create_card', 'list_cards', 'get_card', 'update_card', 'move_card', 'assign', 'comment', 'claim', 'complete', 'delete_card'],
      },
      projectSlug: { type: 'string', description: 'create_card / list_cards: the project slug.' },
      id: { type: 'string', description: 'the card id (get/update/move/assign/comment/claim/complete/delete).' },
      title: { type: 'string' },
      body: { type: 'string', description: 'description / running notes.' },
      column: { type: 'string', enum: ['backlog', 'todo', 'doing', 'review', 'done', 'blocked', 'failed'] },
      assigneeId: { type: 'string' },
      reviewerId: { type: 'string' },
      createdBy: { type: 'string', description: 'create_card: the creator (agentId or "user").' },
      forWhom: { type: 'string', description: 'who the deliverable is for (agentId or "user").' },
      priority: { type: 'string', enum: ['low', 'med', 'high'] },
      artifact: { type: 'string', description: 'the concrete expected deliverable (the Done-gate needs it non-empty).' },
      acceptance: { type: 'array', description: 'acceptance criteria [{text, done}].', items: { type: 'object' } },
      dod: { type: 'array', description: 'definition-of-done [{text, done}] — all must be done to reach Done.', items: { type: 'object' } },
      dependsOn: { type: 'array', description: 'card ids this card depends on.', items: { type: 'string' } },
      stopCondition: { type: 'string' },
      maxAttempts: { type: 'number' },
      timeoutMs: { type: 'number' },
      text: { type: 'string', description: 'comment: the comment text.' },
      agentId: { type: 'string', description: 'claim: the claiming agent id.' },
    },
    required: ['op'],
  },

  risk: (a) => RISK[a.op] ?? 'T1',

  async execute(a, ctx) {
    try {
      // Reads
      if (a.op === 'list_cards') {
        if (!a.projectSlug) return { ok: false, error: 'projectSlug is required for list_cards' };
        return { ok: true, result: { cards: listCards(ctx.db, a.projectSlug) } };
      }
      if (a.op === 'get_card') {
        if (!a.id) return { ok: false, error: 'id is required for get_card' };
        const card = getCard(ctx.db, a.id);
        if (!card) return { ok: false, error: `no card with id "${a.id}"` };
        return { ok: true, result: { card } };
      }

      // Writes — each returns a CardResult and (on success) emits kanban.changed.
      let res: CardResult;
      let slug = a.projectSlug ?? '';
      switch (a.op) {
        case 'create_card':
          res = createCard(ctx.db, {
            projectSlug: a.projectSlug,
            title: a.title,
            body: a.body,
            column: a.column,
            assigneeId: a.assigneeId,
            reviewerId: a.reviewerId,
            // A tool call is an agent acting; default the creator to 'alfred'.
            createdBy: a.createdBy ?? 'alfred',
            forWhom: a.forWhom,
            priority: a.priority,
            artifact: a.artifact,
            acceptance: a.acceptance,
            dod: a.dod,
            dependsOn: a.dependsOn,
            maxAttempts: a.maxAttempts,
            timeoutMs: a.timeoutMs,
            stopCondition: a.stopCondition,
          });
          break;
        case 'update_card':
          if (!a.id) return { ok: false, error: 'id is required for update_card' };
          res = patchCard(ctx.db, a.id, {
            title: a.title,
            body: a.body,
            column: a.column,
            assigneeId: a.assigneeId,
            reviewerId: a.reviewerId,
            forWhom: a.forWhom,
            priority: a.priority,
            artifact: a.artifact,
            acceptance: a.acceptance,
            dod: a.dod,
            dependsOn: a.dependsOn,
            stopCondition: a.stopCondition,
          });
          break;
        case 'move_card':
          if (!a.id) return { ok: false, error: 'id is required for move_card' };
          res = moveCard(ctx.db, a.id, a.column);
          break;
        case 'assign':
          if (!a.id) return { ok: false, error: 'id is required for assign' };
          res = assignCard(ctx.db, a.id, { assigneeId: a.assigneeId, reviewerId: a.reviewerId });
          break;
        case 'comment':
          if (!a.id) return { ok: false, error: 'id is required for comment' };
          res = commentCard(ctx.db, a.id, a.text ?? '', a.createdBy ?? a.agentId ?? 'alfred');
          break;
        case 'claim':
          if (!a.id) return { ok: false, error: 'id is required for claim' };
          res = claimCard(ctx.db, a.id, a.agentId ?? a.createdBy ?? 'alfred');
          break;
        case 'complete':
          if (!a.id) return { ok: false, error: 'id is required for complete' };
          res = completeCard(ctx.db, a.id);
          break;
        case 'delete_card': {
          if (!a.id) return { ok: false, error: 'id is required for delete_card' };
          const card = getCard(ctx.db, a.id);
          if (!card) return { ok: false, error: `no card with id "${a.id}"` };
          const removed = deleteCard(ctx.db, a.id);
          if (removed) ctx.emit({ kind: 'kanban.changed', projectSlug: card.projectSlug });
          return { ok: removed, result: { deleted: a.id } };
        }
        default:
          return { ok: false, error: `Unknown op: ${(a as Args).op}` };
      }

      if (!res.ok) return { ok: false, error: res.error + (res.reasons?.length ? `: ${res.reasons.join('; ')}` : '') };
      slug = res.card.projectSlug || slug;
      // Create the targeted wake notifications this transition earned (assign /
      // review / done + dependency wakes) BEFORE the board emit, so an auto-unblock
      // is already reflected when the board re-fetches.
      const notes = applyCardNotifications(ctx.db, res.card, res.events ?? []);
      ctx.emit({ kind: 'kanban.changed', projectSlug: slug });
      if (notes.length) ctx.emit({ kind: 'notification.changed', projectSlug: slug });
      return { ok: true, result: { card: res.card } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
