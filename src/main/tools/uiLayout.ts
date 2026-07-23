/**
 * ui_layout — lets Alfred inspect and rearrange the floating control-centre
 * cards. Reads/writes the SAME layout store the user's drags use (core/layout),
 * so get_layout always reflects the user's latest manual placement, and moves
 * Alfred makes reach the UI via the 'layout' stream event.
 *
 * Registered in the shared tool set (tools/index.ts), so it is available to
 * every AI-SDK brain the orchestrator drives.
 *
 * Risk T1: UI-only, reversible, no approval.
 */
import { screen } from 'electron';
import type { Tool } from './types.ts';
import type { CardLayout, DisplayGeom } from '../core/types.ts';
import { getLayout, updateCard, arrangeLayout, resetLayout, resolveMoveTarget, type Bounds } from '../core/layout.ts';
import { getSetting } from '../core/db.ts';

interface Args {
  op: 'get_layout' | 'move_card' | 'resize_card' | 'show_card' | 'hide_card' | 'arrange' | 'tile' | 'reset';
  id?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** move_card only: target monitor id (from get_layout.displays) or 'main'/'all'. */
  displayId?: string;
}

/** Drop z from the cards handed to the model — it's an internal stacking detail. */
const view = (cards: CardLayout[]) => cards.map(({ z: _z, ...c }) => c);

/** Live canvas size the renderer last reported; a safe default before it does. */
function viewport(db: import('better-sqlite3').Database): Bounds {
  const m = getSetting(db, 'viewport')?.match(/^(\d+)x(\d+)$/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1280, h: 800 };
}

/** Every physical display with its DIP coordinate spaces (empty off-Electron). */
function listDisplays(): DisplayGeom[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    label: d.label || `Display ${d.id}`,
    primary: d.id === primaryId,
    bounds: d.bounds,
    workArea: d.workArea,
  }));
}

const COORDS_NOTE =
  "x/y are DIPs relative to the top-left of the card's display workArea; each display has its own " +
  'coordinate space (see displays[].bounds/workArea). move_card {displayId} moves a card to another monitor.';

export const uiLayout: Tool<Args> = {
  name: 'ui_layout',
  description:
    'Inspect and rearrange your own floating control-centre cards across every monitor. ops: ' +
    'get_layout (list every card with id, title, kind, x, y, w, h, visible, displayId, plus a displays[] array of ' +
    'ALL monitors — {id, label, primary, bounds, workArea} in DIPs — so you see each screen and its coordinate space). ' +
    'kind is "panel" for a fixed built-in card or "widget" for a scheduled-JOB data card (id "widget:<jobId>", title = the ' +
    "job's title): a job's own live data widget is a SEPARATE card from the \"SCHEDULED TASKS\" panel (kind:panel, id:jobs), " +
    'and move_card/resize_card/show_card/hide_card move and arrange these widgets exactly like any panel. ops continue: ' +
    'move_card {id, x, y, displayId?} (omit displayId to move within the current monitor; pass a displays[].id — or ' +
    '"main"/"all" — to move the card to that monitor), resize_card {id, w, h}, show_card {id}, hide_card {id}, ' +
    'arrange/tile (organise every card into a clean grid that fits the window), reset (restore defaults). ' +
    'x/y are DIPs relative to the top-left of the card display workArea; moves are clamped to the target display. ' +
    'The user can also drag cards and move them between monitors, so call get_layout first.',
  inputSchema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['get_layout', 'move_card', 'resize_card', 'show_card', 'hide_card', 'arrange', 'tile', 'reset'],
      },
      id: { type: 'string', description: 'Card id — a panel (e.g. conversation, surface, cost, jobs) or a job widget "widget:<jobId>" (from get_layout).' },
      x: { type: 'number' },
      y: { type: 'number' },
      w: { type: 'number' },
      h: { type: 'number' },
      displayId: {
        type: 'string',
        description:
          'move_card only. Target monitor: a displays[].id from get_layout, or "main" (primary) / "all" (mirror on every monitor). Omit to keep the card on its current monitor.',
      },
    },
    required: ['op'],
  },

  risk: () => 'T1',

  async execute(a, ctx) {
    const bounds = viewport(ctx.db);
    const displays = listDisplays();

    if (a.op === 'get_layout') {
      return { ok: true, result: { cards: view(getLayout(ctx.db)), viewport: bounds, displays, note: COORDS_NOTE } };
    }

    if (a.op === 'arrange' || a.op === 'tile') {
      const cards = arrangeLayout(ctx.db, bounds);
      ctx.emit({ kind: 'layout', cards });
      return { ok: true, result: { cards: view(cards), viewport: bounds, displays } };
    }

    if (a.op === 'reset') {
      const cards = resetLayout(ctx.db, bounds);
      ctx.emit({ kind: 'layout', cards });
      return { ok: true, result: { cards: view(cards), viewport: bounds, displays } };
    }

    if (!a.id) return { ok: false, error: 'id is required for this op' };
    const card = getLayout(ctx.db).find((c) => c.id === a.id);
    if (!card) return { ok: false, error: `Unknown card "${a.id}"` };

    let cards: CardLayout[];
    switch (a.op) {
      case 'move_card': {
        // Resolve the target monitor: onto another display when displayId is
        // given, else within the card's current display. Clamp to THAT display's
        // canvas so a cross-monitor move can't land off-screen.
        const target = resolveMoveTarget(a.displayId, card.displayId, displays);
        if ('error' in target) return { ok: false, error: target.error };
        const box: Bounds = target.display
          ? { w: target.display.bounds.width, h: target.display.bounds.height }
          : bounds;
        cards = updateCard(ctx.db, a.id, { x: a.x, y: a.y, displayId: target.displayId }, box);
        break;
      }
      case 'resize_card':
        cards = updateCard(ctx.db, a.id, { w: a.w, h: a.h }, bounds);
        break;
      case 'show_card':
        cards = updateCard(ctx.db, a.id, { visible: true }, bounds);
        break;
      case 'hide_card':
        cards = updateCard(ctx.db, a.id, { visible: false }, bounds);
        break;
      default:
        return { ok: false, error: `Unknown op "${a.op}"` };
    }
    ctx.emit({ kind: 'layout', cards });
    return { ok: true, result: { cards: view(cards), viewport: bounds, displays } };
  },
};
