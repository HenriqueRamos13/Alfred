/**
 * Team roster — persistence (team_agents table) + private knowledge scaffold.
 * MAIN-only: takes the Database by PARAMETER (never value-imports the driver),
 * so the pure logic (team-pure.ts) stays testable and this file stays thin.
 *
 * On create: persist the row, scaffold `<workspace>/agents/<id>/knowledge/` with
 * a seed `role.md`, and rebuild the shared `<workspace>/agents/index.md` from the
 * live rows. On update: patch only the given columns (+ `updated_ts`), refresh the
 * seed `role.md` when the name/role moved, rebuild the index. On delete: drop the
 * row and rebuild the index. The agent's folder is
 * intentionally LEFT on disk (its knowledge may be valuable and recursive removal
 * is riskier than it's worth) — rebuilding the index from the surviving rows means
 * a deleted agent leaves no orphan entry regardless.
 */

import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { agentIdFromName, buildAgentsIndex, buildAgentContext, parseGrant, composeStudyNote, composeRoleNote, studyNoteSlug, addTopicToIndex, topicsFromKnowledge, noteMeta, validateAgentPatch, wouldCycle, orgDepth, DELEGATION_ROLES, DEFAULT_DELEGATION_ROLE, DEFAULT_MAX_SPAWN_DEPTH, type AgentNote, type AgentSpec, type AgentUpdateInput, type DelegationRole, type KnowledgeFileMeta, type TeamAgent } from './team-pure.ts';
import { dayKey } from './jobs-pure.ts';
import type { AgentKnowledgeNote } from './types.ts';

type DB = import('better-sqlite3').Database;

/**
 * The ONLY shape an id/slug may have before it becomes a path segment under
 * `<workspace>/agents/…` (agentIdFromName + studyNoteSlug produce exactly this).
 * Every fs entry point below asserts it, so no `..`, `/` or absolute path can
 * traverse out of the agent's own folder — including the IPC-reachable readers.
 */
const AGENT_SLUG = /^[a-z0-9-]+$/;

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
  updated_ts: number | null;
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
    // Tolerant of rows written before updated_ts existed / never edited → undefined.
    updatedTs: r.updated_ts ?? undefined,
  };
}

export function listAgents(db: DB): TeamAgent[] {
  return (db.prepare('SELECT * FROM team_agents ORDER BY created_ts, id').all() as Row[]).map(rowToAgent);
}

export function getAgent(db: DB, id: string): TeamAgent | undefined {
  const r = db.prepare('SELECT * FROM team_agents WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToAgent(r) : undefined;
}

/**
 * Studied topics of one agent, read from its knowledge FOLDER (the durable record —
 * the index is only a projection). Missing folder / unreadable note degrades to no
 * topics, never throws. Same isolation boundary as loadAgentContext: only this
 * agent's own `agents/<id>/knowledge/`.
 */
async function readStudiedTopics(workspace: string, agentId: string): Promise<string[]> {
  const dir = join(workspace, 'agents', agentId, 'knowledge');
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return []; /* no folder yet — nothing studied */
  }
  const files: KnowledgeFileMeta[] = [];
  for (const f of names) {
    const body = await readFile(join(dir, f), 'utf8').catch(() => '');
    files.push({ name: f.replace(/\.md$/, ''), firstLine: body.split('\n', 1)[0] });
  }
  return topicsFromKnowledge(files);
}

/**
 * Rewrite agents/index.md from the current rows (idempotent, no orphans) — with each
 * agent's studied topics re-derived from its knowledge folder, so a create/delete no
 * longer silently drops the `· studied:` suffixes addTopicToIndex appended (and that
 * the TEAM card's topic chips are parsed from).
 */
