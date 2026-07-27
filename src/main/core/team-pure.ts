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
import { DEFAULT_GRANT, dayKey } from './jobs-pure.ts';
import type { Capability } from './types.ts';

/** Every capability a per-agent grant may list (mirrors jobs-pure's ALL_CAPS). */
const ALL_CAPS: readonly Capability[] = ['read', 'notify', 'write', 'browse', 'shell', 'send', 'delete', 'money', 'secrets'];

/**
 * PRIVILEGE role (Phase 6 stage 2) — distinct from `role` (the free-text
 * specialty above). A **leaf** (default) is hard-restricted: it cannot spawn/
 * delegate, create jobs, manage the roster, write the shared vault, or message
 * the user. An **orchestrator** may spawn children (delegate_to_agent), bounded
 * by maxSpawnDepth / maxConcurrentChildren. See blockedToolsForRole / canSpawn.
 */
export type DelegationRole = 'leaf' | 'orchestrator';
export const DELEGATION_ROLES: readonly DelegationRole[] = ['leaf', 'orchestrator'];
export const DEFAULT_DELEGATION_ROLE: DelegationRole = 'leaf';

export interface TeamAgent {
  id: string;
  /** Display name. The `id` slug is IMMUTABLE — a rename only changes this field. */
  name: string;
  /** Specialty / system-prompt role. May be empty. */
  role: string;
  provider: ProviderId;
  model: string;
  /** Autonomy allowlist for a delegated run (default read+notify). */
  grant: Capability[];
  /** PRIVILEGE role: leaf (default) may not spawn/schedule; orchestrator may spawn (bounded). */
  delegationRole: DelegationRole;
  /** Per-agent daily token cap for autonomous runs. undefined → unlimited (only the global kill-switch applies). */
  dailyTokenBudget?: number;
  /** Manager this agent reports to (Phase 7 stage 2). null/undefined = top of the org. */
  parentId?: string | null;
  /** Inbox power: may this agent message the USER directly? undefined/false → fail-closed (see canMessageUserResolved). */
  canMessageUser?: boolean;
  createdTs: number;
  /** Last edit (updateAgent). undefined = never edited since it was created. */
  updatedTs?: number;
}

/** Untrusted create input as it arrives from the tool. */
export interface AgentSpecInput {
  name?: string;
  role?: string;
  provider?: string;
  model?: string;
  grant?: unknown;
  delegationRole?: unknown;
  dailyTokenBudget?: unknown;
  parentId?: unknown;
  canMessageUser?: unknown;
}

/** Validated create spec (id is assigned by createAgent, not here). */
export interface AgentSpec {
  name: string;
  role: string;
  provider: ProviderId;
  model: string;
  grant: Capability[];
  delegationRole: DelegationRole;
  dailyTokenBudget?: number;
  /** Manager to report to, or null for top-level (Phase 7 stage 2). */
  parentId: string | null;
  /** Inbox power (fail-closed default false). */
  canMessageUser: boolean;
}

/**
 * Tolerant read of a stored `grant_json` column: absent / empty / malformed /
 * wrong-shaped → the DEFAULT_GRANT (read+notify), so rows written before the
 * column existed (or a corrupt blob) never break loading. A valid array keeps
 * only its known capabilities; if that filters to nothing, the default stands.
 */
export function parseGrant(json: string | null | undefined): Capability[] {
  if (!json) return [...DEFAULT_GRANT];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [...DEFAULT_GRANT];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_GRANT];
  const caps = parsed.filter((c): c is Capability => ALL_CAPS.includes(c as Capability));
  return caps.length ? caps : [...DEFAULT_GRANT];
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

// ── shared field checks (ONE definition for create AND edit) ─────────────────

/** A normalised field value, or the explicit refusal reason (never a silent drop). */
type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** provider must be a known id AND model must live in THAT provider's catalog. */
function checkProviderModel(provider: unknown, model: unknown): FieldResult<{ provider: ProviderId; model: string }> {
  if (!isProviderId(provider)) {
    return { ok: false, error: `unknown provider "${provider}" — one of: ${PROVIDER_IDS.join(', ')}` };
  }
  const id = typeof model === 'string' ? model.trim() : '';
  if (!id || !findModel(provider, id)) return { ok: false, error: `model "${model}" is not in the ${provider} catalog` };
  return { ok: true, value: { provider, model: id } };
}

