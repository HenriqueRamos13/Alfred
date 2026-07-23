/**
 * Reference agent — an ISOLATED, read-only Q&A side-thread over ONE note/node.
 *
 * It answers focused questions about a single vault note (or a project) using a
 * FOCUSED context: the target note + its immediate neighbours (outgoing
 * wikilinks + incoming backlinks), size-capped. It runs exactly ONE model turn
 * on the agent configured as `reference` (agent_config.reference, default
 * DeepSeek V4 Flash) with NO Alfred tools — it responds only from the context.
 *
 * Isolation guarantees:
 *   - never reads the main conversation history nor the claude-code --resume
 *     session; its thread is ephemeral (history arrives per call, kept by the UI)
 *   - its stream is scoped by threadId (reference.* events), never mixing with
 *     the main chat.* stream, and is NEVER persisted to the messages table
 *   - it still counts against the daily token kill-switch (BudgetTracker)
 *
 * The context/prompt/neighbour helpers are PURE + strip-types-safe and are
 * tested in test/logic.test.ts; the IO turn (askReference) composes them.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { streamText } from 'ai';
import type { ChatMessage, StreamEvent } from './types.ts';
import { readNote, listNotes, serializeNote, extractWikilinks } from './memory.ts';
import type { Note } from './memory.ts';
import { getProject, slugify } from './projects.ts';
import { resolveProvider } from './providers.ts';
import { agentToSpec } from './modelCatalog.ts';
import type { AgentConfig } from './modelCatalog.ts';
import { spawnClaudeCli } from './claudeSpawn.ts';
import { BudgetTracker, isOverDailyBudget } from './budget.ts';

type DB = import('better-sqlite3').Database;
type Env = Record<string, string | undefined>;

export const REFERENCE_SYSTEM = `You are Alfred's Reference assistant — a focused, read-only helper.

Answer the user's question STRICTLY from the provided context (a target note and its immediate neighbours in Alfred's knowledge vault). You have NO tools and cannot browse, run commands, or act — you only reason over the text you are given.

If the context does not contain the answer, say so plainly ("the note doesn't cover that") rather than guessing. Be concise, precise and cite the note titles you rely on. This thread is isolated: it does not affect Alfred's main conversation.`;

/** What a reference thread points at: a vault note (by slug/title/path) or a project (+ optional file). */
export interface ReferenceTarget {
  /** Note slug, title, or path (e.g. "Foo", "foo", "memory/notes/foo.md"). */
  note?: string;
  /** Project slug or name. */
  project?: string;
  /** Optional file within the project (relative path). */
  file?: string;
}

