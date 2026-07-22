/**
 * Memory (ICM layers).
 *   Layer 3 — stable, human-curated: <workspace>/memory/{preferences,house-rules}.md
 *   Layer 4 — ephemeral working notes per session: <workspace>/memory/working/<sessionId>.md
 * Alfred reads Layer 3 and appends to Layer 4; it never rewrites Layer 3.
 *
 * Long-term memory (survives restarts, curated by Alfred itself):
 *   episodic — dated journal, one entry per event: memory/journal/YYYY-MM-DD.md
 *   semantic — durable facts: memory/facts.md
 */

import { readFile, appendFile, mkdir, writeFile, access, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { slugify } from './projects.ts';

function paths(workspace: string) {
  const dir = join(workspace, 'memory');
  return {
    dir,
    preferences: join(dir, 'preferences.md'),
    houseRules: join(dir, 'house-rules.md'),
    workingDir: join(dir, 'working'),
    working: (sessionId: string) => join(dir, 'working', `${sessionId}.md`),
    journalDir: join(dir, 'journal'),
    journal: (day: string) => join(dir, 'journal', `${day}.md`),
    facts: join(dir, 'facts.md'),
    index: join(dir, 'index.md'),
    notesDir: join(dir, 'notes'),
    note: (slug: string) => join(dir, 'notes', `${slug}.md`),
    mapsDir: join(dir, 'maps'),
    map: (name: string) => join(dir, 'maps', `${name}.md`),
    inboxDir: join(dir, 'inbox'),
    cacheDir: join(dir, '.index'),
    backlinks: join(dir, '.index', 'backlinks.json'),
  };
}

async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const MANAGED_MARKER = '<!-- managed by Alfred -->';

/** (Re)write the workspace CLAUDE.md when it's missing or not Alfred-managed. */
export function claudeMdNeedsWrite(content: string): boolean {
  return !content.includes(MANAGED_MARKER);
}

/** Workspace CLAUDE.md body, from the single-source ALFRED_IDENTITY. */
export function buildClaudeMd(identity: string): string {
  return `${MANAGED_MARKER}
# Alfred — Claude Code brain

Claude Code is operating as the **Alfred** brain of this Agent OS. Your name is
**Alfred**, always — never "Jarvis". The identity below is authoritative; follow
it in every reply.

${identity}
`;
}

/**
 * Ensure <workspace>/CLAUDE.md carries Alfred's identity so \`claude -p\` (whose
 * cwd is the workspace) reads it automatically. Write-if-missing to respect user
 * edits, but re-write when the managed marker is gone. Idempotent.
 */
export async function ensureClaudeMd(workspace: string, identity: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  const file = join(workspace, 'CLAUDE.md');
  if (claudeMdNeedsWrite(await readOptional(file))) {
    await writeFile(file, buildClaudeMd(identity), 'utf8');
  }
}

/** Create the memory dir and seed empty Layer-3 files if absent. Idempotent. */
export async function ensureScaffold(workspace: string): Promise<void> {
  const p = paths(workspace);
  await mkdir(p.workingDir, { recursive: true });
  // Obsidian-style knowledge vault dirs (notes/maps/inbox + curator cache).
  await Promise.all([
    mkdir(p.notesDir, { recursive: true }),
    mkdir(p.mapsDir, { recursive: true }),
    mkdir(p.inboxDir, { recursive: true }),
    mkdir(p.cacheDir, { recursive: true }),
  ]);
  if (!(await exists(p.preferences))) {
    await writeFile(p.preferences, '# Preferences\n\n_Stable, human-curated. Alfred honours but does not edit this._\n', 'utf8');
  }
  if (!(await exists(p.houseRules))) {
    await writeFile(p.houseRules, '# House rules\n\n_Stable, human-curated. Alfred honours but does not edit this._\n', 'utf8');
  }
  if (!(await exists(p.index))) {
    await writeFile(p.index, buildIndex([]), 'utf8');
  }
  // .index/ is a rebuildable curator cache — keep it out of any workspace git repo.
  const gitignore = join(p.dir, '.gitignore');
  if (!(await exists(gitignore))) await writeFile(gitignore, '.index/\n', 'utf8');
}

/** Combined Layer-3 text (preferences + house rules), for the system prompt. */
export async function readStable(workspace: string): Promise<string> {
  const p = paths(workspace);
  const [prefs, rules] = await Promise.all([readOptional(p.preferences), readOptional(p.houseRules)]);
  return [prefs.trim(), rules.trim()].filter(Boolean).join('\n\n');
}

export async function readWorking(workspace: string, sessionId: string): Promise<string> {
  return readOptional(paths(workspace).working(sessionId));
}

/** Append a timestamped note to the session's Layer-4 working file. */
export async function appendWorking(workspace: string, sessionId: string, note: string): Promise<void> {
  const p = paths(workspace);
  await mkdir(p.workingDir, { recursive: true });
  await appendFile(p.working(sessionId), `\n- [${new Date().toISOString()}] ${note}\n`, 'utf8');
}

// ── Long-term memory (episodic journal + semantic facts) ─────────────────────
//
// Pure helpers (below) are unit-tested; the IO functions compose them. The app
// runtime supplies `new Date()`; tests inject a fixed date.

export type MemoryKind = 'episodic' | 'semantic';

/** 'YYYY-MM-DD' for a Date (local time), matching the journal filename scheme. */
export function journalDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** True when a 'YYYY-MM-DD' day is within `sinceDays` back from `today` (inclusive). */
export function isWithinDays(day: string, today: string, sinceDays: number): boolean {
  const a = Date.parse(`${day}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  const diff = (b - a) / 86_400_000;
  return diff >= 0 && diff < sinceDays;
}

/** Case-insensitive substring match; a blank/absent query matches everything. */
export function matchesQuery(text: string, query?: string): boolean {
  if (!query || !query.trim()) return true;
  return text.toLowerCase().includes(query.trim().toLowerCase());
}

/** Non-blank lines of `content` that match `query` (all of them when no query). */
export function filterLines(content: string, query?: string): string[] {
  return content
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && matchesQuery(l, query));
}

/** Keep the most-recent tail within `maxChars`, dropping oldest whole lines off the front. */
export function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(text.length - maxChars);
  const nl = sliced.indexOf('\n');
  const body = nl >= 0 ? sliced.slice(nl + 1) : sliced;
  return `…(truncated)\n${body}`;
}

/** Render persisted messages as a compact transcript, size-capped to the tail. */
export function formatTranscript(msgs: { role: string; content: string }[], maxChars: number): string {
  const lines = msgs.filter((m) => m.content?.trim()).map((m) => `${m.role}: ${m.content.trim()}`);
  return truncateHead(lines.join('\n'), maxChars);
}

/** Sorted list of journal days (YYYY-MM-DD) that have a file; [] when none. */
async function listJournalDays(workspace: string): Promise<string[]> {
  try {
    const files = await readdir(paths(workspace).journalDir);
    return files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/** Record a memory. episodic → today's journal; semantic → facts.md. Both append-only. */
export async function remember(
  workspace: string,
  text: string,
  kind: MemoryKind = 'episodic',
  now: Date = new Date(),
): Promise<{ kind: MemoryKind; file: string }> {
  const p = paths(workspace);
  const line = `\n- [${now.toISOString()}] ${text.trim()}\n`;
  if (kind === 'semantic') {
    await mkdir(p.dir, { recursive: true });
    await appendFile(p.facts, line, 'utf8');
    return { kind, file: p.facts };
  }
  const day = journalDay(now);
  await mkdir(p.journalDir, { recursive: true });
  await appendFile(p.journal(day), line, 'utf8');
  return { kind, file: p.journal(day) };
}

export interface RecallResult {
  sinceDays: number;
  query: string | null;
  days: { day: string; entries: string[] }[];
  facts: string[];
}

/** Read recent journal days (+ facts) and optionally grep them by `query`. */
export async function recall(
  workspace: string,
  opts: { query?: string; sinceDays?: number } = {},
  now: Date = new Date(),
): Promise<RecallResult> {
  const p = paths(workspace);
  const sinceDays = opts.sinceDays && opts.sinceDays > 0 ? opts.sinceDays : 7;
  const today = journalDay(now);
  const days = (await listJournalDays(workspace)).filter((d) => isWithinDays(d, today, sinceDays));
  const out: { day: string; entries: string[] }[] = [];
  for (const day of days) {
    const entries = filterLines(await readOptional(p.journal(day)), opts.query);
    if (entries.length) out.push({ day, entries });
  }
  const facts = filterLines(await readOptional(p.facts), opts.query);
  return { sinceDays, query: opts.query ?? null, days: out, facts };
}

/** Available memory files: journal days + whether facts.md exists. */
export async function listMemory(workspace: string): Promise<{ journalDays: string[]; facts: boolean }> {
  return { journalDays: await listJournalDays(workspace), facts: await exists(paths(workspace).facts) };
}

/**
 * The "# Recent memory" block for the system prompt: facts + the last 7 days of
 * journal, each budgeted and tail-truncated so old lines drop before the cap.
 */
export async function recentMemoryText(
  workspace: string,
  maxChars = 3000,
  now: Date = new Date(),
): Promise<string> {
  const p = paths(workspace);
  const today = journalDay(now);
  const days = (await listJournalDays(workspace)).filter((d) => isWithinDays(d, today, 7));
  const blocks: string[] = [];
  for (const day of days) {
    const c = (await readOptional(p.journal(day))).trim();
    if (c) blocks.push(`### ${day}\n${c}`);
  }
  const facts = truncateHead((await readOptional(p.facts)).trim(), Math.floor(maxChars * 0.4));
  const journal = truncateHead(blocks.join('\n\n'), Math.floor(maxChars * 0.6));
  return [facts && `## Facts\n${facts}`, journal && `## Journal\n${journal}`].filter(Boolean).join('\n\n');
}

// ── Zettelkasten notes + inbox handoffs (Obsidian-style vault) ───────────────
//
// A note is one atomic idea: frontmatter + "## Observations" (typed one-liners)
// + "## Relations" (typed [[wikilinks]] — the graph). Parsers/serializers below
// are PURE and unit-tested; the IO functions compose them.

/** Observation categories the note format allows. */
export type ObsCategory = 'decision' | 'requirement' | 'risk' | 'gotcha' | 'fact' | 'tip';

export interface Observation {
  category: string;
  text: string;
  tags: string[];
}
export interface Relation {
  /** e.g. part_of, uses, relates_to. */
  type: string;
  /** wikilink target (note title). */
  target: string;
}
export interface Note {
  title: string;
  type: string;
  created?: string;
  updated?: string;
  tags: string[];
  observations: Observation[];
  relations: Relation[];
}

/** All `#hashtag` tokens in a string (deduped, order-preserving). */
export function parseHashtags(text: string): string[] {
  const out: string[] = [];
  const re = /#([A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Every `[[wikilink]]` target in text (trimmed, deduped, order-preserving). */
export function extractWikilinks(text: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[1].trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Parse "- [category] text #tag" observation lines from a note body. */
export function parseObservations(body: string): Observation[] {
  const out: Observation[] = [];
  for (const raw of body.split('\n')) {
    const m = raw.match(/^\s*-\s*\[([a-z]+)\]\s+(.+?)\s*$/);
    if (!m) continue;
    const text = m[2].trim();
    out.push({ category: m[1], text, tags: parseHashtags(text) });
  }
  return out;
}

/** Parse "- rel_type [[Target]]" relation lines from a note body. */
export function parseRelations(body: string): Relation[] {
  const out: Relation[] = [];
  for (const raw of body.split('\n')) {
    const m = raw.match(/^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)\s+\[\[([^\]]+)\]\]/);
    if (!m) continue;
    out.push({ type: m[1], target: m[2].trim() });
  }
  return out;
}

/** Split leading `---` YAML frontmatter (title/type/created/updated/tags[]) from the body. */
export function parseFrontmatter(md: string): { data: Record<string, string | string[]>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: md };
  const data: Record<string, string | string[]> = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!mm) continue;
    const val = mm[2].trim();
    data[mm[1]] =
      val.startsWith('[') && val.endsWith(']')
        ? val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
        : val;
  }
  return { data, body: m[2] };
}