async function rebuildIndex(db: DB, workspace: string): Promise<void> {
  const dir = join(workspace, 'agents');
  await mkdir(dir, { recursive: true });
  const agents = listAgents(db);
  const topicsById: Record<string, string[]> = {};
  for (const a of agents) topicsById[a.id] = await readStudiedTopics(workspace, a.id);
  await writeFile(join(dir, 'index.md'), buildAgentsIndex(agents, topicsById), 'utf8');
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
  await writeFile(join(knowledgeDir, 'role.md'), composeRoleNote(agent.name, agent.role), 'utf8');
  // Optional seed knowledge note (from the creation form's "Seed de conhecimento").
  if (knowledgeSeed && knowledgeSeed.trim()) {
    await writeFile(join(knowledgeDir, 'seed.md'), `# Seed knowledge\n\n_Initial notes provided at creation._\n\n${knowledgeSeed.trim()}\n`, 'utf8');
  }
  await rebuildIndex(db, workspace);
  return agent;
}

/** The first line composeRoleNote writes — the guard for rewriting an agent's role.md. */
const ROLE_NOTE_HEADER = /^# .+ — role$/;

/**
 * Edit a roster agent (Phase 8 stage 3): validate the PARTIAL patch against the live
 * roster (validateAgentPatch — the id is immutable, the effective provider/model must
 * be in the catalog, a reparent runs the cycle/depth checks, budget 0/null clears),
 * then UPDATE only the columns the caller actually asked for, plus `updated_ts`.
 *
 * Afterwards the on-disk projections are refreshed: the agent's seed `role.md` (only
 * when the name/role changed AND the file still carries the generated header, so a
 * study note that slugged to "role" is never clobbered) and the shared index. The DB
 * write is the source of truth — an fs failure degrades-and-logs and still returns ok
 * (a later rebuildIndex reproduces the files).
 *
 * Edit-while-running: a delegated turn snapshots the row when it starts, so a patch
 * applies to the agent's NEXT run.
 */
