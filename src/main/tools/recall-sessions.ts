/**
 * `recall_sessions` (Phase 6 stage 4) — zero-LLM recall over the raw session
 * transcript via SQLite FTS5 (`messages_fts`, see core/db.ts). Distinct from the
 * semantic vault (`memory`): this returns REAL past messages, never a summary.
 *
 * Three modes, inferred from the args (no mode flag — see recallMode):
 *   DISCOVERY  {query}                       → FTS5 MATCH: top sessions, each with
 *                                              a snippet + a ±radius message window
 *                                              (+ bookends) around its best hit.
 *   SCROLL     {sessionId, aroundMessageId}  → re-anchor: the ±radius window around
 *                                              a known message (paging through a session).
 *   BROWSE     {}                            → the most recent sessions (first/last line).
 *
 * The query is sanitised (sanitizeFtsQuery) so FTS operators / quotes can neither
 * break the MATCH nor inject syntax. T0 (read-only) — pure DB reads.
 */
import type { Tool } from '../core/types.ts';
import { recallMode, sanitizeFtsQuery, windowSlice } from '../core/session-recall-pure.ts';

interface Args {
  /** DISCOVERY: free text to full-text search. */
  query?: string;
  /** SCROLL: the session to re-anchor within. */
  sessionId?: string;
  /** SCROLL: the message id to centre the window on. */
  aroundMessageId?: string;
  /** ± messages of context around each anchor (default 4, capped 20). */
  radius?: number;
  /** DISCOVERY/BROWSE: how many sessions to return (default 5, capped 20). */
  limit?: number;
}

interface Row {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  ts: number;
}

const MAX_CONTENT = 600;
const clampMsg = (r: Row): Row => ({ ...r, content: r.content.length > MAX_CONTENT ? r.content.slice(0, MAX_CONTENT) + '…' : r.content });

type DB = import('better-sqlite3').Database;

function sessionMessages(db: DB, sessionId: string): Row[] {
  return db
    .prepare('SELECT id, session_id AS sessionId, role, content, ts FROM messages WHERE session_id = ? ORDER BY ts ASC, rowid ASC')
    .all(sessionId) as Row[];
}

/** The ±radius window (+ bookends) around a message id inside its session. */
function windowAround(db: DB, sessionId: string, anchorId: string, radius: number) {
  const all = sessionMessages(db, sessionId);
  const anchorIndex = all.findIndex((m) => m.id === anchorId);
  const w = windowSlice(all, anchorIndex < 0 ? 0 : anchorIndex, radius);
  return {
    sessionId,
    anchorId,
    anchorFound: anchorIndex >= 0,
    total: all.length,
    range: { start: w.start, end: w.end },
    headBookend: w.headBookend ? clampMsg(w.headBookend) : null,
    tailBookend: w.tailBookend ? clampMsg(w.tailBookend) : null,
    messages: w.items.map(clampMsg),
  };
}

export const recallSessions: Tool<Args> = {
  name: 'recall_sessions',
  description:
    'Zero-LLM recall over the RAW conversation transcript (SQLite FTS5) — returns real past messages, not a summary. ' +
    'Distinct from `memory` (the curated vault): use this for "what did we actually say weeks ago". Three modes, inferred from args: ' +
    'DISCOVERY — pass `query` (free text): full-text search; returns the top matching sessions, each with a snippet and a ±radius window of surrounding messages (plus the session’s first/last message as bookends). ' +
    'SCROLL — pass `sessionId` + `aroundMessageId`: re-anchors and returns the ±radius window around that message (page forward/back by re-calling with an id from the returned window’s edge). ' +
    'BROWSE — pass nothing: the most recent sessions with their first/last line. ' +
    '`radius` sets the context window (default 4, max 20); `limit` caps how many sessions (default 5, max 20).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'DISCOVERY: free text to full-text search across all sessions.' },
      sessionId: { type: 'string', description: 'SCROLL: the session id to re-anchor within.' },
      aroundMessageId: { type: 'string', description: 'SCROLL: the message id to centre the window on.' },
      radius: { type: 'integer', description: '± messages of context around each anchor (default 4, max 20).' },
      limit: { type: 'integer', description: 'DISCOVERY/BROWSE: how many sessions to return (default 5, max 20).' },
    },
  },

  // Read-only recall.
  risk: () => 'T0',

  async execute(a, ctx) {
    try {
      const db = ctx.db;
      const radius = Math.min(20, Math.max(0, Math.trunc(a.radius ?? 4) || 0));
      const limit = Math.min(20, Math.max(1, Math.trunc(a.limit ?? 5) || 5));
      const mode = recallMode(a);

      if (mode === 'scroll') {
        return { ok: true, result: { mode, ...windowAround(db, a.sessionId!, a.aroundMessageId!, radius) } };
      }

      if (mode === 'discovery') {
        const match = sanitizeFtsQuery(a.query);
        if (!match) return { ok: true, result: { mode, query: a.query, match: '', sessions: [] } };
        const hits = db
          .prepare(
            "SELECT id, session_id AS sessionId, ts, snippet(messages_fts, 3, '«', '»', '…', 12) AS snippet " +
              'FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT 200',
          )
          .all(match) as { id: string; sessionId: string; ts: number; snippet: string }[];
        // Keep the best-ranked hit per session, up to `limit` sessions.
        const seen = new Set<string>();
        const sessions: unknown[] = [];
        for (const h of hits) {
          if (seen.has(h.sessionId)) continue;
          seen.add(h.sessionId);
          sessions.push({ snippet: h.snippet, hitMessageId: h.id, ...windowAround(db, h.sessionId, h.id, radius) });
          if (sessions.length >= limit) break;
        }
        return { ok: true, result: { mode, query: a.query, match, sessions } };
      }

      // BROWSE — recent sessions with first/last line.
      const recent = db
        .prepare(
          'SELECT session_id AS sessionId, COUNT(*) AS count, MIN(ts) AS firstTs, MAX(ts) AS lastTs ' +
            'FROM messages GROUP BY session_id ORDER BY lastTs DESC LIMIT ?',
        )
        .all(limit) as { sessionId: string; count: number; firstTs: number; lastTs: number }[];
      const sessions = recent.map((s) => {
        const msgs = sessionMessages(db, s.sessionId);
        return {
          sessionId: s.sessionId,
          count: s.count,
          firstTs: s.firstTs,
          lastTs: s.lastTs,
          first: msgs.length ? clampMsg(msgs[0]) : null,
          last: msgs.length ? clampMsg(msgs[msgs.length - 1]) : null,
        };
      });
      return { ok: true, result: { mode, sessions } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
