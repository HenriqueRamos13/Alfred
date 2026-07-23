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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentIdFromName, buildAgentsIndex, type AgentSpec, type TeamAgent } from './team-pure.ts';

type DB = import('better-sqlite3').Database;

interface Row {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  created_ts: number;
}

function rowToAgent(r: Row): TeamAgent {
  return { id: r.id, name: r.name, role: r.role, provider: r.provider as TeamAgent['provider'], model: r.model, createdTs: r.created_ts };
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
    'INSERT INTO team_agents (id, name, role, provider, model, created_ts) VALUES (@id, @name, @role, @provider, @model, @createdTs)',
  ).run(agent);

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
