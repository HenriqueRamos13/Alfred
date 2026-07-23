/**
 * Team roster — PURE logic (strip-types-safe: no node/electron/native imports).
 *
 * The roster is an OPEN, user-defined list of specialist agents that EXTENDS the
 * three fixed agents (main/reference/curator in modelCatalog.ts) — it never
 * touches them. Each agent has its own model and a private knowledge folder
 * (scaffolded by core/team.ts). This module holds only the total functions the
 * renderer + tests can import directly; the IO/db side lives in core/team.ts.
 */

import { slugify } from './projects.ts';
import { isProviderId, findModel, PROVIDER_IDS, type ProviderId } from './modelCatalog.ts';

export interface TeamAgent {
  id: string;
  name: string;
  /** Specialty / system-prompt role. May be empty. */
  role: string;
  provider: ProviderId;
  model: string;
  createdTs: number;
}

/** Untrusted create input as it arrives from the tool. */
export interface AgentSpecInput {
  name?: string;
  role?: string;
  provider?: string;
  model?: string;
}

/** Validated create spec (id is assigned by createAgent, not here). */
export interface AgentSpec {
  name: string;
  role: string;
  provider: ProviderId;
  model: string;
}

/**
 * Slug id from a display name, made unique against `existing` ids by suffixing
 * `-2`, `-3`, … (slugify is idempotent, so a passed-in slug slugifies to itself).
 * A name that slugifies to nothing falls back to `agent`.
 */
export function agentIdFromName(name: string, existing: readonly string[] = []): string {
  const base = slugify(name) || 'agent';
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Validate an untrusted create spec against the model catalog: name required,
 * provider must be a known provider id, model must exist in that provider's
 * catalog. Role is optional (defaults to ''). Reuses modelCatalog's catalog
 * (findModel/isProviderId) — that IS the catalog.
 */
export function validateAgentSpec(spec: AgentSpecInput): { ok: true; spec: AgentSpec } | { ok: false; error: string } {
  const name = (spec.name ?? '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  if (!isProviderId(spec.provider)) {
    return { ok: false, error: `unknown provider "${spec.provider}" — one of: ${PROVIDER_IDS.join(', ')}` };
  }
  const model = (spec.model ?? '').trim();
  if (!model || !findModel(spec.provider, model)) {
    return { ok: false, error: `model "${spec.model}" is not in the ${spec.provider} catalog` };
  }
  return { ok: true, spec: { name, role: (spec.role ?? '').trim(), provider: spec.provider, model } };
}

/** Shared "who-knows-what" index (agents/index.md): one line per agent, name → specialty. */
export function buildAgentsIndex(agents: readonly Pick<TeamAgent, 'id' | 'name' | 'role' | 'model'>[]): string {
  const lines = [
    '# Team — who knows what',
    '',
    '_Shared roster index. Each agent reads ONLY its own `agents/<id>/knowledge/` folder; this MOC lets Alfred route a task to the right specialist._',
    '',
  ];
  if (agents.length === 0) lines.push('_No agents yet._', '');
  for (const a of [...agents].sort((x, y) => x.id.localeCompare(y.id))) {
    lines.push(`- **${a.name}** (\`${a.id}\`, ${a.model}) — ${a.role || '_no specialty set_'}`);
  }
  return lines.join('\n') + '\n';
}