export interface ReferenceRequest {
  /** Opaque id the UI generates to scope the reference.* stream to one panel. */
  threadId: string;
  target: ReferenceTarget;
  question: string;
  /** Prior turns of THIS thread (ephemeral; carried by the UI, never persisted). */
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export interface ReferenceDeps {
  db: DB;
  workspace: string;
  sessionId: string;
  dailyTokenBudget: number;
  stepCap: number;
  dailyUsdBudget?: number;
  /** The reference agent's config (agent_config.reference). */
  reference: AgentConfig;
  emit: (e: StreamEvent) => void;
  env?: Env;
}

// ── pure helpers (tested) ─────────────────────────────────────────────────────

/** Clip to the HEAD of `text` (keep title/frontmatter), marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}

/** Note slug from a note reference that may be a title, a slug, or a path. */
export function toNoteSlug(ref: string): string {
  const base = (ref.split('/').pop() ?? ref).replace(/\.md$/i, '');
  return slugify(base);
}

type NoteLite = { title: string; relations: { target: string }[]; observations: { text: string }[] };

/**
 * Direct neighbours of a note: its outgoing wikilink targets (relations +
 * observation [[links]]) plus the incoming backlinks (notes that link to it).
 * Deduped by slug, self excluded, capped at `limit`. Pure.
 */
export function selectNeighbors(
  targetTitle: string,
  targetNote: NoteLite,
  allNotes: { slug: string; note: NoteLite }[],
  limit = 6,
): { slug: string; title: string }[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const self = norm(targetTitle);
  const byTitle = new Map<string, { slug: string; title: string }>();
  for (const { slug, note } of allNotes) byTitle.set(norm(note.title), { slug, title: note.title });

  const out: { slug: string; title: string }[] = [];
  const seen = new Set<string>();
  const add = (n?: { slug: string; title: string }): void => {
    if (!n || norm(n.title) === self || seen.has(n.slug)) return;
    seen.add(n.slug);
    out.push(n);
  };

  const linksOf = (n: NoteLite): Set<string> => {
    const s = new Set<string>();
    for (const r of n.relations) s.add(norm(r.target));
    for (const o of n.observations) for (const w of extractWikilinks(o.text)) s.add(norm(w));
    return s;
  };

  // Outgoing first (the note's own declared relations), then incoming backlinks.
  for (const t of linksOf(targetNote)) add(byTitle.get(t));
  for (const { slug, note } of allNotes) {
    if (norm(note.title) === self) continue;
    if (linksOf(note).has(self)) add({ slug, title: note.title });
  }
  return out.slice(0, limit);
}

/** Assemble the focused context block from the target + neighbour note bodies. Pure, size-capped. */
export function buildReferenceContext(
  target: { title: string; body: string },
  neighbors: { title: string; body: string }[],
  opts: { maxChars?: number; perNeighborChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 6000;
  const perNeighborChars = opts.perNeighborChars ?? 800;
  const parts = [`## Target note: ${target.title}\n${clip(target.body.trim(), Math.floor(maxChars * 0.6))}`];
  if (neighbors.length) {
    const nb = neighbors.map((n) => `### ${n.title}\n${clip(n.body.trim(), perNeighborChars)}`).join('\n\n');
    parts.push(`## Neighbouring notes (direct links)\n${nb}`);
  }
  return clip(parts.join('\n\n'), maxChars);
}

/** Build the single-turn prompt: context + this thread's history + the question. Pure. */
export function buildReferencePrompt(
  context: string,
  question: string,
  history: { role: string; content: string }[] = [],
): string {
  const hx = history
    .filter((h) => h.content?.trim())
    .map((h) => `${h.role}: ${h.content.trim()}`)
    .join('\n');
  return [
    '# Reference context',
    context,
    hx ? `# Conversation so far\n${hx}` : '',
    `# Question\n${question.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ── IO turn ───────────────────────────────────────────────────────────────────

function refMessage(threadId: string, content: string): ChatMessage {
  return { id: randomUUID(), sessionId: threadId, role: 'assistant', content, ts: Date.now() };
}

/** Read a file inside a project, guarding against path traversal. Null on any problem. */
async function readProjectFile(root: string, rel: string): Promise<string | null> {
  if (rel.startsWith('/') || rel.includes('..')) return null;
  const abs = normalize(join(root, rel));
  if (!abs.startsWith(normalize(root))) return null;
  return readFile(abs, 'utf8').catch(() => null);
}

/** Build the focused context for a target. Returns null when the target can't be found. */
async function buildContext(deps: ReferenceDeps, target: ReferenceTarget): Promise<{ title: string; context: string } | null> {
  if (target.project) {
    const detail = await getProject(deps.db, deps.workspace, slugify(target.project)).catch(() => null);
    if (!detail) return null;
    const m = detail.manifest;
    let body = [
      `${m.name} (${m.slug}) — ${m.stack}, status ${m.status}`,
      m.summary ? `Summary: ${m.summary}` : '',
      detail.files.length ? `Files:\n${detail.files.map((f) => `  ${f}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (target.file) {
      const c = await readProjectFile(m.path, target.file);
      if (c) body += `\n\n## File ${target.file}\n${clip(c, 2000)}`;
    }
    return { title: m.name, context: buildReferenceContext({ title: m.name, body }, []) };
  }

  const ref = target.note ?? '';
  if (!ref.trim()) return null;
  const slug = toNoteSlug(ref);
  const note = await readNote(deps.workspace, slug);
  if (!note) return null;
  const all = await listNotes(deps.workspace).catch(() => [] as { slug: string; note: Note }[]);
  const bySlug = new Map(all.map((n) => [n.slug, n.note]));
  const neighbors = selectNeighbors(note.title, note, all).map((n) => ({
    title: n.title,
    body: serializeNote(bySlug.get(n.slug)!),
  }));
  const title = note.title || slug;
  return { title, context: buildReferenceContext({ title, body: serializeNote(note) }, neighbors) };
}

/**
 * Run one isolated reference turn and stream reference.* events. Never throws —
 * every failure surfaces as reference.error, always followed by reference.done.
 */
export async function askReference(deps: ReferenceDeps, req: ReferenceRequest): Promise<void> {
  const { emit } = deps;
  const threadId = req.threadId;
  const done = (): void => emit({ kind: 'reference.done', threadId });
  const fail = (message: string): void => {
    emit({ kind: 'reference.error', threadId, message });
    done();
  };

  try {
    if (!req.question?.trim()) return fail('Empty question.');
    const built = await buildContext(deps, req.target);
    if (!built) return fail('Reference target not found in the vault.');

    // Kill-switch: reference spend counts against the shared daily token budget.
    const budget = new BudgetTracker(
      deps.db,
      { dailyLimit: deps.dailyTokenBudget, stepCap: deps.stepCap, dailyUsdBudget: deps.dailyUsdBudget },
      deps.sessionId,
    );
    if (isOverDailyBudget(budget.snapshot())) {
      return fail('Daily token budget exhausted — reference is disabled until tomorrow.');
    }

    const prompt = buildReferencePrompt(built.context, req.question, req.history ?? []);

    // claude-cli: spawn `claude -p --model <id>` isolated — no --resume (ephemeral
    // thread) and no MCP bridge (bridge:false → no Alfred tools).
    if (deps.reference.provider === 'claude-cli') {
      // Read-only enforced IN CODE, not just the system prompt (CLAUDE.md: governance
      // is never a prompt): --disallowedTools blocks every mutating / executing /
      // network native tool so the child cannot edit the vault or run commands,
      // regardless of DANGEROUS mode (no --dangerously-skip-permissions, no
      // acceptEdits). Read/Grep/Glob stay — harmless, and the same notes the API
      // path already reads. The variadic list must be followed by a flag.
      const args = [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--model',
        deps.reference.model,
        '--disallowedTools',
        'Bash',
        'Edit',
        'Write',
        'MultiEdit',
        'NotebookEdit',
        'WebFetch',
        'WebSearch',
        'Task',
        'KillShell',
        '--append-system-prompt',
        REFERENCE_SYSTEM,
      ];
      const out = await spawnClaudeCli(args, { cwd: deps.workspace, bridge: false });
      if (out.enoent) return fail('Claude Code CLI not found on PATH. Install it: npm i -g @anthropic-ai/claude-code');
      if (out.code !== 0) return fail(`claude -p exited ${out.code}: ${(out.stderr || out.stdout).trim()}`);
      let text = out.stdout.trim();
      try {
        text = (JSON.parse(out.stdout) as { result?: string }).result ?? text;
      } catch {
        /* not JSON — use raw stdout */
      }
      if (text.trim()) emit({ kind: 'reference.delta', threadId, text });
      emit({ kind: 'reference.message', threadId, message: refMessage(threadId, text) });
      return done();
    }

    // API brains (claude-api / openai / deepseek) via the AI SDK — no tools.
    let provider: ReturnType<typeof resolveProvider>;
    try {
      provider = resolveProvider(agentToSpec(deps.reference), deps.env ?? process.env);
    } catch (err) {
      return fail(
        `Reference brain not connected: set its API key in .env (DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY) or pick a connected provider for the reference agent in Settings. (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    const result = streamText({
      model: provider.languageModel,
      system: REFERENCE_SYSTEM,
      prompt,
      maxOutputTokens: 1024,
    });
    let text = '';
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
        emit({ kind: 'reference.delta', threadId, text: part.text });
      } else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
    try {
      const usage = await result.usage;
      budget.record({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 }, provider.model);
    } catch (err) {
      // Accounting must never sink the answer we already streamed.
      console.error('[alfred:reference] usage accounting failed:', err instanceof Error ? err.message : err);
    }
    emit({ kind: 'reference.message', threadId, message: refMessage(threadId, text) });
    done();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
