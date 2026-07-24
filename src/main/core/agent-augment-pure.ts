/**
 * Agent-creation FORM + AI augment — PURE logic (Phase 7, stage 5).
 *
 * RENDERER-SAFE: value-imports ONLY modelCatalog.ts (which itself imports nothing
 * from node / the AI SDK), so the AgentForm component + the preload + tests can
 * import this directly. It never touches disk, the DB, or a model — the augment
 * IO turn lives in orchestrator.ts and calls these pure helpers.
 *
 * Flow: the user fills what they know, flags augmentable fields with ✨ (or leaves
 * them blank), submits → `augmentPlan` picks which fields Alfred fills, a cheap
 * brain turn returns JSON, `mergeAugmented` folds it in WITHOUT ever clobbering a
 * field the user typed and did NOT flag, `validateFormSpec` gates it, then the UI
 * creates the agent (mapped to the roster's AgentSpecInput via `formSpecToCreate`).
 */

import { isProviderId, findModel, PROVIDER_IDS } from './modelCatalog.ts';
import type { DelegationRole, AgentSpecInput } from './team-pure.ts';

/**
 * The form's working spec. `role` is the TYPE label (PM / Dev-Back / QA …);
 * `systemPrompt` is the detailed specialty prompt — both feed the persisted
 * roster `role` (see formSpecToCreate). `knowledgeSeed` seeds the agent's first
 * private note. Every field is present (empty string / null / false) so the form
 * is a controlled component and the augment merge is total.
 */
export interface AgentFormSpec {
  name: string;
  /** Type / role label (augmentable). */
  role: string;
  provider: string;
  /** Model id — must live in `provider`'s catalog (augmentable). */
  model: string;
  /** Manager this agent reports to (agent id), or null for top of the org. */
  parentId: string | null;
  /** Inbox power — may it message the user directly (fail-closed default false). */
  canMessageUser: boolean;
  delegationRole: DelegationRole;
  /** Per-agent daily token cap; undefined → unlimited beyond the global kill-switch. */
  dailyTokenBudget?: number;
  /** Detailed specialty / system prompt (augmentable). */
  systemPrompt: string;
  /** Seed knowledge notes / topics the specialist starts with (augmentable). */
  knowledgeSeed: string;
}

/** The fields a ✨ toggle can mark for AI augmentation. */
export type AugmentField = 'role' | 'model' | 'systemPrompt' | 'knowledgeSeed';
export const AUGMENTABLE_FIELDS: readonly AugmentField[] = ['role', 'model', 'systemPrompt', 'knowledgeSeed'];

/** Which augmentable fields the user marked ✨ ("let the AI choose/expand this"). */
export type AugmentFlags = Partial<Record<AugmentField, boolean>>;

/** ponytail: the two DelegationRole literals, duplicated here so this module stays
 * renderer-safe (the DELEGATION_ROLES const lives in team-pure, which value-imports
 * node via projects.ts). If a third role is ever added, sync this one line. */
const DELEGATION_ROLE_VALUES: readonly DelegationRole[] = ['leaf', 'orchestrator'];

/** A default, empty form spec (a blank "+ Agent" open). */
export function emptyFormSpec(): AgentFormSpec {
  return {
    name: '',
    role: '',
    provider: 'claude-cli',
    model: '',
    parentId: null,
    canMessageUser: false,
    delegationRole: 'leaf',
    dailyTokenBudget: undefined,
    systemPrompt: '',
    knowledgeSeed: '',
  };
}

/**
 * Merge a partial spec (from an `agent.form` event, e.g. `propose_agent`) onto the
 * empty defaults so the form opens pre-filled and fully controlled. Unknown keys
 * are ignored; only the known AgentFormSpec fields are taken.
 */
