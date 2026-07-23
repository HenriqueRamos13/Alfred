# schedule

Create and manage **Scheduled Jobs** — recurring tasks that persist in the DB
and **re-arm on boot** (the scheduler is in-app, not OS cron). A job is one of
three kinds:

- **`fetch`** — a cheap HTTP `GET` on a timer that pulls a value to display.
  **Zero AI tokens.** (The weather widget.)
- **`agent`** — an autonomous Alfred turn from a prompt. Costs tokens, runs
  unattended, bounded by a per-job daily budget and an autonomy grant.
- **`study`** — a **roster agent** learns a topic on a timer (`study:{agentId,
  topic}`): a read-only web-research turn saved to the agent's private knowledge
  + the shared index, capped by that agent's **own per-agent daily token budget**.
  Runs the factored `runStudy` unattended; the agent must exist and be an API
  brain (not `claude-cli`). See [team.md](team.md).

This tool **only persists and (re)schedules** jobs — it never runs one. The
timer engine fires due jobs; a `fetch` refresh emits a `job.data` stream event.
Source: `src/main/tools/schedule.ts` (+ `core/jobs.ts`, `core/jobs-pure.ts`).

## Ops, args, output
| op | args | output | risk |
|----|------|--------|------|
| `create` | `title`, `kind`, `schedule`, + per-kind fields (below) | `{ job, nextRun }` | **T2** |
| `list` | — | `{ jobs: [summary…] }` | T0 |
| `pause` | `id` | `{ job }` | **T2** |
| `resume` | `id` | `{ job }` | **T2** |
| `delete` | `id` | `{ deleted }` | **T2** |
| `edit` | `id`, + any create field to change (**merged**, not replaced) | `{ job, nextRun }` | **T2** |

`create`/`edit`/`pause`/`resume`/`delete` are **T2** — they establish or change
recurring egress/compute. In **dangerous mode** the host auto-approves the T2,
like every other tool. (The governance of an `agent` job's *unattended actions*
— the sensitive-action approval queue — is a separate, later stage; sensitive
actions never auto-run unattended even in dangerous mode.)

### schedule
- `{ "type": "interval", "everyMs": <ms> }` — `everyMs` must be **>= 30000** (30s
  floor, so a job can't hammer a source).
- `{ "type": "daily", "at": "HH:MM" }` — 24-hour **local** time.

### kind:"fetch" — `source`
| field | notes |
|-------|-------|
| `url` | required; `http://` or `https://` only. **SSRF guard:** rejected if it targets localhost, an `.local`/`.internal`/`.lan` name, or a loopback/private/link-local IP literal (incl. the `169.254.169.254` cloud-metadata address). Enforced at create/edit **and** re-checked at run time. |
| `method` | optional; only `"GET"` |
| `headers` | optional object of request headers |
| `extract` | optional dot/bracket path into the JSON response, e.g. `current.temperature_2m`, `list[0].main.temp`. Omit to keep the whole payload. Missing path → `undefined` (never errors). |

### kind:"agent" — `prompt` + `grant`
| field | notes |
|-------|-------|
| `prompt` | required; the task run each time the job fires |
| `grant` | allowlist of capabilities the unattended job may use. **ASK the user the autonomy level BEFORE creating.** Default `["read","notify"]`. |
| `tokenBudgetDaily` | optional positive per-day token cap; omitted → a sane default |

`grant` values: `read`, `notify`, `write`, `browse`, `shell`, `send`, `delete`,
`money`, `secrets`. The sensitive ones (`send`/`money`/`delete`/`secrets`) never
auto-run unattended regardless of the grant — they queue an approval.

### kind:"study" — `study`
| field | notes |
|-------|-------|
| `study.agentId` | required; a roster agent id (`team op=list`). Must **exist** and be an **API brain** (not `claude-cli`) — checked at create. |
| `study.topic` | required; what to research each run (e.g. `Rust async runtimes`). |

A `study` job runs `runStudy(ctx, agentId, topic, { unattended:true })` on the
schedule — the SAME core as the `agent_study` tool. Cost is capped by the
**agent's** `dailyTokenBudget` (not a per-job `tokenBudgetDaily`); on exhaustion
the job is **paused** and the user notified. Governance is fail-closed:
sensitive/outbound actions **queue** for approval (never auto-run), like an
`agent` job. The agent's grant must include `read` (browse read-only).

### render / placement (optional)
- `render` — `{ tier: 1|2|3, card: string, html? }`; default `{ tier:1, card:"value" }`.
  - **tier 1 (PREFER THIS)** — a builtin data card fed by `job.data`, updates live and
    reliably with **no custom HTML**. It renders a single **value** when the extracted
    data is a scalar, and a live **sparkline** when the extract returns a **numeric
    array**. See "Tier-1 — value and live sparkline" below.
  - **tier 2** — a **custom self-contained HTML** widget the model writes (`html`,
    required, `<= 256 KB`). Only for bespoke visuals the builtin card cannot do. See
    "Tier-2 HTML widgets" below.
- `placement` — `{ displayId?: number, corner?: "tl"|"tr"|"bl"|"br" }`.

## Tier-1 — value and live sparkline (PREFER THIS)

The default `render` needs **no HTML** and updates automatically on every refresh —
the card subscribes to the same `job.data` stream that feeds Scheduled Tasks. Two
shapes, chosen automatically from the extracted value:

- **Value** — the extract yields a scalar (number/string, or an object with a
  `value`/`temperature`/`temp`/`val` field, optionally `unit`) → a big number + unit.
- **Sparkline** — the extract yields a **numeric array** (`number[]`, or an array of
  `{ value: number }`, length ≥ 2) → an inline-SVG line chart, re-drawn each refresh.

For a chart there is usually **no reason to write tier-2 HTML**: just make
`source.extract` return an array of numbers (e.g. the last 30 days of prices, or an
`hourly.temperature_2m` array) and tier-1 draws and keeps the sparkline live for you.

## Tier-2 HTML widgets (custom viz)

Use tier-2 **only** for a bespoke visual the builtin tier-1 card can't do (a plain
value or a numeric-array sparkline are already covered by tier-1 — reach for that
first). Set `render: { tier: 2, card: "html", html: "<…>" }`. The `html` is a page the
model writes; **the data pipeline is unchanged** (same `fetch`/`agent` refresh) — tier 2
only replaces the render.

