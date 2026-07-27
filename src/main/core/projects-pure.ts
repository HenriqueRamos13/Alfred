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
