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
import { DEFAULT_GRANT } from './jobs-pure.ts';
import type { Capability } from './types.ts';

/** Every capability a per-agent grant may list (mirrors jobs-pure's ALL_CAPS). */
const ALL_CAPS: readonly Capability[] = ['read', 'notify', 'write', 'browse', 'shell', 'send', 'delete', 'money', 'secrets'];

export interface TeamAgent {
  id: string;
  name: string;
  /** Specialty / system-prompt role. May be empty. */
  role: string;
  provider: ProviderId;
  model: string;
  /** Autonomy allowlist for a delegated run (default read+notify). */
  grant: Capability[];
  createdTs: number;
}

/** Untrusted create input as it arrives from the tool. */
export interface AgentSpecInput {
  name?: string;
  role?: string;
  provider?: string;
  model?: string;
  grant?: unknown;
}

/** Validated create spec (id is assigned by createAgent, not here). */
export interface AgentSpec {
  name: string;
  role: string;
  provider: ProviderId;
  model: string;
  grant: Capability[];
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
  return { ok: true, spec: { name, role: (spec.role ?? '').trim(), provider: spec.provider, model, grant } };
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