> **Tier-2 is DECLARATIVE — you write NO JavaScript.** You write pretty HTML/CSS
> (arbitrary CSS and markup — neither is blocked) and mark the **live** parts with
> `data-alfred*` attributes. A strict CSP **hash-pins the trusted runtime and blocks
> every model `<script>`** (and every external script), so any `<script>` you write
> would simply never run. There is also **no network** — you cannot `fetch`.

A **hash-pinned trusted runtime** (injected before your markup) fills your bindings on
**every** refresh with the job's latest value (the extracted `fetch` value or the
`agent` result, seeded from `runtime.lastResult` on load). Supported bindings:

- `data-alfred="path"` — sets the element's **textContent** to the value at `path`
  (a dot/bracket path like `current.temperature_2m` or `hourly.temp[0]`; the whole
  payload if you omit the path with `data-alfred=""`). Objects are shown as JSON.
- `data-alfred-sparkline="path"` — draws a minimal inline-SVG line chart of the
  **numeric array** at `path` into the element.
- `data-alfred-attr="attr:path"` — sets attribute `attr` to the value at `path`
  (e.g. `data-alfred-attr="title:current.summary"`).

**Never bake a fixed value into the markup** — an embedded literal is frozen at mount
and never changes; use a binding so the runtime keeps it live.

Minimal example (a big live temperature + a live sparkline, styled freely, no JS):

```json
{
  "op": "create", "title": "Temp trend", "kind": "fetch",
  "schedule": { "type": "interval", "everyMs": 300000 },
  "source": { "url": "https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14&current=temperature_2m&hourly=temperature_2m", "extract": "" },
  "render": {
    "tier": 2, "card": "html",
    "html": "<style>body{margin:0;font:14px system-ui;color:#35e5ff;background:#0b0f14;padding:12px}.big{font-size:40px;font-weight:600}</style><div class=\"big\"><span data-alfred=\"current.temperature_2m\"></span>°C</div><div data-alfred-sparkline=\"hourly.temperature_2m\"></div>"
  }
}
```

### Security (sandbox / CSP / offline)

The page is treated as **untrusted** and confined so a malicious or
prompt-injected page can only draw junk in its own card:

- Rendered as the `srcdoc` of `<iframe sandbox="allow-scripts">` — **no**
  `allow-same-origin` (opaque origin: no access to the parent DOM, cookies, or
  storage), no `allow-popups`/`allow-forms`/`allow-top-navigation`.
- A `srcdoc` iframe **inherits the parent document's CSP**, and CSPs compose by
  **intersection** (most restrictive wins). The parent ships `script-src 'self'` (no
  `'unsafe-inline'`), so the trusted runtime is pinned in **both** policies by its
  **SHA-256 hash**: the parent lists `'self' 'sha256-…'` and the widget's own `<head>`
  meta lists `default-src 'none'; script-src 'sha256-…'; style-src 'unsafe-inline'; img-src data:`.
  Only the runtime (matching hash) survives the intersection; **any model `<script>`
  is blocked by both** (wrong hash, no `'unsafe-inline'`). **Zero network** — no
  `fetch`/XHR/WebSocket, no external script/style/font.
