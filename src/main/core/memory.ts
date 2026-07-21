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

import { readFile, appendFile, mkdir, writeFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

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
  if (!(await exists(p.preferences))) {
    await writeFile(p.preferences, '# Preferences\n\n_Stable, human-curated. Alfred honours but does not edit this._\n', 'utf8');
  }
  if (!(await exists(p.houseRules))) {
    await writeFile(p.houseRules, '# House rules\n\n_Stable, human-curated. Alfred honours but does not edit this._\n', 'utf8');
  }
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