export function fillFormSpec(partial: Partial<AgentFormSpec> | null | undefined): AgentFormSpec {
  const base = emptyFormSpec();
  if (!partial || typeof partial !== 'object') return base;
  const p = partial as Record<string, unknown>;
  if (typeof p.name === 'string') base.name = p.name;
  if (typeof p.role === 'string') base.role = p.role;
  if (typeof p.provider === 'string') base.provider = p.provider;
  if (typeof p.model === 'string') base.model = p.model;
  if (typeof p.parentId === 'string' && p.parentId.trim()) base.parentId = p.parentId.trim();
  else if (p.parentId === null) base.parentId = null;
  if (typeof p.canMessageUser === 'boolean') base.canMessageUser = p.canMessageUser;
  if (p.delegationRole === 'leaf' || p.delegationRole === 'orchestrator') base.delegationRole = p.delegationRole;
  if (typeof p.dailyTokenBudget === 'number' && Number.isFinite(p.dailyTokenBudget) && p.dailyTokenBudget > 0) {
    base.dailyTokenBudget = p.dailyTokenBudget;
  }
  if (typeof p.systemPrompt === 'string') base.systemPrompt = p.systemPrompt;
  if (typeof p.knowledgeSeed === 'string') base.knowledgeSeed = p.knowledgeSeed;
  return base;
}

/** Is an augmentable field currently blank (trim-empty)? */
function isBlank(spec: AgentFormSpec, f: AugmentField): boolean {
  return !String(spec[f] ?? '').trim();
}

/**
 * The fields Alfred should fill on submit: every augmentable field that is either
 * flagged ✨ OR left blank. A field the user typed and did NOT flag is never in the
 * plan → the augment turn can't touch it. Pure; order follows AUGMENTABLE_FIELDS.
 */
export function augmentPlan(spec: AgentFormSpec, flags: AugmentFlags): AugmentField[] {
  return AUGMENTABLE_FIELDS.filter((f) => flags[f] === true || isBlank(spec, f));
}

/** Human, model-facing description of each augmentable field (drives the prompt). */
const FIELD_BRIEF: Record<AugmentField, string> = {
  role: 'a short TYPE/role label for the agent (e.g. "Backend Dev", "QA", "PM", "DevOps")',
  model: 'the best model id for this agent — you MUST pick one exactly from the provider catalog listed in the context',
  systemPrompt:
    'a concise but complete system prompt: the specialty, the standards it must hold (e.g. TDD, security), and how it should work and report',
  knowledgeSeed:
    'a few short bullet topics/notes this specialist should start its private knowledge with (plain text, one per line)',
};

/**
 * Build the (pure) instruction for the cheap augment turn: what agent is being
 * created, what the user already provided (as hints for flagged fields), the team
 * context (roster + hierarchy + available models, assembled by the caller), and a
 * strict "return ONLY JSON with exactly these keys" contract. The caller runs this
 * on a read-only brain with no tools and parses the JSON tolerantly.
 */
export function buildAugmentPrompt(
  spec: AgentFormSpec,
  fieldsToFill: readonly AugmentField[],
  teamContext: string,
): string {
  const known: string[] = [
    `name: ${spec.name.trim() || '(unset — suggest nothing; keep it)'}`,
    `provider: ${spec.provider}`,
  ];
  if (spec.role.trim()) known.push(`role hint: ${spec.role.trim()}`);
  if (spec.model.trim()) known.push(`model hint: ${spec.model.trim()}`);
  if (spec.systemPrompt.trim()) known.push(`system-prompt hint: ${spec.systemPrompt.trim()}`);
  if (spec.knowledgeSeed.trim()) known.push(`knowledge-seed hint: ${spec.knowledgeSeed.trim()}`);
  known.push(`delegation role: ${spec.delegationRole}`);

  const asks = fieldsToFill.map((f) => `- "${f}": ${FIELD_BRIEF[f]}`).join('\n');

  return [
    'You help design a new specialist agent for a small software team run by Alfred.',
    'Fill ONLY the requested fields sensibly for THIS team. Where the user gave a hint, expand/refine it; do not discard their intent.',
    '',
    '# The agent so far',
    known.join('\n'),
    '',
    '# Team context (roster, hierarchy, available models for the chosen provider)',
    teamContext.trim() || '(no other agents yet — this may be the first)',
    '',
    '# Fill these fields',
    asks,
    '',
    'Respond with ONLY a single JSON object with EXACTLY these keys ' +
      `(${fieldsToFill.map((f) => `"${f}"`).join(', ')}) and string values. No prose, no code fences.`,
  ].join('\n');
}

