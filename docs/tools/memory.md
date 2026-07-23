# memory

File-based long-term memory. Source: tool `src/main/tools/memory.ts`, logic
`src/main/core/memory.ts`. See also
[docs/memory/how-memory-works.md](../memory/how-memory-works.md).

## Ops
| op | args | does | risk |
|----|------|------|------|
| `read` | — | load the stable human-curated layer (preferences + house rules) | T0 |
| `append` | `text` | add a line to this session's ephemeral working notes (Layer 4) | T1 |
| `remember` | `text`, `kind` | durably save: `episodic` (default, dated journal entry) or `semantic` (fact) | T1 |
| `recall` | `query`, `sinceDays` | grep the journal + facts; `sinceDays` default 7 | T0 |
| `list` | — | which journal days exist + whether facts.md exists + the real vault notes (`{title, slug, relativePath}`) | T0 |
| `note` | `title`(req), `type`, `tags[]`, `observations[]`, `relations[]` | create/update an ATOMIC vault note | T1 |
| `delete` | `title`(req — title OR slug) | remove a vault note, then recompute index/maps/backlinks so the graph drops the node + its edges | **T2** |
| `handoff` | `summary`(req), `notePath`, `tags[]` | drop a short handoff into the inbox for the curator | T1 |

## Note structure (`op: note`)
A note is **one atomic idea**. Re-using a `title` **merges** into the existing
note (union of observations/relations/tags — idempotent).
- `type`: `note` (default) | `project` | `person` | `tool` | `decision`.
- `observations`: `[{ category, text }]`, category one of
  `decision|requirement|risk|gotcha|fact|tip`.
- `relations`: `[{ type, target }]`, `target` is another note's title (rendered
  as a `[[wikilink]]`); `type` e.g. `part_of|uses|relates_to|about`.

## Output
- `read` → the combined stable text (string).
- `remember` → `{ kind, file }` (path written).
- `recall` → `{ sinceDays, query, days: [{ day, entries[] }], facts[] }`.
- `list` → `{ journalDays[], facts, notes: [{ title, slug, relativePath }] }`.
- `note` → `{ slug, file }`.
- `delete` → `{ deleted, slug, path, message }` (`deleted:false` when the note doesn't exist — never throws).
- `handoff` → `{ file }`.
- Any write flagged **suspicious** by the scan (below) also carries a `warning`.

## Security scan (anti-poisoning)
Every write (`append`/`remember`/`note`/`handoff`) is scanned by `scanMemoryText`
before it lands, because memory flows back into the prompt. **dangerous** text
(prompt-injection — "ignore previous instructions", forged `system:` markers — or
credential-exfil — embedded API keys, "send the password to…") is **refused**
(`{ ok:false, error }` listing the findings). **suspicious** text (invisible/bidi/
homoglyph Unicode, stray `<script>`) is written with a `warning`. See
[docs/memory/how-memory-works.md](../memory/how-memory-works.md#memory-security-scan-anti-poisoning).

## Rules
- **Never invent memories.** If `recall` returns nothing, say so.
- **Never edit the stable layer** (`preferences.md`/`house-rules.md`) — it is the
  human's; you only `read` it.
- Save proactively: durable user/world facts as `semantic`; noteworthy events as
  `episodic`. When a relevant task ends: `note` then `handoff`.
- Writes are append-only; the curator (a cheap separate brain) later turns
  handoffs into notes and rebuilds `index.md`/maps/backlinks.
- **Deleting**: never guess a note's slugified filename — run `list` to get the
  exact `slug`, then `delete` with the title or that slug. `delete` resolves the
  slug the same way `note` does (idempotent `slugify`) and recomputes the indexes,
  so the knowledge graph drops the node and any edge into it.

## Examples
```json
{ "op": "remember", "text": "User prefers pt-PT.", "kind": "semantic" }
{ "op": "recall", "query": "deploy", "sinceDays": 30 }
{ "op": "note", "title": "Alfred deploy", "type": "decision",
  "observations": [{ "category": "decision", "text": "Ship via electron-builder on Linux." }],
  "relations": [{ "type": "part_of", "target": "Alfred" }] }
{ "op": "handoff", "summary": "Documented deploy steps.", "notePath": "memory/notes/alfred-deploy.md" }
{ "op": "list" }
{ "op": "delete", "title": "Alfred deploy" }
```
