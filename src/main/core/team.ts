/**
 * Team roster — persistence (team_agents table) + private knowledge scaffold.
 * MAIN-only: takes the Database by PARAMETER (never value-imports the driver),
 * so the pure logic (team-pure.ts) stays testable and this file stays thin.
 *
 * On create: persist the row, scaffold `<workspace>/agents/<id>/knowledge/` with
 * a seed `role.md`, and rebuild the shared `<workspace>/agents/index.md` from the
 * live rows. On delete: drop the row and rebuild the index. The agent's folder is
 * intentionally LEFT on disk (its knowledge may be valuable and recursive removal
 * is riskier than it's worth) — rebuilding the index from the surviving rows means
 * a deleted agent leaves no orphan entry regardless.
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { agentIdFromName, buildAgentsIndex, buildAgentContext, parseGrant, composeStudyNote, studyNoteSlug, addTopicToIndex, wouldCycle, orgDepth, DELEGATION_ROLES, DEFAULT_DELEGATION_ROLE, DEFAULT_MAX_SPAWN_DEPTH, type AgentNote, type AgentSpec, type DelegationRole, type TeamAgent } from './team-pure.ts';
import { dayKey } from './jobs-pure.ts';

type DB = import('better-sqlite3').Database;

interface Row {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  grant_json: string | null;
  delegation_role: string | null;
  daily_token_budget: number | null;
  parent_id: string | null;
  can_message_user: number | null;
  created_ts: number;
}

function rowToAgent(r: Row): TeamAgent {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    provider: r.provider as TeamAgent['provider'],
    model: r.model,
    // Tolerant of rows written before the grant_json column existed.
    grant: parseGrant(r.grant_json),
    // Tolerant of rows written before delegation_role existed → default-deny (leaf).
    delegationRole: DELEGATION_ROLES.includes(r.delegation_role as DelegationRole)
      ? (r.delegation_role as DelegationRole)
      : DEFAULT_DELEGATION_ROLE,
    dailyTokenBudget: r.daily_token_budget ?? undefined,
    // Tolerant of rows written before the Phase 7 columns existed (null → top / fail-closed).
    parentId: r.parent_id ?? null,
    canMessageUser: r.can_message_user === 1,
    createdTs: r.created_ts,
  };
}

export function listAgents(db: DB): TeamAgent[] {
  return (db.prepare('SELECT * FROM team_agents ORDER BY created_ts, id').all() as Row[]).map(rowToAgent);
}

export function getAgent(db: DB, id: string): TeamAgent | undefined {
  const r = db.prepare('SELECT * FROM team_agents WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToAgent(r) : undefined;
}

/** Rewrite agents/index.md from the current rows (idempotent, no orphans). */
async function rebuildIndex(db: DB, workspace: string): Promise<void> {
  const dir = join(workspace, 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.md'), buildAgentsIndex(listAgents(db)), 'utf8');
}

/**
 * Create a roster agent: unique slug id from the (validated) name, persist, then
 * scaffold the private knowledge folder + seed role note and refresh the index.
 */
export async function createAgent(db: DB, workspace: string, spec: AgentSpec, now: Date = new Date(), knowledgeSeed?: string): Promise<TeamAgent> {
  const id = agentIdFromName(spec.name, listAgents(db).map((a) => a.id));
  const agent: TeamAgent = { id, ...spec, createdTs: now.getTime() };
  db.prepare(
    'INSERT INTO team_agents (id, name, role, provider, model, grant_json, delegation_role, daily_token_budget, parent_id, can_message_user, created_ts) VALUES (@id, @name, @role, @provider, @model, @grant, @delegationRole, @dailyTokenBudget, @parentId, @canMessageUser, @createdTs)',
  ).run({
    ...agent,
    grant: JSON.stringify(agent.grant),
    dailyTokenBudget: agent.dailyTokenBudget ?? null,
    parentId: agent.parentId ?? null,
    canMessageUser: agent.canMessageUser ? 1 : 0,
  });

  const knowledgeDir = join(workspace, 'agents', id, 'knowledge');
  await mkdir(knowledgeDir, { recursive: true });
  const seed = `# ${agent.name} — role\n\n_Model: ${agent.model} (${agent.provider}). Private knowledge for this specialist; only ${agent.name} reads this folder._\n\n${agent.role || '_No specialty set yet._'}\n`;
  await writeFile(join(knowledgeDir, 'role.md'), seed, 'utf8');
  // Optional seed knowledge note (from the creation form's "Seed de conhecimento").
  if (knowledgeSeed && knowledgeSeed.trim()) {
    await writeFile(join(knowledgeDir, 'seed.md'), `# Seed knowledge\n\n_Initial notes provided at creation._\n\n${knowledgeSeed.trim()}\n`, 'utf8');
  }
  await rebuildIndex(db, workspace);
  return agent;
}

/** Delete a roster agent's row + refresh the index. Folder is left on disk. Missing id → false. */
export async function deleteAgent(db: DB, workspace: string, id: string): Promise<boolean> {
  const deleted = db.prepare('DELETE FROM team_agents WHERE id = ?').run(id).changes > 0;
  if (deleted) await rebuildIndex(db, workspace);
  return deleted;
}

/**
 * Set (or clear, parentId=null) an agent's manager — the governed reparent path
 * (T2). REFUSES explicitly (never silently) when the agent or the target manager
 * is unknown, when the edge would create a management cycle (`wouldCycle`), or when
 * it would push the agent past the depth cap (reusing DEFAULT_MAX_SPAWN_DEPTH). The
 * cycle/depth logic is pure + tested; this thin fn adds only existence + the write.
 * ponytail: depth check bounds the reparented agent's own chain, not its subtree —
 * a deep subtree could still exceed the cap after a move; tighten (max over subtree)
 * only if the org grows tall enough to matter.
 */
export function setAgentManager(db: DB, agentId: string, parentId: string | null): { ok: true } | { ok: false; error: string } {
  const agents = listAgents(db);
  if (!agents.some((a) => a.id === agentId)) return { ok: false, error: `no agent with id "${agentId}"` };
  if (parentId != null && !agents.some((a) => a.id === parentId)) return { ok: false, error: `no manager with id "${parentId}"` };
  if (wouldCycle(agents, agentId, parentId)) return { ok: false, error: 'refused: would create a management cycle' };
  const depth = parentId == null ? 0 : orgDepth(agents, parentId) + 1;
  if (depth > DEFAULT_MAX_SPAWN_DEPTH) {
    return { ok: false, error: `refused: hierarchy too deep (max depth ${DEFAULT_MAX_SPAWN_DEPTH})` };
  }
  db.prepare('UPDATE team_agents SET parent_id = ? WHERE id = ?').run(parentId, agentId);
  return { ok: true };
}

/**
 * Assemble a delegated agent's system context: the shared who-knows-what index +
 * the agent's OWN private notes (read from ONLY its `agents/<id>/knowledge/`
 * folder — the isolation boundary) fed to the pure buildAgentContext. Missing
 * files degrade to empty, never throw.
 */
export async function loadAgentContext(workspace: string, agent: TeamAgent): Promise<string> {
  const indexText = await readFile(join(workspace, 'agents', 'index.md'), 'utf8').catch(() => '');
  const dir = join(workspace, 'agents', agent.id, 'knowledge');
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    /* no folder yet — no private notes */
  }
  const notes: AgentNote[] = [];
  for (const f of files) {
    const body = await readFile(join(dir, f), 'utf8').catch(() => '');
    if (body.trim()) notes.push({ title: f.replace(/\.md$/, ''), body });
  }
  return buildAgentContext(agent, indexText, notes);
}

