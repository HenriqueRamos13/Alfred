/**
 * Memory (ICM layers).
 *   Layer 3 — stable, human-curated: <workspace>/memory/{preferences,house-rules}.md
 *   Layer 4 — ephemeral working notes per session: <workspace>/memory/working/<sessionId>.md
 * Alfred reads Layer 3 and appends to Layer 4; it never rewrites Layer 3.
 */

import { readFile, appendFile, mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

function paths(workspace: string) {
  const dir = join(workspace, 'memory');
  return {
    dir,
    preferences: join(dir, 'preferences.md'),
    houseRules: join(dir, 'house-rules.md'),
    workingDir: join(dir, 'working'),
    working: (sessionId: string) => join(dir, 'working', `${sessionId}.md`),
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
