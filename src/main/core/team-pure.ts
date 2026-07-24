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
  // grant is optional; absent → the read+notify default. An explicit value must
  // be an array of known capabilities.
  let grant: Capability[];
  if (spec.grant === undefined) {
    grant = [...DEFAULT_GRANT];
  } else if (!Array.isArray(spec.grant) || spec.grant.some((c) => !ALL_CAPS.includes(c as Capability))) {
    return { ok: false, error: `grant must be an array of capabilities (${ALL_CAPS.join(', ')})` };
  } else {
    grant = spec.grant as Capability[];
  }
  // Optional per-agent daily token cap. Absent → undefined (unlimited beyond the global kill-switch).
  let dailyTokenBudget: number | undefined;
  if (spec.dailyTokenBudget !== undefined) {
    if (typeof spec.dailyTokenBudget !== 'number' || !Number.isFinite(spec.dailyTokenBudget) || spec.dailyTokenBudget <= 0) {
      return { ok: false, error: 'dailyTokenBudget must be a positive number' };
    }
    dailyTokenBudget = spec.dailyTokenBudget;
  }
  // Optional PRIVILEGE role. Absent → leaf (default-deny). An explicit value must be a known role.
  let delegationRole: DelegationRole = DEFAULT_DELEGATION_ROLE;
  if (spec.delegationRole !== undefined) {
    if (!DELEGATION_ROLES.includes(spec.delegationRole as DelegationRole)) {
      return { ok: false, error: `delegationRole must be one of: ${DELEGATION_ROLES.join(', ')}` };
    }
    delegationRole = spec.delegationRole as DelegationRole;
  }
  // Optional manager link. Absent / null → top-level (null). An explicit value must be a non-empty id string.
  let parentId: string | null = null;
  if (spec.parentId !== undefined && spec.parentId !== null) {
    if (typeof spec.parentId !== 'string' || !spec.parentId.trim()) {
      return { ok: false, error: 'parentId must be a non-empty agent id or null' };
    }
    parentId = spec.parentId.trim();
  }
  // Optional inbox power. Absent → false (fail-closed). An explicit value must be a boolean.
  let canMessageUser = false;
  if (spec.canMessageUser !== undefined) {
    if (typeof spec.canMessageUser !== 'boolean') {
      return { ok: false, error: 'canMessageUser must be a boolean' };
    }
    canMessageUser = spec.canMessageUser;
  }
  return {
    ok: true,
    spec: { name, role: (spec.role ?? '').trim(), provider: spec.provider, model, grant, delegationRole, dailyTokenBudget, parentId, canMessageUser },
  };
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
export function buildAgentContext(
  agent: Pick<TeamAgent, 'name' | 'role' | 'model'>,
  indexText: string,
  notes: readonly AgentNote[],
  opts: { maxNotesChars?: number; perNoteChars?: number } = {},
): string {
  const perNoteChars = opts.perNoteChars ?? 600;
  const maxNotesChars = opts.maxNotesChars ?? 4000;
  const parts: string[] = [
    `You are ${agent.name}, a specialist agent on Alfred's team (model ${agent.model}). ` +
      'Complete the delegated task using your role and knowledge below, then report the result concisely.',
    `# Your role\n${agent.role.trim() || '_No specialty set yet._'}`,
  ];
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
 * ponytail: a later create/delete rebuilds index.md from DB rows (buildAgentsIndex)
 * and drops these suffixes — upgrade path is to derive topics from the knowledge
 * folder in buildAgentsIndex. For now the note files on disk are the durable record.
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
