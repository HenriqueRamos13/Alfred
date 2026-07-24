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
import { createAgent, listAgents, deleteAgent, setAgentManager } from '../core/team.ts';
import type { AgentFormSpec } from '../core/agent-augment-pure.ts';

type Op = 'create' | 'list' | 'delete' | 'set_manager' | 'propose_agent';
interface Args {
  op: Op;
  name?: string;
  role?: string;
  provider?: string;
  model?: string;
  /** Optional per-agent autonomy grant (default read+notify). */
  grant?: string[];
  /** Optional PRIVILEGE role: "leaf" (default, no spawn) | "orchestrator" (may spawn, bounded). */
  delegationRole?: string;
  /** Optional per-agent daily token cap for autonomous runs (default unlimited beyond the global kill-switch). */
  dailyTokenBudget?: number;
  /** op=create (optional): manager this agent reports to (agent id), or null/omitted for top-level. */
  parentId?: string | null;
  /** op=create (optional): inbox power — may the agent message the user directly (default false, fail-closed). */
  canMessageUser?: boolean;
  /** op=propose_agent (optional): detailed system prompt / specialty hint to pre-fill. */
  systemPrompt?: string;
  /** op=propose_agent (optional): knowledge-seed hint to pre-fill. */
  knowledgeSeed?: string;
  /** delete target agent id. */
  id?: string;
  /** op=set_manager: the agent to reparent. */
  agentId?: string;
}