/** An explicit grant must be an array of KNOWN capabilities (absent is the caller's default). */
function checkGrant(value: unknown): FieldResult<Capability[]> {
  if (!Array.isArray(value) || value.some((c) => !ALL_CAPS.includes(c as Capability))) {
    return { ok: false, error: `grant must be an array of capabilities (${ALL_CAPS.join(', ')})` };
  }
  return { ok: true, value: value as Capability[] };
}

/** An explicit PRIVILEGE role must be one of the known roles. */
function checkDelegationRole(value: unknown): FieldResult<DelegationRole> {
  if (!DELEGATION_ROLES.includes(value as DelegationRole)) {
    return { ok: false, error: `delegationRole must be one of: ${DELEGATION_ROLES.join(', ')}` };
  }
  return { ok: true, value: value as DelegationRole };
}

/** An explicit per-agent daily cap must be a positive, finite number of tokens. */
function checkBudget(value: unknown): FieldResult<number> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'dailyTokenBudget must be a positive number' };
  }
  return { ok: true, value };
}

/** An explicit inbox-power flag must be a boolean (absent is the caller's default). */
function checkCanMessageUser(value: unknown): FieldResult<boolean> {
  if (typeof value !== 'boolean') return { ok: false, error: 'canMessageUser must be a boolean' };
  return { ok: true, value };
}

/**
 * Validate an untrusted create spec against the model catalog: name required,
 * provider must be a known provider id, model must exist in that provider's
 * catalog. Role is optional (defaults to ''). Reuses modelCatalog's catalog
 * (findModel/isProviderId) — that IS the catalog. The per-field checks are shared
 * with validateAgentPatch (edit), so the two paths can never drift.
 */
