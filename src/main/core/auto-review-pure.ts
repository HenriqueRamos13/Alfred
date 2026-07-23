/**
 * Pure decision logic for the memory auto-review (Phase 6 stage 4). The IO — read
 * recent messages, call the cheap brain, stage the proposal — lives in
 * auto-review.ts; only the deterministic parts are here so they are unit-tested:
 *   - shouldRecord(signals): whether it is even worth spending a cheap-brain call
 *     (NO run when nothing changed since the last review).
 *   - parseReviewProposal(modelText): extract the proposal the brain returned;
 *     null when it declined or produced nothing usable.
 */

export interface ReviewSignals {
  /** ts of the most recent message. */
  latestTs: number;
  /** ts recorded at the last auto-review (0 when never run). */
  lastReviewedTs: number;
  /** How many USER messages arrived since the last review. */
  newUserMessages: number;
}

/**
 * Gate for running the auto-review at all. Cheap-brain calls cost tokens, so we
 * only spend one when there is genuinely new user input since we last looked —
 * "NÃO corre se nada mudou". Pure.
 */
export function shouldRecord(s: ReviewSignals | undefined): boolean {
  if (!s) return false;
  return s.latestTs > s.lastReviewedTs && s.newUserMessages >= 1;
}

export interface ReviewProposal {
  /** Durable-fact ('semantic') vs dated-event ('episodic'); defaults to semantic. */
  kind: 'semantic' | 'episodic';
  /** Short human-readable title for the staged note. */
  title: string;
  /** The one durable thing to remember (a user fact or a workflow lesson). */
  text: string;
}

interface RawProposal {
  record?: unknown;
  kind?: unknown;
  title?: unknown;
  text?: unknown;
}

/**
 * Parse the cheap brain's reply into a proposal. The brain answers with a single
 * JSON object `{ record, kind, title, text }` (record:false when nothing is worth
 * keeping). Tolerates code fences / surrounding prose. Returns null when it
 * declined, produced no parseable object, or left `text` blank — so a "nothing
 * durable here" answer never fabricates a memory. Pure.
 */
export function parseReviewProposal(modelText: unknown): ReviewProposal | null {
  if (typeof modelText !== 'string') return null;
  const fenced = modelText.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let j: RawProposal;
  try {
    j = JSON.parse(fenced.slice(start, end + 1)) as RawProposal;
  } catch {
    return null;
  }
  if (j.record === false || j.record === 'false') return null;
  const text = typeof j.text === 'string' ? j.text.trim() : '';
  if (!text) return null;
  const title = typeof j.title === 'string' && j.title.trim() ? j.title.trim() : text.slice(0, 60);
  const kind: ReviewProposal['kind'] = j.kind === 'episodic' ? 'episodic' : 'semantic';
  return { kind, title, text };
}