export async function updateAgent(
  db: DB,
  workspace: string,
  id: string,
  input: AgentUpdateInput,
): Promise<{ ok: true; agent: TeamAgent } | { ok: false; error: string }> {
  const agents = listAgents(db);
  const v = validateAgentPatch(agents, id, input);
  if (!v.ok) return { ok: false, error: v.error };
  const before = agents.find((a) => a.id === id)!; // validateAgentPatch proved it exists
  const { patch } = v;

  // Dynamic UPDATE: an absent field is never written, so it can never clobber a
  // stored value; SQL NULL is used ONLY where the patch explicitly says null.
  const sets: string[] = [];
  const params: Record<string, string | number | null> = { id, updatedTs: Date.now() };
  const set = (column: string, key: string, value: string | number | null): void => {
    sets.push(`${column} = @${key}`);
    params[key] = value;
  };
  if (patch.name !== undefined) set('name', 'name', patch.name);
  if (patch.role !== undefined) set('role', 'role', patch.role);
  if (patch.provider !== undefined) set('provider', 'provider', patch.provider);
  if (patch.model !== undefined) set('model', 'model', patch.model);
  if (patch.grant !== undefined) set('grant_json', 'grantJson', JSON.stringify(patch.grant));
  if (patch.delegationRole !== undefined) set('delegation_role', 'delegationRole', patch.delegationRole);
  if (patch.dailyTokenBudget !== undefined) set('daily_token_budget', 'dailyTokenBudget', patch.dailyTokenBudget);
  if (patch.parentId !== undefined) set('parent_id', 'parentId', patch.parentId);
  if (patch.canMessageUser !== undefined) set('can_message_user', 'canMessageUser', patch.canMessageUser ? 1 : 0);
  sets.push('updated_ts = @updatedTs');
  db.prepare(`UPDATE team_agents SET ${sets.join(', ')} WHERE id = @id`).run(params);
  const agent = getAgent(db, id)!; // just written, single-process writer

  try {
    if ((patch.name !== undefined && patch.name !== before.name) || (patch.role !== undefined && patch.role !== before.role)) {
      // Defence-in-depth: the id is a DB slug, but it becomes a path segment here.
      if (AGENT_SLUG.test(id)) {
        const file = join(workspace, 'agents', id, 'knowledge', 'role.md');
        const current = await readFile(file, 'utf8').catch(() => null);
        if (current != null && ROLE_NOTE_HEADER.test(current.split('\n', 1)[0].trim())) {
          await writeFile(file, composeRoleNote(agent.name, agent.role), 'utf8');
        }
      }
    }
    await rebuildIndex(db, workspace); // name/role/model all show up in the shared index
  } catch (err) {
    console.error(`[team] agent "${id}" row updated but its files did not:`, err);
  }
  return { ok: true, agent };
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
  if (!AGENT_SLUG.test(agentId)) throw new Error(`invalid agentId "${agentId}" (must be a slug)`);
  const slug = studyNoteSlug(topic);
  const dir = join(workspace, 'agents', agentId, 'knowledge');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${slug}.md`);
  const existing = await readFile(file, 'utf8').catch(() => null);
  await writeFile(file, composeStudyNote(existing, topic, findings, dayKey(now.getTime())), 'utf8');
  return { slug, file, mode: existing ? 'append' : 'create', relativePath: `agents/${agentId}/knowledge/${slug}.md` };
}

/**
 * List an agent's PRIVATE knowledge notes for the agent-detail projection: metadata
 * (workspace-relative path, mtime, size) + the pure noteMeta title/excerpt, newest
 * first. Same isolation boundary as loadAgentContext — only `agents/<id>/knowledge/`.
 *
 * Defence in depth: this is IPC-reachable (the renderer picks the agent id), so the
 * id is asserted to be a slug BEFORE it becomes a path segment; anything else yields
 * []. A missing folder / unreadable note degrades to fewer notes, never throws.
 */
export async function listKnowledgeNotes(workspace: string, agentId: string): Promise<AgentKnowledgeNote[]> {
  if (!AGENT_SLUG.test(agentId)) return [];
  const dir = join(workspace, 'agents', agentId, 'knowledge');
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  } catch {
    return []; /* no folder yet — no notes */
  }
  const notes: AgentKnowledgeNote[] = [];
  for (const f of names) {
    const st = await stat(join(dir, f)).catch(() => null);
    if (!st || !st.isFile()) continue; // a `*.md` DIRECTORY is not a note
    const body = await readFile(join(dir, f), 'utf8').catch(() => '');
    const meta = noteMeta(f, body);
    notes.push({
      ...meta,
      relativePath: `agents/${agentId}/knowledge/${f}`,
      mtime: st.mtimeMs,
      size: st.size,
    });
  }
  // Newest first, slug as the tie-break so equal mtimes don't depend on readdir order.
  return notes.sort((a, b) => b.mtime - a.mtime || a.slug.localeCompare(b.slug));
}

/**
 * Read ONE knowledge note's markdown (the modal's note viewer). Both ids are asserted
 * to be slugs — agentId AND slug are renderer-supplied over IPC, and each becomes a
 * path segment, so `..`, `/` or an absolute path can never reach the filesystem. An
 * unknown agent / note (or an unreadable file) → null, never a throw.
 */
export async function readKnowledgeNote(workspace: string, agentId: string, slug: string): Promise<string | null> {
  if (!AGENT_SLUG.test(agentId) || !AGENT_SLUG.test(slug)) return null;
  return await readFile(join(workspace, 'agents', agentId, 'knowledge', `${slug}.md`), 'utf8').catch(() => null);
}

/**
 * Add a studied topic to the agent's line in the shared index (agents/index.md)
 * so Alfred can route by learned topic. Missing/empty index or unknown agent →
 * a no-op (never throws). Local edit only — not egress. The cheap incremental
 * path: a later rebuildIndex reproduces the same suffix from the note files.
 */
export async function addStudyTopicToIndex(workspace: string, agentId: string, topic: string): Promise<void> {
  const file = join(workspace, 'agents', 'index.md');
  const cur = await readFile(file, 'utf8').catch(() => '');
  const next = addTopicToIndex(cur, agentId, topic);
  if (next !== cur) await writeFile(file, next, 'utf8');
}
