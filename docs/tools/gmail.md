# gmail

**Read-only** Gmail access. Alfred can never send or modify mail. Source:
`src/main/tools/gmail.ts`. OAuth scope: `gmail.readonly`.

## Ops
| op | args | does | risk |
|----|------|------|------|
| `connect` | — | authorise an account via Google consent (opens a loopback OAuth flow in the browser) | **T2** |
| `list` | `query`, `maxResults` | recent messages (optionally filtered) | T0* |
| `search` | `query`, `maxResults` | messages matching a Gmail query | T0* |
| `read` | `id` | full message by id | T0* |

`account` (email) selects which connected account; defaults to the most recently
connected. `maxResults` default **10**. `query` is Gmail search syntax
(e.g. `from:boss is:unread`).

\* T0 by tier, **but** any read marks the session `readUntrusted` **and**
`hasPrivate` — this arms the trifecta rule, so a later egress action (send/post/
shell/…) will require an approval.

## Output
- `connect` → `{ email }`.
- `list`/`search` → `{ account, messages: [{ id, subject, from, date, snippet }] }`.
- `read` → `{ account, id, subject, from, to, date, snippet, body }` (plain-text
  body preferred, HTML fallback).

## Setup & failure modes
- Requires `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` in the env
  (see README "Connecting Gmail"); missing → a clear error.
- Tokens are stored in the macOS Keychain (`gmail:<email>`), never on disk.
- `connect` needs a **T2** approval; declined/timed-out → error, no account added.
- Any op with no connected account (and none passed) → error asking you to
  `connect` first.

## Examples
```json
{ "op": "connect" }
{ "op": "search", "query": "is:unread newer_than:2d", "maxResults": 5 }
{ "op": "read", "id": "18f..." }
```
