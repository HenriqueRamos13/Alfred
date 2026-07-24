/**
 * inbox — an agent's ASYNC channel to the USER (Phase 7, stage 3). The lesson #1
 * of the research: HITL is async, NEVER blocking. `ask_user` writes a message,
 * checkpoints the card (awaiting_human), emits inbox.changed, and RETURNS
 * IMMEDIATELY — the agent yields; the user's answer re-wakes it (resume = Stage 4).
 *
 * GATE (fail-closed): only an agent with RESOLVED can_message_user power may write
 * — an orchestrator always, a leaf only with the explicit flag (canMessageUserResolved).
 * The caller identity is TRUSTED (ctx.caller, set by the delegate runner), never
 * taken from model args. A leaf without the flag is refused with a clear error.
 *
 * SEPARATE from the formal T0–T3 tool approvals (two-tier): approvals gate a
 * dangerous tool CALL before it runs; the inbox is a conversation the agent starts
 * with the user. risk: ask_user=T1, list_answers=T0. See docs/tools/inbox.md.
 */
import type { Tool, RiskTier } from './types.ts';
import { canMessageUserResolved } from '../core/team-format-pure.ts';
import { createAsk, listAnswers } from '../core/inbox.ts';

type Op = 'ask_user' | 'list_answers';

interface Args {
  op: Op;
  /** ask_user: the interaction kind. */
  kind?: string;
  subject?: string;
  body?: string;
  projectSlug?: string;
  cardId?: string;
  idempotencyKey?: string;
  /** list_answers: scope to one agent's own answers (else all answered/rejected). */
  agentId?: string;
}

const RISK: Record<Op, RiskTier> = { ask_user: 'T1', list_answers: 'T0' };

export const inbox: Tool<Args> = {
  name: 'inbox',
  description:
    "Message the USER asynchronously (never blocking) — write, checkpoint, yield; the user's answer re-wakes you later. " +
    'ops: ask_user {kind, subject, body?, projectSlug?, cardId?, idempotencyKey?} — kind is ' +
    'ask_user_questions|request_confirmation|suggest_tasks; if cardId is set the card is marked awaiting_human (a ⏳ badge) ' +
    'until answered; idempotencyKey dedupes a retried ask. Returns IMMEDIATELY (does NOT wait for the answer). ' +
    'list_answers {agentId?} — read your answered messages to resume (typed action accept|edit|respond|reject + the answer text). ' +
    'GATE: only an agent that may message the user (orchestrator, or a leaf with can_message_user) can ask_user — else a clear refusal. ' +
    'ask_user is T1, list_answers is T0. This is SEPARATE from the formal tool approvals (two-tier).',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['ask_user', 'list_answers'] },
      kind: {
        type: 'string',
        enum: ['ask_user_questions', 'request_confirmation', 'suggest_tasks'],
        description: 'ask_user: the interaction kind.',
      },
      subject: { type: 'string', description: 'ask_user: a short one-line summary.' },
      body: { type: 'string', description: 'ask_user: the full message / question / proposal.' },
      projectSlug: { type: 'string', description: 'ask_user: the project this relates to (board filter).' },
      cardId: { type: 'string', description: 'ask_user: the card to checkpoint (awaiting_human) until answered.' },
      idempotencyKey: { type: 'string', description: 'ask_user: dedupe key so a retried ask never duplicates.' },
      agentId: { type: 'string', description: 'list_answers: scope to this agent (else all answered/rejected).' },
    },
    required: ['op'],
  },

  risk: (a) => RISK[a.op] ?? 'T1',

  async execute(a, ctx) {
    try {
      if (a.op === 'list_answers') {
        return { ok: true, result: { answers: listAnswers(ctx.db, a.agentId) } };
      }
      if (a.op === 'ask_user') {
        // Fail-closed gate. ctx.caller is the delegated agent (trusted). Absent →
        // the top-level Alfred turn (the primary orchestrator) — always allowed.
        const caller = ctx.caller;
        const allowed = caller ? canMessageUserResolved(caller) : true;
        if (!allowed) {
          return { ok: false, error: `agent lacks can_message_user (${caller?.agentId ?? 'unknown'} is a leaf without the flag)` };
        }
        // TRUSTED sender: the caller's agentId, or 'alfred' for the top-level turn.
        const fromAgentId = caller?.agentId ?? 'alfred';
        const res = createAsk(ctx.db, fromAgentId, {
          kind: a.kind,
          subject: a.subject,
          body: a.body,
          projectSlug: a.projectSlug,
          cardId: a.cardId,
          idempotencyKey: a.idempotencyKey,
        });
        if (!res.ok) return { ok: false, error: res.error };
        // Async: emit so the open Inbox/board updates, and RETURN NOW (never wait).
        ctx.emit({ kind: 'inbox.changed' });
        return { ok: true, result: { message: res.message, deduped: res.deduped ?? false } };
      }
      return { ok: false, error: `Unknown op: ${(a as Args).op}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
