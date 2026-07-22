# ui_layout

Inspect and rearrange your own floating control-centre cards. Reads/writes the
**same** layout store the user's drags use, so `get_layout` always reflects the
latest manual placement. Source: tool `src/main/tools/uiLayout.ts`, logic
`src/main/core/layout.ts`. **Risk T1 — no approval.**

## Ops
| op | args | does |
|----|------|------|
| `get_layout` | — | list every card `{ id, title, x, y, w, h, visible }` + the canvas `viewport { w, h }` |
| `move_card` | `id`, `x`, `y` | reposition (pixels from canvas top-left) |
| `resize_card` | `id`, `w`, `h` | resize |
| `show_card` | `id` | make visible |
| `hide_card` | `id` | hide |
| `arrange` / `tile` | — | tidy every card into a clean responsive grid that fits the window (rescues off-screen/hidden cards) |
| `reset` | — | restore first-run default positions |

## Cards
Canonical ids: `conversation`, `surface`, `brains`, `cost`, `projects`,
`accounts`, `activity`.

## Behaviour & limits
- **Call `get_layout` first** — the user drags cards too, so positions change.
- Coordinates are pixels relative to the canvas whose `w`/`h` `get_layout`
  reports. Moves/resizes are **clamped on-screen**: minimum size 220×120, and a
  card always keeps ≥60 px (plus its header) inside the canvas — you cannot push
  a card fully out of view.
- An unknown `id`, or a mutating op missing `id`, → `{ ok:false, error }`.
- Every mutation emits a `layout` stream event so the UI updates live.

## Examples
```json
{ "op": "get_layout" }
{ "op": "move_card", "id": "cost", "x": 900, "y": 120 }
{ "op": "arrange" }
```