/** Parse a full note markdown into the structured Note. */
export function parseNote(md: string): Note {
  const { data, body } = parseFrontmatter(md);
  const tags = Array.isArray(data.tags) ? data.tags : typeof data.tags === 'string' && data.tags ? [data.tags] : [];
  const str = (k: string): string | undefined => (typeof data[k] === 'string' ? (data[k] as string) : undefined);
  return {
    title: str('title') ?? '',
    type: str('type') || 'note',
    created: str('created'),
    updated: str('updated'),
    tags,
    observations: parseObservations(body),
    relations: parseRelations(body),
  };
}

/** Render a Note to canonical markdown (frontmatter + Observations + Relations). */
export function serializeNote(n: Note): string {
  const fm = [
    '---',
    `title: ${n.title}`,
    `type: ${n.type || 'note'}`,
    n.created ? `created: ${n.created}` : null,
    n.updated ? `updated: ${n.updated}` : null,
    `tags: [${(n.tags ?? []).join(', ')}]`,
    '---',
  ]
    .filter((v): v is string => v !== null)
    .join('\n');
  const obs =
    '## Observations' +
    (n.observations.length ? '\n' + n.observations.map((o) => `- [${o.category}] ${o.text}`).join('\n') : '');
  const rel =
    '## Relations' + (n.relations.length ? '\n' + n.relations.map((r) => `- ${r.type} [[${r.target}]]`).join('\n') : '');
  return `${fm}\n\n${obs}\n\n${rel}\n`;
}