export function validateAgentSpec(spec: AgentSpecInput): { ok: true; spec: AgentSpec } | { ok: false; error: string } {
  const name = (spec.name ?? '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  const pm = checkProviderModel(spec.provider, spec.model);
  if (!pm.ok) return { ok: false, error: pm.error };
  // grant is optional; absent → the read+notify default.
  let grant: Capability[] = [...DEFAULT_GRANT];
  if (spec.grant !== undefined) {
    const g = checkGrant(spec.grant);
    if (!g.ok) return { ok: false, error: g.error };
    grant = g.value;
  }
  // Optional per-agent daily token cap. Absent → undefined (unlimited beyond the global kill-switch).
  let dailyTokenBudget: number | undefined;
  if (spec.dailyTokenBudget !== undefined) {
    const b = checkBudget(spec.dailyTokenBudget);
    if (!b.ok) return { ok: false, error: b.error };
    dailyTokenBudget = b.value;
  }
  // Optional PRIVILEGE role. Absent → leaf (default-deny).
  let delegationRole: DelegationRole = DEFAULT_DELEGATION_ROLE;
  if (spec.delegationRole !== undefined) {
    const r = checkDelegationRole(spec.delegationRole);
    if (!r.ok) return { ok: false, error: r.error };
    delegationRole = r.value;
  }
  // Optional manager link. Absent / null → top-level (null). An explicit value must be a non-empty id string.
  let parentId: string | null = null;
  if (spec.parentId !== undefined && spec.parentId !== null) {
    if (typeof spec.parentId !== 'string' || !spec.parentId.trim()) {
      return { ok: false, error: 'parentId must be a non-empty agent id or null' };
    }
    parentId = spec.parentId.trim();
  }
  // Optional inbox power. Absent → false (fail-closed).
  let canMessageUser = false;
  if (spec.canMessageUser !== undefined) {
    const c = checkCanMessageUser(spec.canMessageUser);
    if (!c.ok) return { ok: false, error: c.error };
    canMessageUser = c.value;
  }
  return {
    ok: true,
    spec: { name, role: (spec.role ?? '').trim(), provider: pm.value.provider, model: pm.value.model, grant, delegationRole, dailyTokenBudget, parentId, canMessageUser },
  };
}

// ── edit an existing agent (Phase 8 stage 3) ─────────────────────────────────

/**
 * Untrusted PARTIAL edit input (the `team` tool's update op / the UI form). Every
 * field is optional and `undefined` means UNCHANGED — there is deliberately no
 * `id` field: the slug id is IMMUTABLE (it is the folder name, the `agent:<id>`
 * budget key and every parent reference), so a rename changes `name` only.
 */
export interface AgentUpdateInput {
  name?: unknown;
  /** Free text (the merged label + system prompt). May be cleared to ''. */
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  grant?: unknown;
  delegationRole?: unknown;
  /** null or 0 → CLEAR the cap (unlimited); a positive whole number → set it. */
  dailyTokenBudget?: unknown;
  /** null → top of the org; an agent id → that manager (cycle + depth checked). */
  parentId?: unknown;
  canMessageUser?: unknown;
}

/**
 * The validated patch: ONLY the fields the caller actually asked to change, so the
 * IO layer can build a dynamic UPDATE that never rewrites an untouched column.
 */
export interface AgentPatch {
  name?: string;
  role?: string;
  provider?: ProviderId;
  model?: string;
  grant?: Capability[];
  delegationRole?: DelegationRole;
  /** A number sets the cap; explicit null CLEARS it (SQL NULL = unlimited). */
  dailyTokenBudget?: number | null;
  /** An id sets the manager; explicit null moves the agent to the top. */
  parentId?: string | null;
  canMessageUser?: boolean;
}

/**
 * Validate a partial edit of an EXISTING agent against the current roster. Same
 * field checks as create (shared helpers above) plus the edit-only rules:
 * - `id` must exist and is immutable (see AgentUpdateInput);
 * - the EFFECTIVE (provider, model) pair — patched value ?? the stored one — must
 *   exist in the catalog, so switching provider alone can never leave a bogus combo;
 * - `dailyTokenBudget`: absent = unchanged, null/0 = clear, else a positive whole number;
 * - `parentId`: absent = unchanged, null = top, otherwise a known agent that is not
 *   the agent itself, does not close a cycle (`wouldCycle`) and keeps the chain within
 *   DEFAULT_MAX_SPAWN_DEPTH — the same semantics (and the same subtree caveat) as
 *   setAgentManager: the depth check bounds the edited agent's OWN chain, not its subtree;
 * - `canMessageUser`: absent = unchanged (an explicit `false` is a real revoke).
 * Pure — the caller does the write.
 */
export function validateAgentPatch(
  agents: readonly TeamAgent[],
  id: string,
  input: AgentUpdateInput,
): { ok: true; patch: AgentPatch } | { ok: false; error: string } {
  const current = agents.find((a) => a.id === id);
  if (!current) return { ok: false, error: `no agent with id "${id}"` };
  const patch: AgentPatch = {};

  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) return { ok: false, error: 'name is required' };
    patch.name = name;
  }
  if (input.role !== undefined) {
    if (typeof input.role !== 'string') return { ok: false, error: 'role must be a string' };
    patch.role = input.role.trim();
  }
  if (input.provider !== undefined || input.model !== undefined) {
    const pm = checkProviderModel(input.provider ?? current.provider, input.model ?? current.model);
    if (!pm.ok) return { ok: false, error: pm.error };
    if (input.provider !== undefined) patch.provider = pm.value.provider;
    if (input.model !== undefined) patch.model = pm.value.model;
  }
  if (input.grant !== undefined) {
    const g = checkGrant(input.grant);
    if (!g.ok) return { ok: false, error: g.error };
    patch.grant = g.value;
  }
  if (input.delegationRole !== undefined) {
    const r = checkDelegationRole(input.delegationRole);
    if (!r.ok) return { ok: false, error: r.error };
    patch.delegationRole = r.value;
  }
  if (input.dailyTokenBudget !== undefined) {
    if (input.dailyTokenBudget === null || input.dailyTokenBudget === 0) {
      patch.dailyTokenBudget = null; // 0 and null both mean "remove the cap"
    } else {
      const b = checkBudget(input.dailyTokenBudget);
      if (!b.ok) return { ok: false, error: b.error };
      if (!Number.isInteger(b.value)) {
        return { ok: false, error: 'dailyTokenBudget must be a whole number of tokens (0 or null removes the cap)' };
      }
      patch.dailyTokenBudget = b.value;
    }
  }
  if (input.parentId !== undefined) {
    if (input.parentId === null) {
      patch.parentId = null; // → top of the org
    } else {
      if (typeof input.parentId !== 'string' || !input.parentId.trim()) {
        return { ok: false, error: 'parentId must be a non-empty agent id or null' };
      }
      const parentId = input.parentId.trim();
      if (!agents.some((a) => a.id === parentId)) return { ok: false, error: `no manager with id "${parentId}"` };
      if (wouldCycle(agents, id, parentId)) return { ok: false, error: 'refused: would create a management cycle' };
      if (orgDepth(agents, parentId) + 1 > DEFAULT_MAX_SPAWN_DEPTH) {
        return { ok: false, error: `refused: hierarchy too deep (max depth ${DEFAULT_MAX_SPAWN_DEPTH})` };
      }
      patch.parentId = parentId;
    }
  }
  if (input.canMessageUser !== undefined) {
    const c = checkCanMessageUser(input.canMessageUser);
    if (!c.ok) return { ok: false, error: c.error };
    patch.canMessageUser = c.value;
  }
  return { ok: true, patch };
}

