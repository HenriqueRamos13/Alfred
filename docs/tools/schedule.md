# schedule

Create and manage **Scheduled Jobs** — recurring tasks that persist in the DB
and **re-arm on boot** (the scheduler is in-app, not OS cron). A job is one of
two kinds:

- **`fetch`** — a cheap HTTP `GET` on a timer that pulls a value to display.
  **Zero AI tokens.** (The weather widget.)
- **`agent`** — an autonomous Alfred turn from a prompt. Costs tokens, runs
  unattended, bounded by a per-job daily budget and an autonomy grant. *(The
  agent runner ships in a later stage; creating an agent job persists it now.)*

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

### render / placement (optional)
- `render` — `{ tier: 1|2|3, card: string, html? }`; default `{ tier:1, card:"value" }`.
  - **tier 1** — a builtin data card (value / sparkline / fallback), fed by `job.data`.
  - **tier 2** — a **custom self-contained HTML** widget the model writes (`html`,
    required, `<= 256 KB`). See "Tier-2 HTML widgets" below.
- `placement` — `{ displayId?: number, corner?: "tl"|"tr"|"bl"|"br" }`.

## Tier-2 HTML widgets (custom viz)

For a chart/visualization the builtin cards don't cover, set
`render: { tier: 2, card: "html", html: "<…>" }`. The `html` is a page the model
writes; **the data pipeline is unchanged** (same `fetch`/`agent` refresh) — tier 2
only replaces the render.

**Runtime contract.** The page is wrapped by the app before display: a trusted
`window.Alfred` runtime is injected *before* your markup. Use it — do **not** add
external libraries or your own `<script src>` (there is no network; see below).

- `Alfred.onData(cb)` — registers `cb`; it fires on **every** refresh with the
  job's latest value (the extracted `fetch` value or the `agent` result). Seeded
  with `runtime.lastResult` on load.
- `Alfred.sparkline(el, numberArray)` — draws a minimal inline-SVG line chart of a
  numeric array into `el`. No dependency.

Minimal example:

```json
{
  "op": "create", "title": "Temp trend", "kind": "fetch",
  "schedule": { "type": "interval", "everyMs": 300000 },
  "source": { "url": "https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14&hourly=temperature_2m", "extract": "hourly.temperature_2m" },
  "render": {
    "tier": 2, "card": "html",
    "html": "<style>body{margin:0;color:#35e5ff;font:14px system-ui}</style><div id=\"c\"></div><script>Alfred.onData(function(v){Alfred.sparkline(document.getElementById('c'), v)})</script>"
  }
}
```

### Security (sandbox / CSP / offline)

The page is treated as **untrusted** and confined so a malicious or
prompt-injected page can only draw junk in its own card:

- Rendered as the `srcdoc` of `<iframe sandbox="allow-scripts">` — **no**
  `allow-same-origin` (opaque origin: no access to the parent DOM, cookies, or
  storage), no `allow-popups`/`allow-forms`/`allow-top-navigation`.
- The wrapper injects, **first** in a `<head>` the model can't precede, a strict
  CSP: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`.
  **Zero network** — no `fetch`/XHR/WebSocket, no external script/style/font. A CSP
  the model tries to add can only *intersect* (further restrict), never relax ours.
- Data enters **one way**, by `postMessage` from the parent card into the frame —
  no IPC/preload channel is ever exposed to the page. The trusted **runner**
  (server-side) does all external fetching; the page never does.

## `list` / result summary (per job)
`{ id, title, kind, schedule, enabled, pausedReason, tokensToday,
tokenBudgetDaily, lastRunTs, nextRunTs, lastResult }` plus `source` (fetch) or
`grant`+`prompt` (agent).

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
