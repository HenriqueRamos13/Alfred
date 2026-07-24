/**
 * notify_agent — explicit agent-to-agent orchestration wake (Phase 7 stage 4).
 * Writes ONE targeted notification to another roster agent so a manager can poke a
 * report, or a report can flag its manager, without going through a card lifecycle.
 *
 * GATE (fail-closed, enforced in code — notifyPermission): a LEAF may only notify
 * UP its own manager chain; an ORCHESTRATOR may also notify DOWN to its descendants;
 * a sideways / cross-branch / self ping is refused with a clear error. The caller
 * identity is TRUSTED (ctx.caller, set by the delegate runner) — never taken from
 * model args. The top-level Alfred turn (no caller) may notify anyone.
 *
 * risk T1 (a targeted internal write, no egress). NOT a core tool — deferrable.
 * Emits notification.changed so the open Activity feed updates. See docs/tools/notify-agent.md.
 */
import type { Tool } from './types.ts';
import { notifyPermission } from '../core/notify-pure.ts';
import { insertNotification } from '../core/notify.ts';
import { listAgents } from '../core/team.ts';
import { getCard } from '../core/kanban.ts';

interface Args {
  toAgentId?: string;
  text?: string;
  cardId?: string;
}

export const notifyAgent: Tool<Args> = {
  name: 'notify_agent',
  description:
    'Send ONE targeted notification to another team agent (explicit self-orchestration wake) — a manager pokes a report, ' +
    'or a report flags its manager. {toAgentId, text, cardId?}. GATE (fail-closed): a leaf may only notify UP its manager ' +
    'chain; an orchestrator may also notify DOWN to its own reports; a sideways/self ping is refused. The recipient must be ' +
    'a roster agent (team op=list). Use for wakes, not for messaging the USER (that is the `inbox` tool). T1.',
  inputSchema: {
    type: 'object',
    properties: {
      toAgentId: { type: 'string', description: 'The roster agent to notify (must exist; up your chain, or down if you are an orchestrator).' },
      text: { type: 'string', description: 'The wake message.' },
      cardId: { type: 'string', description: 'Optional card the wake is about (scopes it to that project board).' },
    },
    required: ['toAgentId', 'text'],
  },

  risk: () => 'T1',

  async execute(a, ctx) {
    try {
      const to = (a.toAgentId ?? '').trim();
      const text = (a.text ?? '').trim();
      if (!to) return { ok: false, error: 'toAgentId is required' };
      if (!text) return { ok: false, error: 'text is required' };

      const agents = listAgents(ctx.db);
      if (!agents.some((x) => x.id === to)) {
        return { ok: false, error: `no roster agent with id "${to}" (team op=list to see them)` };
      }

      // TRUSTED sender: the delegated caller, or 'alfred' for the top-level turn.
      const caller = ctx.caller;
      const fromId = caller?.agentId ?? 'alfred';
      // A roster agent is gated up/down its chain; the top-level Alfred may notify anyone.
      if (caller && !notifyPermission(fromId, to, agents)) {
        const dir = caller.delegationRole === 'orchestrator' ? 'up your manager chain or down to your reports' : 'up your manager chain';
        return { ok: false, error: `notify refused: ${fromId} may only notify ${dir} (not "${to}")` };
      }

      // Scope to a project when a card is named (so it lands in that Activity feed).
      const cardId = (a.cardId ?? '').trim() || null;
      const projectSlug = cardId ? getCard(ctx.db, cardId)?.projectSlug ?? null : null;

      const note = insertNotification(ctx.db, { toAgentId: to, projectSlug, cardId, kind: 'reply', text: `${fromId}: ${text}` });
      ctx.emit({ kind: 'notification.changed', projectSlug: projectSlug ?? undefined });
      return { ok: true, result: { notification: note } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
