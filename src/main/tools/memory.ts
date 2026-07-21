import type { Tool } from './types.ts';
// Logic + file layout live in core/memory.ts (Layer 3 stable = human-curated, Layer 4 = per-session notes).
import { readStable, appendWorking } from '../core/memory.ts';

type Op = 'read' | 'append';
interface Args {
  op: Op;
  text?: string;
}

export const memory: Tool<Args> = {
  name: 'memory',
  description:
    'Long-term memory. read: load the stable human-curated memory (preferences + house rules). ' +
    'append: add a note to this session’s working notes (Layer 4). ' +
    'Never edit the stable layer directly — that is curated by the human.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['read', 'append'] },
      text: { type: 'string', description: 'op=append: the note to record.' },
    },
    required: ['op'],
  },

  // Reading is autopilot; appending a session note is a reversible workspace write.
  risk: (a) => (a.op === 'append' ? 'T1' : 'T0'),

  async execute(a, ctx) {
    try {
      if (a.op === 'read') {
        return { ok: true, result: await readStable(ctx.workspace) };
      }
      if (a.op === 'append') {
        if (!a.text) return { ok: false, error: 'text is required for append' };
        await appendWorking(ctx.workspace, ctx.sessionId, a.text);
        return { ok: true, result: { appended: true } };
      }
      return { ok: false, error: `Unknown op: ${(a as Args).op}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
