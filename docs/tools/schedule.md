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
| `edit` | `id`, + any create field | `{ job, nextRun }` | **T2** |

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
- `render` — `{ tier: 1|2|3, card: string }`; default `{ tier:1, card:"value" }`.
- `placement` — `{ displayId?: number, corner?: "tl"|"tr"|"bl"|"br" }`.

## `list` / result summary (per job)
`{ id, title, kind, schedule, enabled, pausedReason, tokensToday,
tokenBudgetDaily, lastRunTs, nextRunTs, lastResult }` plus `source` (fetch) or
`grant`+`prompt` (agent).

`pause` disables the job (`enabled:false`); `resume` re-enables it **and** clears
any auto-pause reason (`budget`/`error`), then re-arms. `edit` re-validates the
whole spec exactly like `create`.

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
