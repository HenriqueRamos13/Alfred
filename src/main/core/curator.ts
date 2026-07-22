/**
 * Curator / librarian — the dedicated organiser brain.
 *
 * Its ONLY job is to keep the memory vault tidy: it drains inbox/ handoffs into
 * atomic notes in the canonical format, then regenerates the derived artifacts
 * (index.md root MOC, maps/ per-type MOCs, .index/backlinks.json). It runs on a
 * CHEAP model (ALFRED_CURATOR_MODEL, else the cheapest enabled API brain) so
 * organising never competes with the main task for the good model.
 *
 * Contract: idempotent, robust (every error is logged, it NEVER throws), and it
 * respects the daily token kill-switch (skips the LLM step when over budget, but
 * still rebuilds the deterministic indexes). The semantic work — turning a messy
 * handoff into a well-formed note, merging into an existing one — is the model's;
 * everything else (formatting, MOCs, backlinks) is pure code. When no cheap brain
 * is available or the model call fails, it falls back to a verbatim note so a
 * handoff is never lost.
 */

import { generateText } from 'ai';
import type { Observation, Relation } from './memory.ts';
import {
  listInbox,
  readInbox,
  drainInbox,
  listNotes,
  writeNote,
  rebuildIndexes,
} from './memory.ts';
import { resolveProvider, listBrains } from './providers.ts';
import type { BrainInfo } from './providers.ts';
import { costOf } from './pricing.ts';
import { BudgetTracker, isOverDailyBudget } from './budget.ts';

type DB = import('better-sqlite3').Database;
type Env = Record<string, string | undefined>;

const CURATOR_SYSTEM = `You are Alfred's librarian. Your ONLY job is to organise long-term memory into a clean Obsidian-style vault — you never do the user's task, you file its residue.

You receive one "handoff" (a short note an agent dropped after finishing something) plus the titles of notes that already exist. Turn the handoff into ONE atomic note (a single idea, zettelkasten-style). If it clearly belongs to an existing note, REUSE that exact title so it merges in.

Reply with ONLY a JSON object, no prose, no code fences:
{
  "title": "Human-readable note title (reuse an existing one to merge)",
  "type": "note | project | person | tool | decision",
  "tags": ["short", "kebab-tags"],
  "observations": [{ "category": "decision|requirement|risk|gotcha|fact|tip", "text": "one factual line" }],
  "relations": [{ "type": "part_of|uses|relates_to|about", "target": "Title of a related note" }]
}
Keep it small and factual. Relations' targets are wikilink titles (prefer existing ones). Omit empty arrays' items rather than inventing.`;

interface CuratorNoteJson {
  title?: string;
  type?: string;
  tags?: unknown;
  observations?: unknown;
  relations?: unknown;
}

export interface RunCuratorDeps {
  db: DB;
  workspace: string;
  sessionId: string;
  dailyTokenBudget: number;
  stepCap: number;
  dailyUsdBudget?: number;
  env?: Env;
}

export interface CuratorResult {
  processed: number;
  notes: number;
  usedModel: string | null;
  skipped?: 'empty' | 'budget';
}

/**
 * Provider spec for the curator: ALFRED_CURATOR_MODEL if set, else the cheapest
 * enabled API brain (by published per-token price; DeepSeek typically wins).
 * Returns null when no API brain is enabled. Pure — tested in logic.test.ts.
 */
export function pickCuratorSpec(env: Env, brains: readonly BrainInfo[]): string | null {
  const explicit = (env.ALFRED_CURATOR_MODEL ?? '').trim();
  if (explicit) return explicit;
  // Nominal 1:1 in/out usage just to rank models by price.
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const candidates = brains
    .filter((b) => b.enabled && b.id !== 'claude-code')
    .map((b) => ({ id: b.id, cost: costOf(b.model, usage) }))
    .sort((a, b) => a.cost - b.cost);
  return candidates[0]?.id ?? null;
}

/** Strip code fences / prose and parse the first JSON object in the model reply. */
function parseNoteJson(text: string): CuratorNoteJson | null {
  const fenced = text.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1)) as CuratorNoteJson;
  } catch {
    return null;
  }
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Coerce the model's JSON into a note-write input; null when it lacks a title. */
function toNoteInput(j: CuratorNoteJson): {
  title: string;
  type?: string;
  tags: string[];
  observations: Observation[];
  relations: Relation[];
} | null {
  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;
  const observations: Observation[] = Array.isArray(j.observations)
    ? (j.observations as unknown[])
        .map((o) => o as { category?: unknown; text?: unknown })
        .filter((o) => typeof o.text === 'string' && (o.text as string).trim())
        .map((o) => ({
          category: typeof o.category === 'string' ? o.category : 'fact',
          text: (o.text as string).trim(),
          tags: [],
        }))
    : [];
  const relations: Relation[] = Array.isArray(j.relations)
    ? (j.relations as unknown[])
        .map((r) => r as { type?: unknown; target?: unknown })
        .filter((r) => typeof r.target === 'string' && (r.target as string).trim())
        .map((r) => ({ type: typeof r.type === 'string' ? r.type : 'relates_to', target: (r.target as string).trim() }))
    : [];
  return { title, type: typeof j.type === 'string' ? j.type : undefined, tags: asStrings(j.tags), observations, relations };
}

