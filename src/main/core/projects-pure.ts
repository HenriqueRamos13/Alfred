/**
 * Projects — pure decisions (no IO), so the write surfaces can reject bad input
 * before touching the DB and the tests exercise every rejection.
 */

/**
 * Reject a phantom board: a card/message anchored to a project must name a KNOWN
 * project slug. Returns an explicit error string, or null when the slug is known.
 * Pure — the caller supplies the current set of known slugs.
 */
export function unknownProjectError(slug: string, knownSlugs: Iterable<string>): string | null {
  const set = knownSlugs instanceof Set ? knownSlugs : new Set(knownSlugs);
  return set.has(slug) ? null : `unknown project "${slug}"`;
}

/**
 * PARAR a project (P7): when the user pauses a project NO agent may work on it
 * until a resume. Fail-closed for agents, never for the user — the pause is the
 * user's own hold, so the user keeps editing/moving cards while it holds.
 * `paused && actor==='agent'` → blocked; the user is never blocked. Pure.
 */
export function isProjectWorkBlocked(paused: boolean, actor: 'agent' | 'user'): boolean {
  return actor === 'agent' && paused;
}

/** The set of slugs that are paused, from the projects index rows. Pure. */
export function pausedSlugSet(rows: Iterable<{ slug: string; paused?: number | boolean | null }>): Set<string> {
  const set = new Set<string>();
  for (const r of rows) if (r.paused) set.add(r.slug);
  return set;
}
