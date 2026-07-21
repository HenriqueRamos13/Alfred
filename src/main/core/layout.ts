/**
 * Floating-card layout store — the single source of truth for where each
 * control-centre card sits. Both the user (drags/resizes via IPC) and Alfred
 * (the `ui_layout` tool) read and write this same SQLite-backed store, so a
 * move from either side is reflected on the next read from the other.
 *
 * Geometry + visibility live in the `layout` table (see db.ts). `title` is a
 * fixed per-card label owned here (never persisted), so the renderer and the AI
 * see human-readable names without a schema column.
 */
import type { AlfredDb } from './db.ts';
import type { CardLayout, CardPatch } from './types.ts';

const MIN_W = 220;
const MIN_H = 120;

/** Fixed labels; the set of keys is also the canonical list of cards. */
const CARD_TITLES: Record<string, string> = {
  conversation: 'CONVERSATION',
  surface: 'GENERATIVE SURFACE',
  brains: 'BRAINS',
  cost: 'COST',
  projects: 'PROJECTS',
  activity: 'ACTIVITY',
};

/** First-run positions (px from the overlay's top-left). [id, x, y, w, h]. */
const DEFAULTS: ReadonlyArray<readonly [string, number, number, number, number]> = [
  ['conversation', 24, 118, 430, 440],
  ['activity', 24, 570, 430, 300],
  ['surface', 470, 118, 640, 752],
  ['cost', 1126, 118, 300, 240],
  ['brains', 1126, 368, 300, 210],
  ['projects', 1126, 588, 300, 282],
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
}

/**
 * Read the full layout. Idempotently seeds any missing default card (covers
 * both first run and cards added in a later build), then returns every known
 * card sorted back-to-front by z.
 */
export function getLayout(db: AlfredDb): CardLayout[] {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO layout(cardId, x, y, w, h, z, visible) VALUES (?, ?, ?, ?, ?, ?, 1)',
  );
  DEFAULTS.forEach(([id, x, y, w, h], i) => insert.run(id, x, y, w, h, i + 1));

  const rows = db.prepare('SELECT cardId AS id, x, y, w, h, z, visible FROM layout').all() as Row[];
  return rows
    .filter((r) => CARD_TITLES[r.id]) // drop stale rows for cards no longer shipped
    .map((r) => ({ ...r, title: CARD_TITLES[r.id], visible: r.visible !== 0 }))
    .sort((a, b) => a.z - b.z);
}

/**
 * Patch one card (any subset of x/y/w/h/z/visible), clamp to sane bounds, and
 * return the full updated layout. Unknown card id is a no-op.
 */
export function updateCard(db: AlfredDb, id: string, patch: CardPatch): CardLayout[] {
  const cur = getLayout(db).find((c) => c.id === id);
  if (!cur) return getLayout(db);

  const next = {
    x: clampPos(patch.x ?? cur.x),
    y: clampPos(patch.y ?? cur.y),
    w: Math.max(MIN_W, Math.round(patch.w ?? cur.w)),
    h: Math.max(MIN_H, Math.round(patch.h ?? cur.h)),
    z: Math.round(patch.z ?? cur.z),
    visible: (patch.visible ?? cur.visible) ? 1 : 0,
  };
  db.prepare('UPDATE layout SET x=?, y=?, w=?, h=?, z=?, visible=? WHERE cardId=?').run(
    next.x,
    next.y,
    next.w,
    next.h,
    next.z,
    next.visible,
    id,
  );
  return getLayout(db);
}