/** Union-merge `incoming` into `base` (dedup observations/relations/tags). Idempotent. */
export function mergeNotes(base: Note, incoming: Note): Note {
  const observations = [...base.observations];
  for (const o of incoming.observations)
    if (!observations.some((x) => x.text === o.text && x.category === o.category)) observations.push(o);
  const relations = [...base.relations];
  for (const r of incoming.relations)
    if (!relations.some((x) => x.type === r.type && x.target === r.target)) relations.push(r);
  const tags = [...base.tags];
  for (const t of incoming.tags) if (!tags.includes(t)) tags.push(t);
  return {
    title: incoming.title || base.title,
    type: incoming.type || base.type,
    created: base.created || incoming.created,
    updated: incoming.updated || base.updated,
    tags,
    observations,
    relations,
  };
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** maps/ filename for a note type (people is the one irregular plural). */
export function mapNameForType(type: string): string {
  const t = (type || 'note').toLowerCase();
  return t === 'person' ? 'people' : `${t}s`;
}

/** target-title → source-slugs backlink graph, built from relations + observation wikilinks. */
export function buildBacklinks(notes: { slug: string; note: Note }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { slug, note } of notes) {
    const targets = new Set<string>();
    for (const r of note.relations) targets.add(r.target);
    for (const o of note.observations) for (const w of extractWikilinks(o.text)) targets.add(w);
    for (const t of targets) (out[t] ??= []).push(slug);
  }
  return out;
}