/**
 * Fold the model's augmented values into the spec — ONLY for `fieldsToFill`, so a
 * field the user typed and left un-flagged (never in the plan) is untouched. A
 * non-string / blank value is ignored (keeps whatever was there). The `model`
 * field is extra-guarded: an augmented model is accepted only if it exists in the
 * chosen provider's catalog, so the AI can never inject a bogus model id. Pure —
 * returns a fresh spec, never mutates the input.
 */
export function mergeAugmented(
  spec: AgentFormSpec,
  augmented: unknown,
  fieldsToFill: readonly AugmentField[],
): AgentFormSpec {
  const out: AgentFormSpec = { ...spec };
  const a = (augmented && typeof augmented === 'object' ? augmented : {}) as Record<string, unknown>;
  for (const f of fieldsToFill) {
    const v = a[f];
    if (typeof v !== 'string' || !v.trim()) continue;
    const val = v.trim();
    if (f === 'model') {
      if (isProviderId(spec.provider) && findModel(spec.provider, val)) out.model = val;
      continue;
    }
    out[f] = val;
  }
  return out;
}

/**
 * Validate a completed form spec before creating the agent. Mirrors the roster's
 * validateAgentSpec (provider/model/budget) but returns ALL errors at once (for the
 * form to surface) rather than the first. Pure; renderer-safe.
 */
export function validateFormSpec(spec: AgentFormSpec): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!spec.name?.trim()) errors.push('Nome é obrigatório.');
  if (!isProviderId(spec.provider)) {
    errors.push(`Provider inválido "${spec.provider}" — um de: ${PROVIDER_IDS.join(', ')}.`);
  } else {
    const model = spec.model?.trim() ?? '';
    if (!model || !findModel(spec.provider, model)) {
      errors.push(`Modelo "${spec.model}" não está no catálogo de ${spec.provider}.`);
    }
  }
  if (!DELEGATION_ROLE_VALUES.includes(spec.delegationRole)) {
    errors.push('Delegation role inválido (leaf | orchestrator).');
  }
  if (spec.dailyTokenBudget != null) {
    if (typeof spec.dailyTokenBudget !== 'number' || !Number.isFinite(spec.dailyTokenBudget) || spec.dailyTokenBudget <= 0) {
      errors.push('Budget diário deve ser um número positivo.');
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Combine the type label + the detailed system prompt into the single persisted
 * roster `role` string (which seeds role.md and the agent's "# Your role" context).
 * Both present → labelled block; otherwise whichever is set. Pure.
 */
export function mergeRole(spec: AgentFormSpec): string {
  const type = spec.role?.trim() ?? '';
  const prompt = spec.systemPrompt?.trim() ?? '';
  if (type && prompt) return `${type}\n\n${prompt}`;
  return prompt || type;
}

/**
 * Map the form spec → the roster's AgentSpecInput (for validateAgentSpec +
 * createAgent) plus the raw knowledgeSeed (written as the agent's first note).
 * grant is left to the roster default (read+notify). Pure.
 */
export function formSpecToCreate(spec: AgentFormSpec): { input: AgentSpecInput; knowledgeSeed: string } {
  return {
    input: {
      name: spec.name.trim(),
      role: mergeRole(spec),
      provider: spec.provider,
      model: spec.model.trim(),
      delegationRole: spec.delegationRole,
      dailyTokenBudget: spec.dailyTokenBudget,
      parentId: spec.parentId,
      canMessageUser: spec.canMessageUser,
    },
    knowledgeSeed: spec.knowledgeSeed?.trim() ?? '',
  };
}
