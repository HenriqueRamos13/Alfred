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
import type { Tool } from './types.ts';
import type { CardLayout } from '../core/types.ts';
import { getLayout, updateCard, arrangeLayout, resetLayout, type Bounds } from '../core/layout.ts';
import { getSetting } from '../core/db.ts';

interface Args {
  op: 'get_layout' | 'move_card' | 'resize_card' | 'show_card' | 'hide_card' | 'arrange' | 'tile' | 'reset';
  id?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** Drop z from the cards handed to the model — it's an internal stacking detail. */
const view = (cards: CardLayout[]) => cards.map(({ z: _z, ...c }) => c);

/** Live canvas size the renderer last reported; a safe default before it does. */
function viewport(db: import('better-sqlite3').Database): Bounds {
  const m = getSetting(db, 'viewport')?.match(/^(\d+)x(\d+)$/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1280, h: 800 };
}

export const uiLayout: Tool<Args> = {
  name: 'ui_layout',
  description:
    'Inspect and rearrange your own floating control-centre cards. ops: ' +
    'get_layout (list every card with id, title, x, y, w, h, visible, plus the canvas viewport size), ' +
    'move_card {id, x, y}, resize_card {id, w, h}, show_card {id}, hide_card {id}, ' +
    'arrange/tile (organise every card into a clean grid that fits the window), reset (restore defaults). ' +
    'Coordinates are pixels relative to the canvas whose width/height get_layout reports; moves are ' +
    'clamped on-screen. The user can also drag cards, so call get_layout first.',
  inputSchema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['get_layout', 'move_card', 'resize_card', 'show_card', 'hide_card', 'arrange', 'tile', 'reset'],
      },
      id: { type: 'string', description: 'Card id (e.g. conversation, surface, brains, cost, projects, activity).' },
      x: { type: 'number' },
      y: { type: 'number' },
      w: { type: 'number' },
      h: { type: 'number' },
    },
    required: ['op'],
  },

  risk: () => 'T1',

  async execute(a, ctx) {
    const bounds = viewport(ctx.db);

    if (a.op === 'get_layout') {
      return { ok: true, result: { cards: view(getLayout(ctx.db)), viewport: bounds } };
    }

    if (a.op === 'arrange' || a.op === 'tile') {
      const cards = arrangeLayout(ctx.db, bounds);
      ctx.emit({ kind: 'layout', cards });
      return { ok: true, result: { cards: view(cards), viewport: bounds } };
    }

    if (a.op === 'reset') {
      const cards = resetLayout(ctx.db, bounds);
      ctx.emit({ kind: 'layout', cards });
      return { ok: true, result: { cards: view(cards), viewport: bounds } };
    }

    if (!a.id) return { ok: false, error: 'id is required for this op' };
    if (!getLayout(ctx.db).some((c) => c.id === a.id)) {
      return { ok: false, error: `Unknown card "${a.id}"` };
    }

    let cards: CardLayout[];
    switch (a.op) {
      case 'move_card':
        cards = updateCard(ctx.db, a.id, { x: a.x, y: a.y }, bounds);
        break;
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
    return { ok: true, result: { cards: view(cards), viewport: bounds } };
  },
};
