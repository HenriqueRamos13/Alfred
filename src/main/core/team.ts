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
import { agentIdFromName, buildAgentsIndex, buildAgentContext, parseGrant, composeStudyNote, studyNoteSlug, addTopicToIndex, type AgentNote, type AgentSpec, type TeamAgent } from './team-pure.ts';
import { dayKey } from './jobs-pure.ts';

type DB = import('better-sqlite3').Database;

interface Row {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  grant_json: string | null;
  daily_token_budget: number | null;
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
    dailyTokenBudget: r.daily_token_budget ?? undefined,
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
export async function createAgent(db: DB, workspace: string, spec: AgentSpec, now: Date = new Date()): Promise<TeamAgent> {
  const id = agentIdFromName(spec.name, listAgents(db).map((a) => a.id));
  const agent: TeamAgent = { id, ...spec, createdTs: now.getTime() };
  db.prepare(
    'INSERT INTO team_agents (id, name, role, provider, model, grant_json, daily_token_budget, created_ts) VALUES (@id, @name, @role, @provider, @model, @grant, @dailyTokenBudget, @createdTs)',
  ).run({ ...agent, grant: JSON.stringify(agent.grant), dailyTokenBudget: agent.dailyTokenBudget ?? null });

  const knowledgeDir = join(workspace, 'agents', id, 'knowledge');
  await mkdir(knowledgeDir, { recursive: true });
  const seed = `# ${agent.name} — role\n\n_Model: ${agent.model} (${agent.provider}). Private knowledge for this specialist; only ${agent.name} reads this folder._\n\n${agent.role || '_No specialty set yet._'}\n`;
  await writeFile(join(knowledgeDir, 'role.md'), seed, 'utf8');
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