/** Root Map-of-Content (index.md): every note as a [[wikilink]], grouped by type. */
export function buildIndex(notes: { slug: string; note: Note }[]): string {
  const byType = new Map<string, string[]>();
  for (const { note } of notes) {
    const list = byType.get(note.type) ?? [];
    list.push(note.title);
    byType.set(note.type, list);
  }
  const lines = [
    '# Index — Alfred memory map (L1)',
    '',
    '_Root Map of Content: the router to all durable knowledge. Follow the [[wikilinks]] to reach notes; maps/ holds per-type MOCs._',
    '',
  ];
  if (byType.size === 0) lines.push('_No notes yet._', '');
  for (const type of [...byType.keys()].sort()) {
    lines.push(`## ${cap(mapNameForType(type))}`, `See [[${cap(mapNameForType(type))}]]`);
    for (const title of byType.get(type)!.slice().sort()) lines.push(`- [[${title}]]`);
    lines.push('');
  }
  return lines.join('\n');
}

/** A per-type MOC (maps/<type>s.md): the notes of one type. */
export function buildMap(type: string, notes: { slug: string; note: Note }[]): string {
  const titles = notes
    .filter((n) => n.note.type === type)
    .map((n) => n.note.title)
    .sort();
  const lines = [`# ${cap(mapNameForType(type))} — MOC`, '', `_Maintained by the curator. Notes of type \`${type}\`._`, ''];
  for (const t of titles) lines.push(`- [[${t}]]`);
  return lines.join('\n') + '\n';
}

// ── notes / handoffs / index IO ──────────────────────────────────────────────

/** Load one note by slug, or null when it doesn't exist. */
export async function readNote(workspace: string, slug: string): Promise<Note | null> {
  const md = await readOptional(paths(workspace).note(slug));
  return md.trim() ? parseNote(md) : null;
}

