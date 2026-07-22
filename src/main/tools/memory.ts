import type { Tool } from './types.ts';
// Logic + file layout live in core/memory.ts.
//   Layer 3 stable = human-curated (read); Layer 4 = per-session notes (append).
//   Long-term = episodic journal + semantic facts (remember / recall / list).
//   Vault = atomic notes (note) + inbox handoffs (handoff) — organised by the curator.
import {
  readStable,
  appendWorking,
  remember,
  recall,
  listMemory,
  writeNote,
  writeHandoff,
} from '../core/memory.ts';
import type { Observation, Relation } from '../core/memory.ts';

type Op = 'read' | 'append' | 'remember' | 'recall' | 'list' | 'note' | 'handoff';
interface Args {
  op: Op;
  text?: string;
  kind?: 'episodic' | 'semantic';
  query?: string;
  sinceDays?: number;
  // note
  title?: string;
  type?: string;
  tags?: string[];
  observations?: Observation[];
  relations?: Relation[];
  // handoff
  summary?: string;
  notePath?: string;
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
    'note: create/update an ATOMIC durable note (one idea) in the vault — title (required), type ' +
    '(note|project|person|tool|decision), tags[], observations[{category,text}] ' +
    '(category: decision|requirement|risk|gotcha|fact|tip), relations[{type,target}] where target is another note’s ' +
    'title as a [[wikilink]] (type e.g. part_of|uses|relates_to). Re-using a title merges into that note. ' +
    'handoff: after finishing a relevant task, drop a short summary (what you did + the note/file path) into the ' +
    'inbox for the curator to organise. ' +
    'Never edit the stable layer directly — that is curated by the human. Never invent memories.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['read', 'append', 'remember', 'recall', 'list', 'note', 'handoff'] },
      text: { type: 'string', description: 'op=append/remember: the note or fact to record.' },
      kind: {
        type: 'string',
        enum: ['episodic', 'semantic'],
        description: 'op=remember: episodic (dated event, default) or semantic (durable fact).',
      },
      query: { type: 'string', description: 'op=recall: optional text to grep for in the journal + facts.' },
      sinceDays: { type: 'integer', description: 'op=recall: how many days back to read (default 7).' },
      title: { type: 'string', description: 'op=note: note title (required); re-using a title merges into it.' },
      type: {
        type: 'string',
        description: 'op=note: note|project|person|tool|decision (default note).',
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'op=note: short tags for this note.' },
      observations: {
        type: 'array',
        description: 'op=note: atomic facts — {category, text}. category: decision|requirement|risk|gotcha|fact|tip.',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['category', 'text'],
        },
      },
      relations: {
        type: 'array',
        description: 'op=note: typed links — {type, target}. target is another note’s title (becomes a [[wikilink]]).',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            target: { type: 'string' },
          },
          required: ['type', 'target'],
        },
      },
      summary: { type: 'string', description: 'op=handoff: what you did (short).' },
      notePath: { type: 'string', description: 'op=handoff: path of the file/note you created, if any.' },
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
        case 'note':
          if (!a.title) return { ok: false, error: 'title is required for note' };
          return {
            ok: true,
            result: await writeNote(ctx.workspace, {
              title: a.title,
              type: a.type,
              tags: a.tags,
              observations: a.observations,
              relations: a.relations,
            }),
          };
        case 'handoff':
          if (!a.summary && !a.text) return { ok: false, error: 'summary is required for handoff' };
          return {
            ok: true,
            result: await writeHandoff(ctx.workspace, {
              summary: (a.summary ?? a.text)!,
              notePath: a.notePath,
              tags: a.tags,
            }),
          };
        default:
          return { ok: false, error: `Unknown op: ${(a as Args).op}` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
