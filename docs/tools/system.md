# system

See and control the Mac. **One `op` per call.** Prefer these calm status/control
ops over synthetic mouse/keyboard events. Source: `src/main/tools/system.ts`.

## Ops, args, output
| op | args | output | risk |
|----|------|--------|------|
| `battery` | — | `{ percent, charging, timeRemaining }` | T0 |
| `volume_get` | — | `{ volume, muted }` | T0 |
| `volume_set` | `value` 0-100 **or** `mute` bool | `{ volume }` / `{ muted }` | T1 |
| `brightness_get` | — | `{ brightness 0-1, percent }` | T0 |
| `brightness_set` | `value` 0.0-1.0 | `{ brightness }` | T1 |
| `displays` | — | `{ displays: [{ name, resolution, main }] }` | T0 |
| `wifi` | — | `{ ssid, on }` | T0 |
| `apps_running` | — | `{ apps: [name…] }` | T0 |
| `app_frontmost` | — | `{ app }` | T0 |
| `app_open` | `name` **or** `url` | `{ opened }` | T1 |
| `app_quit` | `name` | `{ quit }` | **T2** |
| `notify` | `title`, `body` | `{ title, body }` | T1 |
| `clipboard_read` | — | `{ text }` | T0 |
| `clipboard_write` | `text` | `{ bytes }` | T1 |
| `caffeinate` | `stop` bool, `seconds` | `{ caffeinating, seconds? }` | T1 |
| `lock` | — | `{ locked: true }` | **T2** |
| `sleep` | — | `{ sleeping: true }` | **T2** |
| `screenshot` | `path` | `{ path }` | T1 |

`value` is clamped: volume 0-100, brightness 0-1. `caffeinate` holds **one**
keep-awake at a time (module-global); `stop:true` releases it. `screenshot`
default path is a timestamped PNG in the workspace.

## macOS permissions (TCC) & optional CLI
Ops return a **clear error, never a crash**, when a permission or tool is missing:
- `app_quit`, `app_frontmost`, `sleep`, and the `apps_running` fallback use
  AppleScript → need **Automation** permission. The error names it and how to fix.
- `screenshot` uses `screencapture` → needs **Screen Recording** permission.
- `brightness_get`/`brightness_set` need the `brightness` CLI
  (`brew install brightness`); missing → an install hint.
- `battery` falls back to IOKit when `pmset` yields nothing; returns an error on
  a desktop Mac with no battery.
- `apps_running` tries `lsappinfo` (no TCC) first, then a System Events fallback.

## Examples
```json
{ "op": "battery" }
{ "op": "volume_set", "mute": true }
{ "op": "brightness_set", "value": 0.6 }
{ "op": "notify", "title": "Build done", "body": "Tests green." }
{ "op": "caffeinate", "seconds": 3600 }
```
