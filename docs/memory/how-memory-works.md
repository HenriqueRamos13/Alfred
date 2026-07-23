# How Alfred's memory works

File-based, survives restarts, curated by Alfred itself. Everything lives under
`<workspace>/memory/`. Sources: `src/main/core/memory.ts` (layout + pure
parsers), `curator.ts` (organiser). The `memory` tool
([docs/tools/memory.md](../tools/memory.md)) is how you read/write it.

## Layers
- **Stable (human-curated)** — `preferences.md`, `house-rules.md`. Injected into
  every system prompt. **Honour, never edit.**
- **Long-term (yours to write)**
  - *episodic* — dated journal, one entry/event: `journal/YYYY-MM-DD.md`.
  - *semantic* — enduring facts: `facts.md`.
  - both append-only, timestamped.
- **Vault (Zettelkasten)** — atomic notes in `notes/<slug>.md`, per-type maps in
  `maps/`, root router `index.md`, handoff queue `inbox/`, rebuildable cache
  `.index/` (gitignored).
- **Ephemeral** — per-session working notes `working/<sessionId>.md` (`append`).

## What lands in the prompt (the always-loaded slice)
The orchestrator injects, each turn: the stable layer, `index.md` (the **L1
router** — a Map of Content linking every note via `[[wikilinks]]`), and the last
**7 days** of journal + facts (size-capped, oldest lines dropped first). Old
journal days and individual notes are **not** loaded — reach them lazily with
`recall` and by following the wikilinks the index lists.

## Note format
Frontmatter (`title`, `type`, `created`, `updated`, `tags[]`) + `## Observations`
(typed one-liners `- [category] text`, category
`decision|requirement|risk|gotcha|fact|tip`) + `## Relations` (typed
`- rel_type [[Target]]`). Re-using a title **merges** (union, idempotent).

## When to write
1. Proactively `remember` durable facts (`semantic`) and noteworthy events
   (`episodic`) as they happen.
2. When a **relevant task completes**: `memory` op:`note` (one atomic idea, with
   `[[wikilink]]` relations), then `memory` op:`handoff` (a short summary + the
   note/file path).
3. Never invent memories — if `recall` finds nothing, say so.

## The curator (librarian)
Runs on IDLE after a task (debounced, never mid-task) on a **cheap** brain. It
drains `inbox/` handoffs into well-formed atomic notes (merging into existing
ones by title), then regenerates `index.md`, `maps/`, and `.index/backlinks.json`.
It is idempotent, never throws, respects the token kill-switch, and falls back to
a verbatim note if the model is unavailable — a handoff is never lost. **You
capture; the curator organises.**

## Auto-review (background self-improvement)
On the SAME idle sweep as the curator (debounced after a turn, never mid-task), a
**cheap** brain reviews a **digest** of the recent transcript and decides whether
there is one *durable* thing worth remembering — a stable user fact, or a
workflow lesson ("be terser"). It is cheap by construction: a digest, not the
whole conversation; **it does not run when nothing changed** since the last
review (a persisted `auto_review:last_ts` watermark); it is budget-guarded.

A positive decision is **not** committed as a fact directly. It is **staged** as
an inbox handoff — the same propose→curate path an agent uses — so the governed
librarian turns it into a well-formed note rather than a raw injected fact. The
proposal is security-scanned (below) before it is staged; a `record: false`
answer stages nothing (never fabricate). Pure decision logic:
`src/main/core/auto-review-pure.ts` (`shouldRecord`, `parseReviewProposal`); IO
shell: `auto-review.ts`.

## Memory security scan (anti-poisoning)
Because memory later flows back into the system prompt, a poisoned note is a
prompt-injection vector. Every agent- or auto-review-authored write
(`append`/`remember`/`note`/`handoff`) is scanned by `scanMemoryText`
(`src/main/core/memory-scan-pure.ts`) **before** it lands:

- **dangerous** (prompt-injection like "ignore previous instructions" / forged
  `system:` role markers; credential-exfil like embedded API keys or "send the
  password to…") → the write is **refused** with the findings.
- **suspicious** (invisible/bidi/homoglyph Unicode, stray `<script>`) → written,
  but the result carries a `warning`.
- **ok** → silently written.

It generalises the core of the widget scanner (`scanWidgetHtml`) and shares its
invisible-Unicode/homoglyph patterns. Heuristic, not a boundary against an
adversarial model — it breaks the poisoned-note → poisoned-prompt loop.

## Raw-transcript recall vs the vault
`recall`/`note` operate on the *curated* vault. To find what was **literally
said** in an old session, the `recall_sessions` tool full-text-searches the raw
`messages` transcript via SQLite FTS5 (discovery / scroll / browse; zero LLM).
See [docs/tools/recall-sessions.md](../tools/recall-sessions.md).
