/**
 * Floating-card layout store — the single source of truth for where each
 * control-centre card sits. Both the user (drags/resizes via IPC) and Alfred
 * (the `ui_layout` tool) read and write this same SQLite-backed store, so a
 * move from either side is reflected on the next read from the other.
 *
 * Geometry + visibility live in the `layout` table (see db.ts). `title` is a
 * fixed per-card label owned here (never persisted), so the renderer and the AI
 * see human-readable names without a schema column.
 *
 * The pure geometry helpers (clampBox, tileLayout) carry no DB dependency and
 * are imported by the renderer too, so a card can never be placed off-screen
 * regardless of what the store or the AI wrote.
 */
import type { AlfredDb } from './db.ts';
import type { CardLayout, CardPatch, DisplayGeom } from './types.ts';

export const MIN_W = 220;
export const MIN_H = 120;

/** displayId sentinels: a card can pin to a concrete `display.id`, or follow one of these. */
export const DISPLAY_MAIN = 'main'; // shown on the primary display
export const DISPLAY_ALL = 'all'; // mirrored on every display

/**
 * Does a card belong on the renderer showing `myDisplayId`? Pure so both the
 * per-display renderer filter and the tests use identical logic. When
 * `myDisplayId` is empty (windowed / single-window fallback) every card shows —
 * there is only one canvas to filter into.
 */
export function cardOnDisplay(cardDisplayId: string, myDisplayId: string, isPrimary: boolean): boolean {
  if (!myDisplayId) return true;
  if (cardDisplayId === DISPLAY_ALL) return true;
  if (cardDisplayId === DISPLAY_MAIN) return isPrimary;
  return cardDisplayId === myDisplayId;
}

/**
 * Resolve a card's displayId against the displays currently present: a card
 * pinned to a concrete display that is gone falls back to the primary
 * (`'main'`). Sentinels pass through unchanged. Used on display-removed and
 * defensively at read time.
 */
export function resolveCardDisplay(cardDisplayId: string, presentIds: readonly string[]): string {
  if (cardDisplayId === DISPLAY_ALL || cardDisplayId === DISPLAY_MAIN) return cardDisplayId;
  return presentIds.includes(cardDisplayId) ? cardDisplayId : DISPLAY_MAIN;
}

/**
 * The next physical display to cycle a card onto, wrapping around. `current`
 * may be a concrete display id or a sentinel — the primary display's id stands
 * in for 'main'. Returns undefined when there is nowhere to move (< 2 displays)
 * or an unknown current id lands at the start. Pure so the header ⇄ control and
 * the tests share one definition of "next monitor".
 */
export function nextDisplayId(
  current: string,
  displays: readonly { id: string; primary: boolean }[],
): string | undefined {
  if (displays.length < 2) return undefined;
  const resolved = current === DISPLAY_MAIN ? displays.find((d) => d.primary)?.id : current;
  const i = displays.findIndex((d) => d.id === resolved);
  return displays[(Math.max(0, i) + 1) % displays.length].id;
}

/**
 * The display a card currently lives on. Sentinels ('main'/'all') and stale
 * concrete ids resolve to the primary. Pure so the ui_layout tool and the tests
 * agree on which monitor's canvas a card is clamped into. Undefined only when no
 * displays are known (single-window fallback).
 */
export function displayForCard(
  cardDisplayId: string,
  displays: readonly DisplayGeom[],
): DisplayGeom | undefined {
  if (displays.length === 0) return undefined;
  const primary = displays.find((d) => d.primary) ?? displays[0];
  if (cardDisplayId === DISPLAY_MAIN || cardDisplayId === DISPLAY_ALL) return primary;
  return displays.find((d) => d.id === cardDisplayId) ?? primary;
}

/**
 * Resolve a move_card target: which concrete `displayId` to persist on the card
 * and which display's canvas to clamp its x/y into. `requested` is the tool's
 * optional displayId arg (concrete id, 'main', or 'all'); when omitted the card
 * stays on its current display. An explicitly-requested unknown id is an error
 * (the AI should call get_layout for the valid list); a *stale current* id
 * silently falls back to the primary. Pure + unit-tested.
 */
export function resolveMoveTarget(
  requested: string | undefined,
  currentDisplayId: string,
  displays: readonly DisplayGeom[],
): { displayId: string; display?: DisplayGeom } | { error: string } {
  if (displays.length === 0) return { displayId: requested ?? currentDisplayId };
  if (requested === undefined) {
    return { displayId: currentDisplayId, display: displayForCard(currentDisplayId, displays) };
  }
  if (requested === DISPLAY_MAIN || requested === DISPLAY_ALL) {
    return { displayId: requested, display: displays.find((d) => d.primary) ?? displays[0] };
  }
  const d = displays.find((x) => x.id === requested);
  if (!d) {
    return { error: `Unknown displayId "${requested}". Call get_layout to see the available displays.` };
  }
  return { displayId: requested, display: d };
}