/**
 * Persist a study run's synthesised findings as a knowledge note — CONFINED to
 * the agent's OWN folder: `agents/<agentId>/knowledge/<slug>.md`, where the slug
 * comes from slugify so it can never escape that folder (no `/`, `.`, `..`).
 * Re-studying a topic APPENDS a dated section instead of overwriting. Done by the
 * trusted runner, never by the agent (the agent gets no arbitrary file-write tool).
 */
export async function saveStudyNote(
  workspace: string,
  agentId: string,
  topic: string,
  findings: string,
  now: Date = new Date(),
): Promise<{ slug: string; file: string; mode: 'create' | 'append'; relativePath: string }> {
  // Defence-in-depth: agentId goes straight into the write path. Callers pass a
  // DB-row id (a slug from agentIdFromName), but assert the confined charset here
  // so a mis-wired caller (e.g. a future scheduled-study path) can never traverse.
  if (!/^[a-z0-9-]+$/.test(agentId)) throw new Error(`invalid agentId "${agentId}" (must be a slug)`);
  const slug = studyNoteSlug(topic);
  const dir = join(workspace, 'agents', agentId, 'knowledge');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${slug}.md`);
  const existing = await readFile(file, 'utf8').catch(() => null);
  await writeFile(file, composeStudyNote(existing, topic, findings, dayKey(now.getTime())), 'utf8');
  return { slug, file, mode: existing ? 'append' : 'create', relativePath: `agents/${agentId}/knowledge/${slug}.md` };
}

/**
 * Add a studied topic to the agent's line in the shared index (agents/index.md)
 * so Alfred can route by learned topic. Missing/empty index or unknown agent →
 * a no-op (never throws). Local edit only — not egress.
 */
export async function addStudyTopicToIndex(workspace: string, agentId: string, topic: string): Promise<void> {
  const file = join(workspace, 'agents', 'index.md');
  const cur = await readFile(file, 'utf8').catch(() => '');
  const next = addTopicToIndex(cur, agentId, topic);
  if (next !== cur) await writeFile(file, next, 'utf8');
}