/**
 * The seed `knowledge/role.md` note of an agent: a stable `# <name> — role` header
 * (the marker updateAgent's rewrite guard matches, so a hand-written note that
 * happens to be called role.md is never clobbered) + the specialty body. Written
 * at create and rewritten on a name/role edit, hence deterministic: nothing dated,
 * and no model/provider line that an edit could leave stale (the agent is told its
 * model by buildAgentContext anyway). Pure.
 */
export function composeRoleNote(name: string, role: string): string {
  const who = name.trim() || 'agent';
  return [
    `# ${who} — role`,
    '',
    `_Private knowledge for this specialist; only ${who} reads this folder._`,
    '',
    role.trim() || '_No specialty set yet._',
    '',
  ].join('\n');
}

// ── privilege role → tool blocklist + capability floor (Phase 6 stage 2) ─────

/**
 * Tool names a delegated agent of this role may NEVER use — removed from the
 * model-visible toolset BEFORE the turn (in addition to the per-call grant
 * check). The effective toolset of an agent = grant ∩ (tools not blocked here).
 *
 * LEAF (default): no spawning (delegate_to_agent / delegate_to_claude_code /
 * agent_study), no scheduling / roster management (schedule / team), and no
 * shared-vault access (memory — a leaf's read needs are already served by its
 * pre-assembled context, so removing the whole tool is the clean way to forbid
 * shared-vault WRITES). ORCHESTRATOR: same, MINUS delegate_to_agent — it may
 * spawn a child, bounded by canSpawn (depth + concurrency).
 */
export function blockedToolsForRole(role: DelegationRole): string[] {
  const base = ['delegate_to_claude_code', 'agent_study', 'team', 'schedule', 'memory'];
  return role === 'orchestrator' ? base : ['delegate_to_agent', ...base];
}

/** Capabilities a leaf may never exercise, even if its grant lists them: messaging the user. */
const LEAF_BLOCKED_CAPS: readonly Capability[] = ['notify', 'send'];

/**
 * Role-floored effective grant: an orchestrator keeps its full grant; a leaf has
 * `notify` + `send` stripped (it reports back to its parent, never messages the
 * user directly). This is enforced on top of the grant at every tool call, so a
 * mis-configured leaf grant can't reach the notify/send path. Returns a fresh
 * array (never the input reference). Pure.
 */
export function restrictGrantForRole(role: DelegationRole, grant: readonly Capability[]): Capability[] {
  if (role === 'orchestrator') return [...grant];
  return grant.filter((c) => !LEAF_BLOCKED_CAPS.includes(c));
}

// ── spawn bounds + kill-switch (Phase 6 stage 2) ─────────────────────────────

/** Default max delegation depth: at most 2 levels of nested delegated agents. */
export const DEFAULT_MAX_SPAWN_DEPTH = 2;
/** Default max concurrent children a single parent may have in flight. */
export const DEFAULT_MAX_CONCURRENT_CHILDREN = 3;
/** Sane ceilings for the persisted spawn-limit settings (a trust-boundary guard). */
export const MAX_CONCURRENT_CHILDREN_CEIL = 16;
export const MAX_SPAWN_DEPTH_CEIL = 8;

/**
 * Parse a persisted spawn-limit setting (max children / max depth) into a clamped
 * integer. Absent / blank / non-numeric → `def`; otherwise floored and clamped to
 * [min, max]. Pure — the trust-boundary clamp behind getSpawnLimits/setSpawnLimits.
 */
