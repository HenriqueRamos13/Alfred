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
import type { CardLayout, CardPatch } from './types.ts';

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

/** Keep at least this much of a card on-screen when clamping. */
const MIN_VISIBLE = 60;
/** Keep at least the header row reachable when clamping vertically. */
const HEADER_H = 44;
/** Gutter used by the responsive tiler. */
const GAP = 16;

export interface Bounds {
  w: number;
  h: number;
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
  const x = Math.min(Math.max(0, Math.round(box.x)), Math.max(0, Math.round(bounds.w) - MIN_VISIBLE));
  const y = Math.min(Math.max(0, Math.round(box.y)), Math.max(0, Math.round(bounds.h) - HEADER_H));
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
  const cols = Math.max(1, Math.min(n, Math.floor(bounds.w / 360) || 1));
  const rows = Math.ceil(n / cols);
  const tileW = Math.max(MIN_W, Math.floor((bounds.w - GAP * (cols + 1)) / cols));
  const tileH = Math.max(MIN_H, Math.floor((bounds.h - GAP * (rows + 1)) / rows));
  return ids.map((_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { x: GAP + col * (tileW + GAP), y: GAP + row * (tileH + GAP), w: tileW, h: tileH };
  });
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
};

/** First-run positions (px from the canvas top-left). [id, x, y, w, h]. */
const DEFAULTS: ReadonlyArray<readonly [string, number, number, number, number]> = [
  ['conversation', 24, 118, 430, 440],
  ['activity', 24, 570, 430, 300],
  ['surface', 470, 118, 640, 752],
  ['cost', 1126, 118, 300, 240],
  ['brains', 1126, 368, 300, 210],
  ['accounts', 1126, 588, 300, 160],
  ['projects', 1126, 758, 300, 200],
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
 * Read the full layout. Idempotently seeds any missing default card (covers
 * both first run and cards added in a later build), then returns every known
 * card sorted back-to-front by z.
 */
export function getLayout(db: AlfredDb): CardLayout[] {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO layout(cardId, x, y, w, h, z, visible, displayId) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
  );
  // Defaults distribute every card onto the primary display (the 'main' sentinel).
  DEFAULTS.forEach(([id, x, y, w, h], i) => insert.run(id, x, y, w, h, i + 1, DISPLAY_MAIN));

  const rows = db.prepare('SELECT cardId AS id, x, y, w, h, z, visible, displayId FROM layout').all() as Row[];
  return rows
    .filter((r) => CARD_TITLES[r.id]) // drop stale rows for cards no longer shipped
    .map((r) => ({ ...r, title: CARD_TITLES[r.id], visible: r.visible !== 0 }))
    .sort((a, b) => a.z - b.z);
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