/** Keep at least this much of a card on-screen when clamping. */
const MIN_VISIBLE = 60;
/** Keep at least the header row reachable when clamping vertically. */
const HEADER_H = 44;
/** Gutter used by the responsive tiler. */
const GAP = 16;

/**
 * Reserved top band (px) that cards never occupy — the macOS menu-bar safe-area
 * (clock/battery stay visible above it). ~32 by default; override with
 * ALFRED_TOP_INSET. Guarded for the renderer bundle, where `process` may be
 * absent. Fed into the layout `bounds.top`, so clamp/tile/widget all honour it.
 */
export const TOP_INSET = ((): number => {
  const raw = typeof process !== 'undefined' ? process.env?.ALFRED_TOP_INSET : undefined;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 32;
})();

export interface Bounds {
  w: number;
  h: number;
  /** Reserved top inset (px); cards never sit above it. Absent/0 → no reservation. */
  top?: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Clamp a card box into the canvas: size never exceeds the canvas, and the card
 * always keeps at least MIN_VISIBLE px (and its header) inside. Pure + rounded,
 * so both the drag handler and the store produce identical, on-screen geometry.
 */
export function clampBox(box: Box, bounds: Bounds): Box {
  const w = Math.min(Math.max(MIN_W, Math.round(box.w)), Math.max(MIN_W, Math.round(bounds.w)));
  const h = Math.min(Math.max(MIN_H, Math.round(box.h)), Math.max(MIN_H, Math.round(bounds.h)));
  const top = Math.max(0, Math.round(bounds.top ?? 0));
  const x = Math.min(Math.max(0, Math.round(box.x)), Math.max(0, Math.round(bounds.w) - MIN_VISIBLE));
  const y = Math.min(Math.max(top, Math.round(box.y)), Math.max(top, Math.round(bounds.h) - HEADER_H));
  return { x, y, w, h };
}

/**
 * Lay `ids` out in a clean responsive grid that fits `bounds`. Columns scale
 * with width; every tile respects the minimum card size. Returned boxes are in
 * the same order as `ids`.
 */
export function tileLayout(ids: readonly string[], bounds: Bounds): Box[] {
  const n = ids.length;
  if (n === 0) return [];
  const top = Math.max(0, Math.round(bounds.top ?? 0));
  const cols = Math.max(1, Math.min(n, Math.floor(bounds.w / 360) || 1));
  const rows = Math.ceil(n / cols);
  const tileW = Math.max(MIN_W, Math.floor((bounds.w - GAP * (cols + 1)) / cols));
  const tileH = Math.max(MIN_H, Math.floor((bounds.h - top - GAP * (rows + 1)) / rows));
  return ids.map((_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { x: GAP + col * (tileW + GAP), y: top + GAP + row * (tileH + GAP), w: tileW, h: tileH };
  });
}

/** Prefix marking a dynamic per-job data card: `widget:<jobId>`. */
export const WIDGET_PREFIX = 'widget:';
export function isWidgetId(id: string): boolean {
  return id.startsWith(WIDGET_PREFIX);
}

/**
 * First-placement box for a job's data widget from its placement corner, staggered
 * by `idx` so several widgets don't stack exactly. Pure + unit-tested; shared by
 * the widget registration (jobs.ts) — the renderer no longer positions widgets.
 */
export function widgetBox(corner: string | undefined, idx: number, b: Bounds): Box {
  const W = 220;
  const H = 160;
  const m = 24;
  const off = idx * (H + 12);
  const c = corner ?? 'tr';
  const left = c[1] === 'l';
  const top = c[0] === 't';
  const inset = Math.max(0, Math.round(b.top ?? 0));
  const x = left ? m : Math.max(m, b.w - W - m);
  // Top corners clear the reserved inset + the ~118px command strip; stagger down
  // (top) or up (bottom). Bottom corners never enter the inset (clamped below it).
  const y = top ? inset + 122 + off : Math.max(inset + 122, b.h - H - m - off);
  return { x, y, w: W, h: H };
}

/** Fixed labels; the set of keys is also the canonical list of cards. */
const CARD_TITLES: Record<string, string> = {
  conversation: 'CONVERSATION',
  surface: 'GENERATIVE SURFACE',
  brains: 'BRAINS',
  cost: 'COST',
  projects: 'PROJECTS',
  accounts: 'ACCOUNTS',
  activity: 'ACTIVITY',
  settings: 'SETTINGS',
  graph: 'KNOWLEDGE GRAPH',
  jobs: 'SCHEDULED TASKS',
  agents: 'AGENTS',
};

/** Cards that start hidden (opened from the top-bar), not shown on first run. */
const HIDDEN_DEFAULT = new Set<string>(['settings', 'graph', 'jobs', 'agents']);

/** First-run positions (px from the canvas top-left). [id, x, y, w, h]. */
const DEFAULTS: ReadonlyArray<readonly [string, number, number, number, number]> = [
  ['conversation', 24, 118, 430, 440],
  ['activity', 24, 570, 430, 300],
  ['surface', 470, 118, 640, 752],
  ['cost', 1126, 118, 300, 240],
  ['brains', 1126, 368, 300, 210],
  ['accounts', 1126, 588, 300, 160],
  ['projects', 1126, 758, 300, 200],
  ['settings', 300, 150, 560, 560],
  ['graph', 340, 150, 760, 580],
  ['jobs', 360, 150, 560, 560],
  ['agents', 380, 150, 560, 620],
];

const clampPos = (v: number): number => Math.max(0, Math.round(v));

interface Row {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  visible: number;
  displayId: string;
}

/**
 * Pure: resolve raw layout rows into titled cards. A PANEL row is titled from the
 * fixed CARD_TITLES; a WIDGET row (`widget:<jobId>`) is titled from `widgetTitles`
 * (the live job title). Rows that resolve to no title are dropped — stale panels
 * (a card no longer shipped) and orphan widgets (the job was deleted) — exactly
 * like the old stale-row filter. Sorted back-to-front by z. Unit-tested.
 */
export function mergeLayout(rows: readonly Row[], widgetTitles: Record<string, string>): CardLayout[] {
  return rows
    .map((r): CardLayout | null => {
      const base = { ...r, visible: r.visible !== 0 };
      if (isWidgetId(r.id)) {
        const title = widgetTitles[r.id];
        return title ? { ...base, title, kind: 'widget' } : null;
      }
      const title = CARD_TITLES[r.id];
      return title ? { ...base, title, kind: 'panel' } : null;
    })
    .filter((c): c is CardLayout => c !== null)
    .sort((a, b) => a.z - b.z);
}

/**
 * Panels (kind:"panel") for the header CARDS dropdown — job widgets (kind:"widget")
 * are excluded (managed in the Scheduled Tasks card). Hidden panels stay in the
 * list (that's how the menu offers to show them). Sorted by title so the menu is
 * stable regardless of z-order. Pure + unit-tested.
 */
export function panelCards(cards: readonly CardLayout[]): CardLayout[] {
  return cards.filter((c) => c.kind === 'panel').sort((a, b) => a.title.localeCompare(b.title));
}

/** Live job titles keyed by their widget card id, for getLayout's dynamic titling. */
function widgetTitles(db: AlfredDb): Record<string, string> {
  const out: Record<string, string> = {};
  for (const j of db.prepare('SELECT id, title FROM scheduled_jobs').all() as { id: string; title: string }[]) {
    out[`${WIDGET_PREFIX}${j.id}`] = j.title;
  }
  return out;
}

/**
 * Read the full layout. Idempotently seeds any missing default card (covers
 * both first run and cards added in a later build), then returns every known
 * card — fixed panels AND the dynamic per-job widgets (titled from the job,
 * orphans dropped) — sorted back-to-front by z.
 */
export function getLayout(db: AlfredDb): CardLayout[] {
  // Migrate a pre-1.12 saved layout: the old TEAM card is now the AGENTS card
  // (embedded cores + roster). Rename in place so the user's saved geometry
  // survives; OR IGNORE covers the (impossible-in-practice) both-exist case,
  // where the stale 'team' row is then dropped by mergeLayout.
  db.prepare("UPDATE OR IGNORE layout SET cardId='agents' WHERE cardId='team'").run();

  const insert = db.prepare(
    'INSERT OR IGNORE INTO layout(cardId, x, y, w, h, z, visible, displayId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // Defaults distribute every card onto the primary display (the 'main' sentinel);
  // cards in HIDDEN_DEFAULT seed hidden (opened from the top-bar).
  DEFAULTS.forEach(([id, x, y, w, h], i) =>
    insert.run(id, x, y, w, h, i + 1, HIDDEN_DEFAULT.has(id) ? 0 : 1, DISPLAY_MAIN),
  );

  const rows = db.prepare('SELECT cardId AS id, x, y, w, h, z, visible, displayId FROM layout').all() as Row[];
  return mergeLayout(rows, widgetTitles(db));
}

/**
 * Register a job's data widget as a first-class layout row `widget:<jobId>`.
 * INSERT OR IGNORE so a re-register (e.g. edit) never moves a widget the user
 * already dragged. `box` is the first-placement geometry (see widgetBox); it is
 * stacked on top (max z + 1). Called from jobs.createJob for tier-1/2 jobs.
 */
export function addWidgetCard(db: AlfredDb, jobId: string, box: Box, displayId: string): void {
  const z = (db.prepare('SELECT COALESCE(MAX(z), 0) + 1 AS z FROM layout').get() as { z: number }).z;
  db.prepare(
    'INSERT OR IGNORE INTO layout(cardId, x, y, w, h, z, visible, displayId) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
  ).run(`${WIDGET_PREFIX}${jobId}`, box.x, box.y, box.w, box.h, z, displayId);
}

/** Drop a job's widget row so no orphan survives the job. Called from jobs.deleteJob. */
export function removeWidgetCard(db: AlfredDb, jobId: string): void {
  db.prepare('DELETE FROM layout WHERE cardId = ?').run(`${WIDGET_PREFIX}${jobId}`);
}

/**
 * Patch one card (any subset of x/y/w/h/z/visible), clamp to sane bounds, and
 * return the full updated layout. When `bounds` (the live canvas size) is given
 * the geometry is additionally clamped on-screen, so neither a user drag nor an
 * AI move can push a card out of view. Unknown card id is a no-op.
 */
export function updateCard(db: AlfredDb, id: string, patch: CardPatch, bounds?: Bounds): CardLayout[] {
  const cur = getLayout(db).find((c) => c.id === id);
  if (!cur) return getLayout(db);

  let box: Box = {
    x: clampPos(patch.x ?? cur.x),
    y: clampPos(patch.y ?? cur.y),
    w: Math.max(MIN_W, Math.round(patch.w ?? cur.w)),
    h: Math.max(MIN_H, Math.round(patch.h ?? cur.h)),
  };
  if (bounds) box = clampBox(box, bounds);
  const z = Math.round(patch.z ?? cur.z);
  const visible = (patch.visible ?? cur.visible) ? 1 : 0;
  const displayId = patch.displayId ?? cur.displayId;

  db.prepare('UPDATE layout SET x=?, y=?, w=?, h=?, z=?, visible=?, displayId=? WHERE cardId=?').run(
    box.x,
    box.y,
    box.w,
    box.h,
    z,
    visible,
    displayId,
    id,
  );
  return getLayout(db);
}

/**
 * Reassign every card pinned to `removedDisplayId` back to the primary display
 * (the 'main' sentinel), so cards on an unplugged monitor reappear instead of
 * vanishing. Returns the full updated layout.
 */
export function reassignDisplayCards(db: AlfredDb, removedDisplayId: string): CardLayout[] {
  db.prepare('UPDATE layout SET displayId=? WHERE displayId=?').run(DISPLAY_MAIN, removedDisplayId);
  return getLayout(db);
}

/**
 * Reorganise every card (hidden ones become visible) into a clean responsive
 * grid fitted to `bounds` — the "organise everything" action, shared by the
 * toolbar button and the AI's ui_layout `arrange`. Rescues off-screen cards.
 */
export function arrangeLayout(db: AlfredDb, bounds: Bounds): CardLayout[] {
  const ids = getLayout(db).map((c) => c.id);
  const tiles = tileLayout(ids, bounds);
  const stmt = db.prepare('UPDATE layout SET x=?, y=?, w=?, h=?, visible=1 WHERE cardId=?');
  ids.forEach((id, i) => stmt.run(tiles[i].x, tiles[i].y, tiles[i].w, tiles[i].h, id));
  return getLayout(db);
}

/** Restore the first-run default positions (clamped to `bounds` when given). */
export function resetLayout(db: AlfredDb, bounds?: Bounds): CardLayout[] {
  const stmt = db.prepare('UPDATE layout SET x=?, y=?, w=?, h=?, visible=1 WHERE cardId=?');
  DEFAULTS.forEach(([id, x, y, w, h]) => {
    const box = bounds ? clampBox({ x, y, w, h }, bounds) : { x, y, w, h };
    stmt.run(box.x, box.y, box.w, box.h, id);
  });
  return getLayout(db);
}
