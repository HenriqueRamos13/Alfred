/**
 * ui_layout — lets Alfred inspect and rearrange the floating control-centre
 * cards. Reads/writes the SAME layout store the user's drags use (core/layout),
 * so get_layout always reflects the user's latest manual placement, and moves
 * Alfred makes reach the UI via the 'layout' stream event.
 *
 * Risk T1: UI-only, reversible, no approval.
 */
import type { Tool } from './types.ts';
import type { CardLayout } from '../core/types.ts';
import { getLayout, updateCard } from '../core/layout.ts';

interface Args {
  op: 'get_layout' | 'move_card' | 'resize_card' | 'show_card' | 'hide_card';
  id?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** Drop z from the cards handed to the model — it's an internal stacking detail. */
const view = (cards: CardLayout[]) => cards.map(({ z: _z, ...c }) => c);

export const uiLayout: Tool<Args> = {
  name: 'ui_layout',
  description:
    'Inspect and rearrange your own floating control-centre cards. ops: ' +
    'get_layout (list every card with id, title, x, y, w, h, visible), ' +
    'move_card {id, x, y}, resize_card {id, w, h}, show_card {id}, hide_card {id}. ' +
    'Coordinates are pixels from the top-left of the overlay; the user can also drag ' +
    'cards, so call get_layout first to see where things currently are.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['get_layout', 'move_card', 'resize_card', 'show_card', 'hide_card'] },
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
    if (a.op === 'get_layout') {
      return { ok: true, result: { cards: view(getLayout(ctx.db)) } };
    }

    if (!a.id) return { ok: false, error: 'id is required for this op' };
    if (!getLayout(ctx.db).some((c) => c.id === a.id)) {
      return { ok: false, error: `Unknown card "${a.id}"` };
    }

    let cards: CardLayout[];
    switch (a.op) {
      case 'move_card':
        cards = updateCard(ctx.db, a.id, { x: a.x, y: a.y });
        break;
      case 'resize_card':
        cards = updateCard(ctx.db, a.id, { w: a.w, h: a.h });
        break;
      case 'show_card':
        cards = updateCard(ctx.db, a.id, { visible: true });
        break;
      case 'hide_card':
        cards = updateCard(ctx.db, a.id, { visible: false });
        break;
      default:
        return { ok: false, error: `Unknown op "${a.op}"` };
    }
    ctx.emit({ kind: 'layout', cards });
    return { ok: true, result: { cards: view(cards) } };
  },
};
