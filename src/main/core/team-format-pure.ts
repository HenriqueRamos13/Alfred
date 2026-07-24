/**
 * Team-card display formatters — RENDERER-SAFE & PURE. Zero `node:*` / electron /
 * native imports, so the TEAM card (renderer) can import it directly.
 *
 * IMPORTANT: this is a SEPARATE module from team-pure.ts on purpose. team-pure
 * value-imports slugify from projects.ts, which value-imports `node:fs` — so
 * team-pure is NOT renderer-safe. Everything the card needs to FORMAT lives here
 * (only `import type` from team-pure, which strip-types erases). Data comes over
 * IPC; this module never touches disk or the DB.
 */

// Type-only (erased at runtime — no node import leaks in).
import type { DelegationRole } from './team-pure.ts';
// Reuse the already-tested, renderer-safe budget formatter (jobs-format-pure is
// node-free — it is imported by the Scheduled Tasks card too). Same "used / limit".
export { formatBudget as formatAgentBudget } from './jobs-format-pure.ts';

/** Human label for a delegation (privilege) role. */
export function humanizeRole(role: DelegationRole): string {
  return role === 'orchestrator' ? 'Orquestrador' : 'Especialista (leaf)';
}

/**
 * Topics an agent has studied, read from its line in the shared who-knows-what
 * index (agents/index.md). buildAgentsIndex writes one `- **Name** (`id`, model)`
 * line per agent; addTopicToIndex appends a ` · studied: a, b` suffix. This reads
 * ONLY the line carrying `` `<agentId>` `` and splits that suffix — so it never
 * mixes topics between agents. No suffix / unknown agent → []. Pure string parse.
 */
export function parseTopicsFromIndex(indexText: string, agentId: string): string[] {
  const marker = `\`${agentId}\``;
  for (const line of indexText.split('\n')) {
    if (!line.startsWith('- ') || !line.includes(marker)) continue;
    const m = line.match(/ · studied: (.+)$/);
    if (!m) return [];
    return m[1].split(',').map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

// ── org hierarchy (Phase 7, stage 2) — renderer-safe so the Org tab can import ──

/** One node in the org chart: an agent + its direct reports. */
export interface OrgNode<T> {
  agent: T;
  children: OrgNode<T>[];
}

/**
 * Build the management forest from a flat roster: roots are agents with no
 * (valid) parent; every other agent hangs under its parentId. An agent whose
 * parentId points at a missing agent — or at itself — becomes a root (fail-safe:
 * a node is never dropped from view). Each node is placed at most once, so a stray
 * cycle in corrupt data can't infinite-loop (the cycle simply isn't reachable from
 * any root). Pure + renderer-safe; generic over anything carrying id + parentId.
 */
export function buildOrgTree<T extends { id: string; parentId?: string | null }>(agents: readonly T[]): OrgNode<T>[] {
  const nodes = new Map<string, OrgNode<T>>();
  for (const a of agents) nodes.set(a.id, { agent: a, children: [] });
  const roots: OrgNode<T>[] = [];
  for (const a of agents) {
    const node = nodes.get(a.id)!;
    const parent = a.parentId != null && a.parentId !== a.id ? nodes.get(a.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * Whether an agent may message the USER directly (inbox power) — fail-closed:
 * only an orchestrator, OR an agent with the explicit `canMessageUser` flag set.
 * A leaf without the flag → false. Pure + renderer-safe.
 */
export function canMessageUserResolved(agent: { delegationRole: DelegationRole; canMessageUser?: boolean }): boolean {
  return agent.delegationRole === 'orchestrator' || agent.canMessageUser === true;
}