- Data enters **one way**, by `postMessage` from the parent card into the frame —
  no IPC/preload channel is ever exposed to the page. The trusted **runner**
  (server-side) does all external fetching; the page never does. The runtime only
  ever writes `textContent` / attributes / its own SVG (never `innerHTML` with your
  data), so a hostile payload can't XSS even inside its own frame.

### The **Widget JS** toggle (run tier-2 JavaScript)

The top-strip **`</> WIDGET JS`** button (persisted setting `widget_scripts_enabled`,
default **OFF**) lets a tier-2 widget run its OWN JavaScript when you need real
interactivity/animation the declarative bindings can't express:

- **OFF (default):** the declarative path above — `srcdoc` + the hash-pinned runtime;
  model `<script>` never runs.
- **ON:** the same widget is served from a **custom Electron protocol**,
  `alfred-widget://widget/<jobId>`, instead of `srcdoc`. A custom-scheme document is a
  **separate origin** whose CSP comes from the **response header** and is therefore the
  widget's OWN policy — it is **NOT intersected** with the parent's the way a srcdoc's
  is. The header is `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`,
  so the model's inline JS **runs**. The parent adds `frame-src 'self' alfred-widget:`
  so the iframe can load the scheme — nothing else is loosened.
- **Still safe with JS on:** the iframe keeps `sandbox="allow-scripts"` **without**
  `allow-same-origin` (no parent DOM / cookies / IPC), and `default-src 'none'` means
  `connect-src` falls back to none — **fetch / XHR / WebSocket / sendBeacon are dead**
  and images are `data:`-only. A script can compute and animate but has **no way to
  exfiltrate**; data still arrives only via the parent's `postMessage`.

### The widget security **scanner**

Every tier-2 `html` is heuristically scanned at **create/edit** (`scanWidgetHtml`):

- **dangerous** (`eval`/`new Function`, `fetch`/XHR/WebSocket/`sendBeacon`, `<script src>`,
  `document.cookie`, `new Image`/remote `<img src=http>`, `parent`/`top`/`opener`
  frame-escape, `javascript:` URIs) → **creation is REFUSED** with the findings; fix the
  HTML or the request is rejected.
- **suspicious** (`localStorage`/`indexedDB`, inline `on*=` handlers, inline `<script>`,
  invisible/bidi Unicode, Cyrillic/Greek homoglyphs) → the widget **is created** but a
  **warning** with the findings is returned and emitted.
- **fail-loud:** when Widget JS is **OFF** and the HTML has a `<script>` or **no**
  `data-alfred*` binding, `create`/`edit` returns a clear warning ("modo declarativo:
  usa data-alfred / data-alfred-sparkline, ou liga o toggle Widget JS…") so a frozen
  widget is explained instead of silent.

## `list` / result summary (per job)
`{ id, title, kind, schedule, enabled, pausedReason, tokensToday,
tokenBudgetDaily, lastRunTs, nextRunTs, lastResult }` plus `source` (fetch),
`grant`+`prompt` (agent), or `study` (study).

`pause` disables the job (`enabled:false`); `resume` re-enables it **and** clears
any auto-pause reason (`budget`/`error`), then re-arms. `edit` **merges** the
fields you pass onto the job's current spec and re-validates the result — it does
NOT replace the whole spec. So editing only the `schedule` keeps a custom tier-2
`render.html`, the `source`, `prompt`, `grant` and `placement` untouched; send a
field only when you want to change it. (Previously `edit` was a full replace, so
omitting `render.html` silently wiped a custom widget.)

## Examples

Lisbon temperature every 5 minutes (open-meteo, no key, zero tokens):

```json
{
  "op": "create",
  "title": "Lisbon temperature",
  "kind": "fetch",
  "schedule": { "type": "interval", "everyMs": 300000 },
  "source": {
    "url": "https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14&current=temperature_2m",
    "extract": "current.temperature_2m"
  }
}
```

Daily Gmail triage at 09:00 (agent — ask the user the grant first):

```json
{
  "op": "create",
  "title": "Morning mail triage",
  "kind": "agent",
  "schedule": { "type": "daily", "at": "09:00" },
  "prompt": "Summarise new unread mail since yesterday; notify me with the highlights.",
  "grant": ["read", "notify"]
}
```

Pause / resume / delete by id:

```json
{ "op": "pause",  "id": "<jobId>" }
{ "op": "resume", "id": "<jobId>" }
{ "op": "delete", "id": "<jobId>" }
```
