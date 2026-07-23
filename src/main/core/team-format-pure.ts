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
