# browser

Drive a real (non-headless) Chromium window that persists cookies/sessions
across runs (a lazy singleton persistent context under the app data dir).
Source: `src/main/tools/browser.ts`.

## Input
| field | type | required | notes |
|-------|------|----------|-------|
| `op` | `goto`\|`readText`\|`click`\|`type`\|`screenshot` | yes | |
| `url` | string | goto | URL to open |
| `selector` | string | click/type | CSS selector |
| `text` | string | type | text to fill |
| `path` | string | screenshot | output PNG; default `screenshot-<ts>.png` in the workspace |

## Output
- `goto` → `{ url, title }`
- `readText` → `{ url, text }` (visible `document.body.innerText`)
- `click` / `type` → `{ url }`
- `screenshot` → `{ path }` (full-page PNG)

Waits: `goto` waits for `domcontentloaded`; `click`/`type` have a **15 s**
element timeout.

## Risk, trifecta & login walls
- `goto`, `readText`, `screenshot` → **T0**. `click`, `type` → **T1** (can
  mutate remote state).
- **`readText` marks the session `readUntrusted`** — web content is untrusted
  input. Combined with private data + an egress tool later, the trifecta rule
  forces an approval.
- **Login walls**: after `goto`/`click`, if the URL/DOM looks like a sign-in
  page (auth/login/signin/oauth URL or a `input[type=password]`), the tool
  pauses for a **T2** approval asking the human to sign in **manually** in the
  window, then continues. **Alfred never types passwords.** For `type`, prefer
  non-credential fields only.

## Failure modes
- Missing required arg (e.g. `click` without `selector`) → `{ ok:false, error }`.
- Selector not found within 15 s → error from Playwright.
- Declined/timed-out login approval → `{ ok:false, error }`.

## Examples
```json
{ "op": "goto", "url": "https://news.ycombinator.com" }
{ "op": "readText" }
{ "op": "type", "selector": "input[name=q]", "text": "playwright" }
{ "op": "screenshot", "path": "shots/page.png" }
```
