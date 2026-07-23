/**
 * team — manage the specialist agent ROSTER (Phase 5, stage 1). An open list of
 * user-defined agents that EXTENDS the fixed three (main/reference/curator); it
 * does NOT touch them. Each agent gets its own model + a private knowledge folder
 * (<workspace>/agents/<id>/knowledge/) scaffolded on create, and an entry in the
 * shared who-knows-what index (<workspace>/agents/index.md).
 *
 * This tool only PERSISTS + scaffolds; it never RUNS an agent (that ships in a
 * later stage). ops: create {name, role?, provider, model}, list, delete {id}.
 * Risk: create/delete = T2 (establish/remove a capability), list = T0.
 */
import type { Tool } from './types.ts';
import { validateAgentSpec } from '../core/team-pure.ts';
import { createAgent, listAgents, deleteAgent } from '../core/team.ts';

type Op = 'create' | 'list' | 'delete';
interface Args {
  op: Op;
  name?: string;
  role?: string;
  provider?: string;
  model?: string;
  /** delete target agent id. */
  id?: string;
}

export const team: Tool<Args> = {
  name: 'team',
  description:
    'Manage the specialist agent ROSTER — named agents that extend the fixed three (main/reference/curator). ' +
    'Each agent has its OWN model and a private knowledge folder. ops: ' +
    'create {name, role?, provider, model} — persists the agent, scaffolds agents/<id>/knowledge/ + a seed role note, ' +
    'and updates the shared who-knows-what index; the model can be ANY id in the catalog (e.g. provider "claude-cli" + ' +
    'model "claude-opus-4-8" = Opus 4.8, or "claude-sonnet-5"); an unknown provider/model is rejected. ' +
    'list — enumerate the roster. delete {id} — remove the agent (its folder is left on disk; the index drops it). ' +
    'This tool only creates/persists agents; it does NOT run them (delegation ships later). create/delete are T2; list is T0.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['create', 'list', 'delete'] },
      name: { type: 'string', description: 'op=create: the agent display name (e.g. "Coder").' },
      role: { type: 'string', description: 'op=create: the specialty / system-prompt role (optional).' },
      provider: { type: 'string', description: 'op=create: provider id — one of claude-api, claude-cli, openai, deepseek.' },
      model: { type: 'string', description: 'op=create: a model id in the provider catalog, e.g. "claude-opus-4-8" (Opus 4.8).' },
      id: { type: 'string', description: 'op=delete: the agent id to remove.' },
    },
    required: ['op'],
  },

  risk: (a) => (a.op === 'list' ? 'T0' : 'T2'),

  async execute(a, ctx) {
    try {
      switch (a.op) {
        case 'list':
          return { ok: true, result: { agents: listAgents(ctx.db) } };
        case 'create': {
          const v = validateAgentSpec(a);
          if (!v.ok) return { ok: false, error: v.error };
          const agent = await createAgent(ctx.db, ctx.workspace, v.spec);
          return { ok: true, result: { agent } };
        }
        case 'delete': {
          if (!a.id) return { ok: false, error: 'id is required for delete' };
          const deleted = await deleteAgent(ctx.db, ctx.workspace, a.id);
          if (!deleted) return { ok: false, error: `no agent with id ${a.id}` };
          return { ok: true, result: { deleted: a.id } };
        }
        default:
          return { ok: false, error: `Unknown op: ${(a as Args).op}` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