export const team: Tool<Args> = {
  name: 'team',
  description:
    'Manage the specialist agent ROSTER — named agents that extend the fixed three (main/reference/curator). ' +
    'Each agent has its OWN model and a private knowledge folder. ops: ' +
    'create {name, role?, provider, model, grant?} — persists the agent, scaffolds agents/<id>/knowledge/ + a seed role note, ' +
    'and updates the shared who-knows-what index; the model can be ANY id in the catalog (e.g. provider "claude-cli" + ' +
    'model "claude-opus-4-8" = Opus 4.8, or "claude-sonnet-5"); an unknown provider/model is rejected. grant is the agent\'s ' +
    'autonomy allowlist when delegated to (default ["read","notify"]). delegationRole is the PRIVILEGE role: "leaf" (default, ' +
    'cannot spawn/schedule/manage-roster/write-vault/message-user) or "orchestrator" (may spawn children, bounded). ' +
    'dailyTokenBudget is an optional per-agent daily token cap ' +
    'for autonomous runs (delegate/study); omitted → unlimited beyond the global kill-switch. ' +
    'parentId sets the MANAGER this agent reports to in the org hierarchy (omitted/null → top); canMessageUser grants ' +
    'inbox power to message the user directly (default false, fail-closed — leaves normally report only to their manager). ' +
    'list — enumerate the roster (each entry includes parentId + canMessageUser). delete {id} — remove the agent (its folder ' +
    'is left on disk; the index drops it). set_manager {agentId, parentId} — reparent an agent in the hierarchy; refused ' +
    'with an explicit error if it would create a management cycle or exceed the depth cap; parentId null = move to top. ' +
    'propose_agent {name?, role?, provider?, model?, parentId?, delegationRole?, dailyTokenBudget?, canMessageUser?, ' +
    'systemPrompt?, knowledgeSeed?} — does NOT create anything; it OPENS the agent-creation FORM for the user, pre-filled ' +
    'with these fields, so they can augment/review/confirm. PREFER this over create when the USER asks you to "create an ' +
    'agent" so they stay in control; use create only for programmatic/scripted creation. ' +
    'This tool creates/persists agents; RUN one with delegate_to_agent. create/delete/set_manager are T2; list + propose_agent are T0.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['create', 'list', 'delete', 'set_manager', 'propose_agent'] },
      name: { type: 'string', description: 'op=create: the agent display name (e.g. "Coder").' },
      role: { type: 'string', description: 'op=create: the specialty / system-prompt role (optional).' },
      provider: { type: 'string', description: 'op=create: provider id — one of claude-api, claude-cli, openai, deepseek.' },
      model: { type: 'string', description: 'op=create: a model id in the provider catalog, e.g. "claude-opus-4-8" (Opus 4.8).' },
      grant: {
        type: 'array',
        items: { type: 'string', enum: ['read', 'notify', 'write', 'browse', 'shell', 'send', 'delete', 'money', 'secrets'] },
        description: 'op=create (optional): the agent\'s autonomy allowlist when delegated to. Default ["read","notify"].',
      },
      delegationRole: {
        type: 'string',
        enum: ['leaf', 'orchestrator'],
        description:
          'op=create (optional): PRIVILEGE role (distinct from the free-text "role" specialty). "leaf" (default) cannot ' +
          'spawn/delegate, schedule jobs, manage the roster, write the shared vault, or message the user. "orchestrator" ' +
          'may spawn children (delegate_to_agent), bounded by max spawn depth + concurrent children.',
      },
      dailyTokenBudget: {
        type: 'number',
        description: 'op=create (optional): per-agent daily token cap for autonomous runs (delegate/study). Positive number; omitted → unlimited beyond the global kill-switch.',
      },
      parentId: {
        type: 'string',
        description: 'op=create/set_manager: the manager (agent id) this agent reports to; null or omitted → top of the org.',
      },
      canMessageUser: {
        type: 'boolean',
        description: 'op=create (optional): grant inbox power to message the user directly. Default false (fail-closed) — an orchestrator can always message the user; a leaf needs this flag.',
      },
      systemPrompt: { type: 'string', description: 'op=propose_agent (optional): detailed system-prompt / specialty hint to pre-fill in the form.' },
      knowledgeSeed: { type: 'string', description: 'op=propose_agent (optional): knowledge-seed hint (initial topics/notes) to pre-fill in the form.' },
      id: { type: 'string', description: 'op=delete: the agent id to remove.' },
      agentId: { type: 'string', description: 'op=set_manager: the agent to reparent.' },
    },
    required: ['op'],
  },

  risk: (a) => (a.op === 'list' || a.op === 'propose_agent' ? 'T0' : 'T2'),

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
        case 'set_manager': {
          if (!a.agentId) return { ok: false, error: 'agentId is required for set_manager' };
          const parentId = a.parentId == null ? null : String(a.parentId);
          const res = setAgentManager(ctx.db, a.agentId, parentId);
          if (!res.ok) return { ok: false, error: res.error };
          return { ok: true, result: { agentId: a.agentId, parentId } };
        }
        case 'propose_agent': {
          // No side effects — open the creation form for the user, pre-filled.
          // Only pass through the known form fields (the renderer's fillFormSpec
          // ignores anything else and defaults the rest).
          const spec: Partial<AgentFormSpec> = {};
          if (typeof a.name === 'string') spec.name = a.name;
          if (typeof a.role === 'string') spec.role = a.role;
          if (typeof a.provider === 'string') spec.provider = a.provider;
          if (typeof a.model === 'string') spec.model = a.model;
          if (a.parentId != null) spec.parentId = String(a.parentId);
          if (a.delegationRole === 'leaf' || a.delegationRole === 'orchestrator') spec.delegationRole = a.delegationRole;
          if (typeof a.dailyTokenBudget === 'number') spec.dailyTokenBudget = a.dailyTokenBudget;
          if (typeof a.canMessageUser === 'boolean') spec.canMessageUser = a.canMessageUser;
          if (typeof a.systemPrompt === 'string') spec.systemPrompt = a.systemPrompt;
          if (typeof a.knowledgeSeed === 'string') spec.knowledgeSeed = a.knowledgeSeed;
          ctx.emit({ kind: 'agent.form', spec });
          return { ok: true, result: { proposed: spec } };
        }
        default:
          return { ok: false, error: `Unknown op: ${(a as Args).op}` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