export function parseSpawnLimit(raw: string | undefined | null, def: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export interface SpawnLimits {
  maxSpawnDepth: number;
  maxConcurrentChildren: number;
}

export type SpawnDecision = { ok: true } | { ok: false; reason: string };

/**
 * Whether a runner at `depth` (0 = top-level Alfred; a delegated child runs at
 * depth ≥ 1) with `activeChildren` already in flight may spawn one more child.
 * The kill-switch (`paused`) refuses ANY new spawn first (running children are
 * untouched — they finish). Then the depth ceiling, then the concurrency
 * ceiling — each with an explicit reason, never a silent drop. Pure.
 */
export function canSpawn(depth: number, activeChildren: number, limits: SpawnLimits, paused = false): SpawnDecision {
  if (paused) {
    return { ok: false, reason: 'criação de subagentes em pausa (kill-switch "PAUSE SPAWN" ativo) — filhos a correr continuam' };
  }
  if (depth >= limits.maxSpawnDepth) {
    return { ok: false, reason: `limite de profundidade de delegação atingido (max ${limits.maxSpawnDepth})` };
  }
  if (activeChildren >= limits.maxConcurrentChildren) {
    return { ok: false, reason: `limite de filhos concorrentes atingido (max ${limits.maxConcurrentChildren})` };
  }
  return { ok: true };
}

// ── org hierarchy (Phase 7, stage 2) ─────────────────────────────────────────

/** Minimal shape the hierarchy helpers need — a flat roster of id → parent. */
type OrgLink = { id: string; parentId?: string | null };

/**
 * Depth of `id` in the management chain (a root reports to nobody → 0; a direct
 * report → 1; …). Cycle-safe: a `seen` set bounds the walk to the roster size, so
 * corrupt data can never hang. An unknown id → 0. Pure.
 */
export function orgDepth(agents: readonly OrgLink[], id: string): number {
  const byId = new Map(agents.map((a) => [a.id, a] as const));
  const seen = new Set<string>([id]);
  let depth = 0;
  let cur = byId.get(id)?.parentId ?? null;
  while (cur != null && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    depth++;
    cur = byId.get(cur)!.parentId ?? null;
  }
  return depth;
}

/**
 * Would setting `agentId`'s manager to `newParentId` create a cycle (A→B→A) or a
 * self-parent (A→A)? True = the caller must REFUSE. A null newParentId (→ top)
 * never cycles. Walks UP from the prospective parent using the CURRENT links: if
 * that walk reaches `agentId`, the new edge would close a loop. Cycle-safe against
 * pre-existing corrupt loops above the parent (they don't involve agentId). Pure.
 */
export function wouldCycle(agents: readonly OrgLink[], agentId: string, newParentId: string | null | undefined): boolean {
  if (newParentId == null) return false;
  if (newParentId === agentId) return true;
  const byId = new Map(agents.map((a) => [a.id, a] as const));
  const seen = new Set<string>();
  let cur: string | null | undefined = newParentId;
  while (cur != null && byId.has(cur)) {
    if (cur === agentId) return true;
    if (seen.has(cur)) break; // pre-existing loop above the parent — not caused by this edge
    seen.add(cur);
    cur = byId.get(cur)!.parentId ?? null;
  }
  return false;
}

// ── per-agent daily budget (Phase 5, stage 4) ────────────────────────────────

/** Today's per-agent token usage as stored (day-keyed counter). */
export interface AgentUsage {
  tokens: number;
  /** YYYY-MM-DD the `tokens` counter belongs to (for the daily reset). */
  day: string;
}

export interface AgentBudgetDecision {
  /** May the agent spend `addTokens` more today? */
  allowed: boolean;
  /** Spend counter AFTER any daily reset, BEFORE adding the estimate. */
  spentToday: number;
  /** Today's day key. */
  day: string;
  /** 'budget' when the estimate would blow the cap (pause, don't kill). */
  pausedReason: 'budget' | null;
  /** True when a new day rolled the counter back to 0. */
  reset: boolean;
}

/**
 * Per-agent daily budget decision — mirrors jobs-pure's budgetDecision but for a
 * roster agent (the counter lives externally, day-keyed, so it is passed in as
 * `usage`). Applies the daily reset first; an agent with NO cap is always allowed
 * (the global kill-switch in budget.ts still applies on top). On exhaustion the
 * caller blocks the attended run / pauses the scheduled study. Pure.
 */
export function agentBudgetDecision(
  agent: { dailyTokenBudget?: number },
  now: number,
  addTokens: number,
  usage: AgentUsage,
): AgentBudgetDecision {
  const day = dayKey(now);
  const reset = usage.day !== day;
  const spentToday = reset ? 0 : usage.tokens ?? 0;
  const cap = agent.dailyTokenBudget;
  if (cap == null) return { allowed: true, spentToday, day, pausedReason: null, reset };
  const allowed = spentToday + addTokens <= cap;
  return { allowed, spentToday, day, pausedReason: allowed ? null : 'budget', reset };
}

/**
 * Resolve the model a delegated run should use: an explicit `input` override
 * wins only when it exists in THAT agent's provider catalog; anything absent /
 * unknown / from another provider falls back to the agent's own model. Pure so
 * the delegate_to_agent model plumbing is unit-testable.
 */
export function resolveTeamModel(input: string | undefined, agent: { provider: ProviderId; model: string }): string {
  return input && findModel(agent.provider, input) ? input : agent.model;
}

/** A private-knowledge note as loaded from the agent's own folder. */
export interface AgentNote {
  /** Note title (the filename without `.md`). */
  title: string;
  /** Full note body as read from disk. */
  body: string;
}

/** Clip to the HEAD of `text`, marking the cut so the model knows it was truncated. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}

/**
 * Build the system context for a delegated agent turn (MOC pattern, bounded):
 * the agent's role + the SHARED who-knows-what index (so it knows what the team
 * knows) + its OWN private notes, each excerpt- and section-capped so a big
 * knowledge folder can't blow the context. Pure — the caller (core/team.ts)
 * reads ONLY the agent's own folder and feeds the notes here, which is what
 * keeps one agent from ever seeing another's private notes.
 */
export interface ProjectContextInfo {
  name: string;
  slug: string;
  stack?: string;
  status?: string;
  summary?: string;
  ownerAgentId?: string;
}

/**
 * An agent's project memberships (the "big picture" it always carries, distinct
 * from the single anchored `# Current project`): projects it OWNS + projects with
 * open cards assigned to it. Computed by projectsForAgent (core/projects.ts).
 */
export interface AgentMemberships {
  owned: { slug: string; name: string }[];
  assigned: { slug: string; name: string; openCards: number }[];
}

/**
 * The `# Your projects` section: what this agent owns + where it has open cards, so
 * a turn never answers "no project" when it in fact owns one. Pure/testable format;
 * projectsForAgent supplies the (IO-read) data. Empty owned+assigned → an explicit
 * "not assigned" line rather than silence.
 */
export function membershipsBlock(m: AgentMemberships): string {
  const lines = ['# Your projects'];
  for (const p of m.owned) {
    lines.push(`You OWN: ${p.name} (${p.slug}) — as owner you run it end-to-end and delegate.`);
  }
  if (m.assigned.length) {
    lines.push('Open cards assigned to you:');
    for (const p of m.assigned) {
      lines.push(`- ${p.name} (${p.slug}): ${p.openCards} open card${p.openCards === 1 ? '' : 's'}`);
    }
  } else if (m.owned.length) {
    lines.push('Open cards assigned to you: none right now.');
  } else {
    lines.push('You are not currently assigned to any project.');
  }
  return lines.join('\n');
}

/** The `# Current project: …` header block (Phase 3), when the turn is anchored to one. */
function projectBlock(p: ProjectContextInfo): string {
  const meta = [p.stack && `stack ${p.stack}`, p.status && `status ${p.status}`, p.ownerAgentId && `owner ${p.ownerAgentId}`]
    .filter(Boolean)
    .join(' · ');
  return [
    `# Current project: ${p.name} (slug=${p.slug})`,
    meta,
    p.summary?.trim() ? p.summary.trim() : '',
    'Anchor this project: scope your work to it, and address its board/inbox by this slug.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildAgentContext(
  agent: Pick<TeamAgent, 'name' | 'role' | 'model'>,
  indexText: string,
  notes: readonly AgentNote[],
  opts: { maxNotesChars?: number; perNoteChars?: number; project?: ProjectContextInfo; memberships?: AgentMemberships } = {},
): string {
  const perNoteChars = opts.perNoteChars ?? 600;
  const maxNotesChars = opts.maxNotesChars ?? 4000;
  const parts: string[] = [];
  // The current-project block is the FIRST section when the turn is anchored.
  if (opts.project) parts.push(projectBlock(opts.project));
  parts.push(
    `You are ${agent.name}, a specialist agent on Alfred's team (model ${agent.model}). ` +
      'Complete the delegated task using your role and knowledge below, then report the result concisely.',
    `# Your role\n${agent.role.trim() || '_No specialty set yet._'}`,
  );
  // Overview of what this agent owns / is assigned (co-exists with the anchored
  // current-project block above: memberships = the big picture, project = this turn).
  if (opts.memberships) parts.push(membershipsBlock(opts.memberships));
  if (indexText.trim()) {
    parts.push(`# Team index — who knows what (shared, read-only)\n${indexText.trim()}`);
  }
  if (notes.length) {
    let budget = maxNotesChars;
    const blocks: string[] = [];
    for (const n of notes) {
      if (budget <= 0) {
        blocks.push('…(more notes omitted — ask Alfred if you need them)');
        break;
      }
      const excerpt = clip(n.body.trim(), Math.min(perNoteChars, budget));
      budget -= excerpt.length;
      blocks.push(`## ${n.title}\n${excerpt}`);
    }
    parts.push(`# Your private knowledge (only you read this)\n${blocks.join('\n\n')}`);
  }
  return parts.join('\n\n');
}

// ── on-demand learning (Phase 5, stage 3): study-note plan + index topic ─────

/** Slug for a study note file from a topic (idempotent; empty/symbol-only → 'study'). */
export function studyNoteSlug(topic: string): string {
  return slugify(topic) || 'study';
}

/**
 * Compose the knowledge note a completed study run persists. A fresh topic → a
 * new note (title header + dated findings). Re-studying the SAME topic (same
 * slug) → the prior note with a new dated section APPENDED (knowledge accrues
 * per topic; nothing is overwritten). Pure so the write plan is unit-testable —
 * the trusted runner (not the agent) does the IO in core/team.ts.
 */
export function composeStudyNote(existing: string | null, topic: string, findings: string, day: string): string {
  const body = findings.trim();
  if (!existing || !existing.trim()) {
    return `# ${topic.trim()}\n\n_Studied ${day}. Synthesised by the agent from web research._\n\n${body}\n`;
  }
  return `${existing.trimEnd()}\n\n## Update ${day}\n\n${body}\n`;
}

/**
 * Append a studied `topic` to an agent's line in the shared who-knows-what index
 * text (a `· studied: a, b` suffix) so Alfred can route by learned topic. Pure
 * string transform: edits ONLY the single line carrying `` `<agentId>` `` (as
 * written by buildAgentsIndex), dedups the topic case-insensitively, and leaves
 * every other line and the document structure byte-for-byte untouched. An
 * unknown agentId (or blank topic) returns the text unchanged.
 * This is the CHEAP incremental path; a rebuild reconstructs the same suffixes from
 * the knowledge folder (topicsFromKnowledge → buildAgentsIndex), so the two agree
 * byte-for-byte and a create/delete no longer drops what an agent studied.
 */
export function addTopicToIndex(indexText: string, agentId: string, topic: string): string {
  const label = topic.trim().replace(/\s+/g, ' ');
  if (!label) return indexText;
  const marker = `\`${agentId}\``;
  let done = false;
  return indexText
    .split('\n')
    .map((line) => {
      if (done || !line.startsWith('- ') || !line.includes(marker)) return line;
      done = true;
      const m = line.match(/ · studied: (.+)$/);
      if (!m) return `${line} · studied: ${label}`;
      const topics = m[1].split(',').map((t) => t.trim()).filter(Boolean);
      if (topics.some((t) => t.toLowerCase() === label.toLowerCase())) return line; // idempotent
      return `${line.slice(0, m.index)} · studied: ${[...topics, label].join(', ')}`;
    })
    .join('\n');
}

/** One `knowledge/*.md` note as seen from disk: file name (no `.md`) + its first line. */
export interface KnowledgeFileMeta {
  /** Filename without the `.md` extension (a slug — studyNoteSlug wrote it). */
  name: string;
  /** First line of the file, if it could be read. */
  firstLine?: string;
}

/**
 * Studied topics derived from an agent's knowledge FOLDER — the durable record.
 * composeStudyNote writes `# <topic>` as a fresh note's first line and only ever
 * APPENDS `## Update <day>` sections, so that first h1 is a stable topic label.
 * The `role`/`seed` scaffold notes are not studied topics and are skipped; a note
 * with no h1 first line (hand-written, or truncated) falls back to its file name,
 * which is already a slug. Deduped case-insensitively, first-seen order kept.
 * Pure — the IO (readdir + first line) lives in core/team.ts.
 */
export function topicsFromKnowledge(files: readonly KnowledgeFileMeta[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (f.name === 'role' || f.name === 'seed') continue;
    const h1 = (f.firstLine ?? '').trim().match(/^#\s+(.+)$/);
    const topic = (h1 ? h1[1] : f.name).trim().replace(/\s+/g, ' ');
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
  }
  return out;
}

// ── knowledge-note projection (Phase 8, stage 5): the agent-detail note list ──

/** Longest excerpt the note list renders before the ellipsis (~2 lines of card text). */
const EXCERPT_MAX = 280;

/** Display projection of ONE `knowledge/<slug>.md` note: its slug, h1 title and prose excerpt. */
export interface NoteMeta {
  /** File name without `.md` — the id readKnowledgeNote takes back. */
  slug: string;
  /** First `# ` heading of the note, or the slug when it has none. */
  title: string;
  /** Whitespace-collapsed prose after the heading, clipped to EXCERPT_MAX chars. */
  excerpt: string;
}

/** Clip on a word boundary when one is close enough to the cap; hard-cut otherwise. */
function clipExcerpt(text: string): string {
  if (text.length <= EXCERPT_MAX) return text;
  const cut = text.slice(0, EXCERPT_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > EXCERPT_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Project one knowledge note for the agent-detail list WITHOUT shipping the whole
 * file to the renderer (the viewer fetches the body on demand via readKnowledgeNote).
 *
 * The title is the first `# ` heading — composeStudyNote writes it and only ever
 * APPENDS `## Update <day>` sections below, so it is a stable label; a note with no
 * (or a blank) h1 falls back to its slug, exactly like topicsFromKnowledge. The
 * excerpt is the prose AFTER that heading with every markdown heading line dropped
 * (`## Update` markers are structure, not content) and all whitespace collapsed, so
 * a re-studied note previews its findings instead of its section scaffolding. Pure —
 * the readdir/stat/readFile lives in core/team.ts.
 */
export function noteMeta(fileName: string, body: string): NoteMeta {
  const slug = fileName.replace(/\.md$/, '');
  const lines = body.split('\n');
  let title = '';
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s+(.+)$/);
    if (!m) continue;
    title = m[1].trim().replace(/\s+/g, ' ');
    bodyStart = i + 1;
    break;
  }
  const prose = lines
    .slice(bodyStart)
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { slug, title: title || slug, excerpt: clipExcerpt(prose) };
}

/**
 * Shared "who-knows-what" index (agents/index.md): one line per agent, name → specialty.
 * `topicsById` (id → studied topics, e.g. from topicsFromKnowledge) appends the SAME
 * `· studied: a, b` suffix addTopicToIndex writes and parseTopicsFromIndex reads, so a
 * rebuild from DB rows preserves what each agent studied instead of dropping it. Omitted
 * (the default) → no suffixes, exactly the pre-Phase-8 output.
 */
export function buildAgentsIndex(
  agents: readonly Pick<TeamAgent, 'id' | 'name' | 'role' | 'model'>[],
  topicsById: Readonly<Record<string, readonly string[]>> = {},
): string {
  const lines = [
    '# Team — who knows what',
    '',
    '_Shared roster index. Each agent reads ONLY its own `agents/<id>/knowledge/` folder; this MOC lets Alfred route a task to the right specialist._',
    '',
  ];
  if (agents.length === 0) lines.push('_No agents yet._', '');
  for (const a of [...agents].sort((x, y) => x.id.localeCompare(y.id))) {
    // Normalise + ci-dedupe exactly as addTopicToIndex does, so both writers agree.
    const topics: string[] = [];
    const seen = new Set<string>();
    for (const t of topicsById[a.id] ?? []) {
      const label = t.trim().replace(/\s+/g, ' ');
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      topics.push(label);
    }
    const studied = topics.length > 0 ? ` · studied: ${topics.join(', ')}` : '';
    lines.push(`- **${a.name}** (\`${a.id}\`, ${a.model}) — ${a.role || '_no specialty set_'}${studied}`);
  }
  return lines.join('\n') + '\n';
}
