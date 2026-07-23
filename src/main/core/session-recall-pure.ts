/**
 * Pure logic for the `recall_sessions` tool (Phase 6 stage 4): FTS5 query
 * sanitisation + the ±N windowing/bookend math. Renderer-safe & PURE (no
 * `node:*` / driver import) so it is unit-tested via `node --experimental-strip-types`.
 * The SQLite IO that USES these lives in src/main/tools/recall-sessions.ts.
 */

export type RecallMode = 'discovery' | 'scroll' | 'browse';

/**
 * Which of the three recall modes the args select, inferred (no explicit mode
 * flag): sessionId+aroundMessageId → SCROLL (re-anchor a known session);
 * a non-blank query → DISCOVERY (FTS search); nothing → BROWSE (recent sessions).
 */
export function recallMode(a: { query?: string; sessionId?: string; aroundMessageId?: string } | undefined): RecallMode {
  if (a?.sessionId && a?.aroundMessageId) return 'scroll';
  if (a?.query && a.query.trim()) return 'discovery';
  return 'browse';
}

/**
 * Turn free text into a SAFE FTS5 MATCH expression. FTS5 treats `"`, `*`, `:`,
 * `^`, `(`, `)`, `-`, `NEAR`, and the bare-word operators AND/OR/NOT as syntax —
 * an unescaped query either throws ("fts5: syntax error") or lets a caller inject
 * FTS operators. We extract only letter/number/underscore tokens and quote each
 * as a literal phrase, joined by spaces (implicit AND). Everything else is
 * dropped, so no operator survives. Empty when the query has no usable token.
 */
export function sanitizeFtsQuery(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
  // ponytail: cap tokens so a pathological paste can't build a huge MATCH; 32 is plenty for recall.
  return tokens.slice(0, 32).map((t) => `"${t}"`).join(' ');
}

export interface WindowResult<T> {
  /** Inclusive start / exclusive end indices into the source array. */
  start: number;
  end: number;
  items: T[];
  /** The session's very first item, present only when the window omits it. */
  headBookend: T | null;
  /** The session's very last item, present only when the window omits it. */
  tailBookend: T | null;
}

/**
 * The ±`radius` window of `all` centred on `anchorIndex`, plus bookends: when the
 * window doesn't already reach an edge, the first/last item is surfaced so the
 * caller always shows where in the session the excerpt sits. `anchorIndex` is
 * clamped into range and `radius` floored at 0.
 */
export function windowSlice<T>(all: readonly T[], anchorIndex: number, radius: number): WindowResult<T> {
  const n = all.length;
  if (n === 0) return { start: 0, end: 0, items: [], headBookend: null, tailBookend: null };
  const a = Math.max(0, Math.min(n - 1, Math.trunc(anchorIndex) || 0));
  const r = Math.max(0, Math.trunc(radius) || 0);
  const start = Math.max(0, a - r);
  const end = Math.min(n, a + r + 1);
  return {
    start,
    end,
    items: all.slice(start, end),
    headBookend: start > 0 ? all[0] : null,
    tailBookend: end < n ? all[n - 1] : null,
  };
}