/** Fallback note when the LLM is unavailable/unusable: keep the handoff verbatim so nothing is lost. */
function verbatimNote(raw: string, i: number): { title: string; type: string; observations: Observation[] } {
  const firstLine = raw.split('\n').find((l) => l.trim() && !l.trim().startsWith('- ')) ?? `Handoff ${i + 1}`;
  const title = `Inbox — ${firstLine.trim().slice(0, 60)}`;
  return { title, type: 'note', observations: [{ category: 'fact', text: raw.trim().replace(/\s+/g, ' ').slice(0, 500), tags: [] }] };
}

/**
 * Drain the inbox and rebuild the vault indexes. Never throws — returns a summary
 * (with `skipped` when it did no LLM work). Callers should still guard the call.
 */
export async function runCurator(deps: RunCuratorDeps): Promise<CuratorResult> {
  const env = deps.env ?? process.env;
  const inbox = await listInbox(deps.workspace).catch(() => [] as string[]);
  if (inbox.length === 0) {
    // Nothing queued, but keep derived artifacts honest (cheap, no model).
    await rebuildIndexes(deps.workspace).catch((err) => log('rebuild', err));
    return { processed: 0, notes: (await listNotes(deps.workspace).catch(() => [])).length, usedModel: null, skipped: 'empty' };
  }

  const budget = new BudgetTracker(
    deps.db,
    { dailyLimit: deps.dailyTokenBudget, stepCap: deps.stepCap, dailyUsdBudget: deps.dailyUsdBudget },
    deps.sessionId,
  );
  const overBudget = isOverDailyBudget(budget.snapshot());

  // Resolve the cheap curator brain (skipped when over budget → verbatim only).
  let provider: ReturnType<typeof resolveProvider> | null = null;
  if (!overBudget) {
    const spec = pickCuratorSpec(env, listBrains(env));
    if (spec) {
      try {
        provider = resolveProvider(spec, env);
      } catch (err) {
        log('resolve curator brain', err);
      }
    }
  }

  const existingTitles = (await listNotes(deps.workspace).catch(() => [])).map((n) => n.note.title);
  const processed: string[] = [];

  for (let i = 0; i < inbox.length; i++) {
    const file = inbox[i];
    try {
      const raw = (await readInbox(file)).trim();
      if (!raw) {
        processed.push(file);
        continue;
      }
      let input = null as ReturnType<typeof toNoteInput> | null;
      if (provider) {
        try {
          const prompt =
            `Existing note titles (reuse to merge):\n${existingTitles.length ? existingTitles.map((t) => `- ${t}`).join('\n') : '(none)'}\n\n` +
            `Handoff to file:\n${raw}`;
          const res = await generateText({
            model: provider.languageModel,
            system: CURATOR_SYSTEM,
            prompt,
            maxOutputTokens: 800,
          });
          budget.record({ inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 }, provider.model);
          const json = parseNoteJson(res.text);
          if (json) input = toNoteInput(json);
        } catch (err) {
          log('curator model call', err);
        }
      }
      const noteInput = input ?? verbatimNote(raw, i);
      const { slug } = await writeNote(deps.workspace, noteInput);
      if (!existingTitles.includes(noteInput.title)) existingTitles.push(noteInput.title);
      void slug;
      processed.push(file);
    } catch (err) {
      // Leave a failed handoff in the inbox for the next pass; never crash.
      log(`process handoff ${file}`, err);
    }
  }

  await drainInbox(processed).catch((err) => log('drain inbox', err));
  await rebuildIndexes(deps.workspace).catch((err) => log('rebuild indexes', err));

  const notes = (await listNotes(deps.workspace).catch(() => [])).length;
  return { processed: processed.length, notes, usedModel: provider?.model ?? null, skipped: overBudget ? 'budget' : undefined };
}

function log(where: string, err: unknown): void {
  console.error(`[alfred:curator] ${where} failed:`, err instanceof Error ? err.message : err);
}
