# recall_sessions — raw-transcript recall (FTS5)

Zero-LLM recall over the **raw conversation transcript**. It returns real past
messages straight from SQLite — never a summary. This is deliberately distinct
from the `memory` tool: `memory` is the *curated* semantic vault (facts, notes,
journal); `recall_sessions` is "what did we **actually say** weeks ago".

- **Risk tier:** T0 (read-only). No approval.
- **Source:** the `messages` table, indexed by an FTS5 virtual table
  `messages_fts` kept in sync via SQLite triggers (see `src/main/core/db.ts`),
  backfilled idempotently on boot.
- **Pure logic:** `src/main/core/session-recall-pure.ts` (query sanitisation +
  windowing/bookends), unit-tested in `test/logic.test.ts`. IO adapter:
  `src/main/tools/recall-sessions.ts`.

## Three modes (inferred from the args, no mode flag)

| Mode | Args | Returns |
|------|------|---------|
| **DISCOVERY** | `query` (free text) | Top matching sessions (best FTS rank first). Each: a `snippet`, the `hitMessageId`, and a `±radius` window of surrounding messages plus the session's first/last message as **bookends**. |
| **SCROLL** | `sessionId` + `aroundMessageId` | The `±radius` window re-anchored on that message (`anchorFound` flags a stale id). Page forward/back by re-calling with an id from the window's edge. |
| **BROWSE** | *(none)* | The most recent sessions with their first/last line and message count. |

Optional everywhere: `radius` (± messages of context, default 4, max 20) and
`limit` (how many sessions, default 5, max 20).

## Query safety

FTS5 treats `"`, `*`, `:`, `^`, `(`, `)`, `-`, `NEAR`, and bare-word `AND`/`OR`/
`NOT` as syntax. An unsanitised query either throws `fts5: syntax error` or lets
the caller inject FTS operators. `sanitizeFtsQuery` extracts only
letter/number/underscore tokens and quotes each as a literal phrase (implicit
AND), so no operator survives and the MATCH can neither break nor be injected. A
query with no usable token returns no results (never an error).

## When to use which

- Use **`recall_sessions`** to quote or re-read the literal exchange.
- Use **`memory recall`** for the durable distilled knowledge the curator has
  filed (facts, notes) — not the verbatim chat.