/** All notes in notes/ as {slug, note}, sorted by slug. */
export async function listNotes(workspace: string): Promise<{ slug: string; note: Note }[]> {
  const p = paths(workspace);
  let files: string[];
  try {
    files = (await readdir(p.notesDir)).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out: { slug: string; note: Note }[] = [];
  for (const f of files.sort()) {
    const md = await readOptional(join(p.notesDir, f));
    if (md.trim()) out.push({ slug: f.slice(0, -3), note: parseNote(md) });
  }
  return out;
}

/**
 * Create or update (union-merge) an atomic note in notes/<slug>.md. Slug is
 * derived from the title, so writing the same title again merges into it.
 */
export async function writeNote(
  workspace: string,
  input: { title: string; type?: string; tags?: string[]; observations?: Observation[]; relations?: Relation[] },
  now: Date = new Date(),
): Promise<{ slug: string; file: string }> {
  const p = paths(workspace);
  const slug = slugify(input.title);
  if (!slug) throw new Error(`Cannot derive a slug from note title: ${JSON.stringify(input.title)}`);
  const today = journalDay(now);
  const incoming: Note = {
    title: input.title.trim(),
    type: (input.type || 'note').trim(),
    created: today,
    updated: today,
    tags: input.tags ?? [],
    observations: (input.observations ?? []).map((o) => ({
      category: o.category,
      text: o.text,
      tags: o.tags ?? parseHashtags(o.text),
    })),
    relations: input.relations ?? [],
  };
  const existing = await readNote(workspace, slug);
  const note = existing ? mergeNotes(existing, { ...incoming, updated: today }) : incoming;
  await mkdir(p.notesDir, { recursive: true });
  await writeFile(p.note(slug), serializeNote(note), 'utf8');
  return { slug, file: p.note(slug) };
}

/** Drop a short handoff into inbox/ for the curator to organise later. */
export async function writeHandoff(
  workspace: string,
  input: { summary: string; notePath?: string; tags?: string[] },
  now: Date = new Date(),
): Promise<{ file: string }> {
  const p = paths(workspace);
  await mkdir(p.inboxDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = join(p.inboxDir, `${stamp}-${Math.random().toString(36).slice(2, 8)}.md`);
  const body = [
    `- created: ${now.toISOString()}`,
    input.notePath ? `- note: ${input.notePath}` : null,
    input.tags?.length ? `- tags: ${input.tags.map((t) => `#${t}`).join(' ')}` : null,
    '',
    input.summary.trim(),
    '',
  ]
    .filter((v): v is string => v !== null)
    .join('\n');
  await writeFile(file, body, 'utf8');
  return { file };
}

/** Absolute paths of pending inbox handoffs (oldest first). */
export async function listInbox(workspace: string): Promise<string[]> {
  const p = paths(workspace);
  try {
    return (await readdir(p.inboxDir))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => join(p.inboxDir, f));
  } catch {
    return [];
  }
}

export function readInbox(file: string): Promise<string> {
  return readOptional(file);
}

/** Delete processed inbox files; per-file errors are swallowed (best-effort drain). */
export async function drainInbox(files: string[]): Promise<void> {
  await Promise.all(files.map((f) => unlink(f).catch(() => {})));
}

/** L1 router (index.md) for the system prompt / new agents. */
export function readIndex(workspace: string): Promise<string> {
  return readOptional(paths(workspace).index);
}

/**
 * Regenerate the derived artifacts from the notes on disk: index.md (root MOC),
 * maps/<type>s.md (per-type MOCs) and .index/backlinks.json. Pure-derivable and
 * idempotent — safe to call any time.
 */
export async function rebuildIndexes(workspace: string): Promise<void> {
  const p = paths(workspace);
  const notes = await listNotes(workspace);
  await mkdir(p.cacheDir, { recursive: true });
  await mkdir(p.mapsDir, { recursive: true });
  await writeFile(p.index, buildIndex(notes), 'utf8');
  await writeFile(p.backlinks, JSON.stringify(buildBacklinks(notes), null, 2), 'utf8');
  const types = [...new Set(notes.map((n) => n.note.type))];
  await Promise.all(types.map((t) => writeFile(p.map(mapNameForType(t)), buildMap(t, notes), 'utf8')));
}
