# ui_layout

Inspect and rearrange your own floating control-centre cards. Reads/writes the
**same** layout store the user's drags use, so `get_layout` always reflects the
latest manual placement. Source: tool `src/main/tools/uiLayout.ts`, logic
`src/main/core/layout.ts`. **Risk T1 — no approval.**

## Ops
| op | args | does |
|----|------|------|
| `get_layout` | — | list every card `{ id, title, x, y, w, h, visible, displayId }` + the canvas `viewport { w, h }` + a `displays[]` array of **every monitor** `{ id, label, primary, bounds, workArea }` (DIPs) |
| `move_card` | `id`, `x`, `y`, `displayId?` | reposition. Omit `displayId` to move within the card's current monitor; pass a `displays[].id` (or `main`/`all`) to move the card **to that monitor** |
| `resize_card` | `id`, `w`, `h` | resize |
| `show_card` | `id` | make visible |
| `hide_card` | `id` | hide |
| `arrange` / `tile` | — | tidy every card into a clean responsive grid that fits the window (rescues off-screen/hidden cards) |
| `reset` | — | restore first-run default positions |

## Cards
Canonical ids: `conversation`, `surface`, `brains`, `cost`, `projects`,
`accounts`, `activity`.

## Multi-monitor
In overlay mode Alfred runs **one click-through HUD per display** and each card
carries a `displayId`: a concrete display id, or the sentinel `main` (the primary
display) / `all` (mirrored on every display). `x`/`y` are DIPs relative to the
top-left of that card's display **workArea**; each display has its own coordinate
space.

`get_layout` returns a `displays[]` array so you can see **every** monitor, not
just the primary: `{ id, label, primary, bounds:{x,y,width,height},
workArea:{...} }` (DIPs; `workArea` excludes the menu bar / dock). To move a card
**to another monitor**, call `move_card` with the target `displayId` (a
`displays[].id`, or `main`/`all`) plus the `x`/`y` for that monitor — the card is
reassigned to that display and clamped to **its** bounds. Omit `displayId` and the
move stays on the card's current monitor (previous behaviour). An unknown
requested `displayId` returns an error; a card on an unplugged monitor falls back
to the primary automatically. The user can also drag cards and use the "move to
next monitor" control, so `get_layout` first.

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
{ "op": "move_card", "id": "cost", "x": 200, "y": 200, "displayId": "69731760" }
{ "op": "arrange" }
```

The third call moves the `cost` card onto the monitor whose `id` is `69731760`
(as reported in `get_layout.displays`), placing it at 200,200 on that screen.
