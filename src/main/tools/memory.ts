import type { Tool } from './types.ts';
// Logic + file layout live in core/memory.ts.
//   Layer 3 stable = human-curated (read); Layer 4 = per-session notes (append).
//   Long-term = episodic journal + semantic facts (remember / recall / list).
import { readStable, appendWorking, remember, recall, listMemory } from '../core/memory.ts';

type Op = 'read' | 'append' | 'remember' | 'recall' | 'list';
interface Args {
  op: Op;
  text?: string;
  kind?: 'episodic' | 'semantic';
  query?: string;
  sinceDays?: number;
}

export const memory: Tool<Args> = {
  name: 'memory',
  description:
    'Long-term memory. ' +
    'read: load the stable human-curated memory (preferences + house rules). ' +
    'append: add a note to this session’s working notes (Layer 4). ' +
    'remember: durably save something — kind:"episodic" (default) logs a dated event to the journal; ' +
    'kind:"semantic" records an enduring fact. Save important facts/events proactively. ' +
    'recall: look back over recent memory — query greps the journal+facts, sinceDays limits how far back (default 7). ' +
    'list: show which memory days/files exist. ' +
    'Never edit the stable layer directly — that is curated by the human. Never invent memories.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['read', 'append', 'remember', 'recall', 'list'] },
      text: { type: 'string', description: 'op=append/remember: the note or fact to record.' },
      kind: {
        type: 'string',
        enum: ['episodic', 'semantic'],
        description: 'op=remember: episodic (dated event, default) or semantic (durable fact).',
      },
      query: { type: 'string', description: 'op=recall: optional text to grep for in the journal + facts.' },
      sinceDays: { type: 'integer', description: 'op=recall: how many days back to read (default 7).' },
    },
    required: ['op'],
  },

  // Reads are autopilot; writes are reversible workspace appends.
  risk: (a) => (a.op === 'read' || a.op === 'recall' || a.op === 'list' ? 'T0' : 'T1'),

  async execute(a, ctx) {
    try {
      switch (a.op) {
        case 'read':
          return { ok: true, result: await readStable(ctx.workspace) };
        case 'append':
          if (!a.text) return { ok: false, error: 'text is required for append' };
          await appendWorking(ctx.workspace, ctx.sessionId, a.text);
          return { ok: true, result: { appended: true } };
        case 'remember':
          if (!a.text) return { ok: false, error: 'text is required for remember' };
          return { ok: true, result: await remember(ctx.workspace, a.text, a.kind ?? 'episodic') };
        case 'recall':
          return { ok: true, result: await recall(ctx.workspace, { query: a.query, sinceDays: a.sinceDays }) };
        case 'list':
          return { ok: true, result: await listMemory(ctx.workspace) };
        default:
          return { ok: false, error: `Unknown op: ${(a as Args).op}` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
