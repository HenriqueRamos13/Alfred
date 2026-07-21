/**
 * Budget / kill-switch.
 *
 * Pure helpers (dayKey, makeBudget, addTokens, isOver*, callSignature, isLoop)
 * are strip-types-safe — no native imports — and are exercised by
 * test/logic.test.ts. `BudgetTracker` persists counters in sqlite; it takes the
 * db as a param so this module never value-imports better-sqlite3.
 */

import type { BudgetState, TokenUsage } from './types.ts';

type DB = import('better-sqlite3').Database;

// ── pure logic ──────────────────────────────────────────────────────────────

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function makeBudget(
  day: string,
  dailyLimit: number,
  stepCap: number,
  dailyTokens = 0,
  sessionTokens = 0,
  steps = 0,
): BudgetState {
  return { day, dailyTokens, dailyLimit, sessionTokens, steps, stepCap };
}

export function addTokens(s: BudgetState, u: TokenUsage): BudgetState {
  const t = u.inputTokens + u.outputTokens;
  return { ...s, dailyTokens: s.dailyTokens + t, sessionTokens: s.sessionTokens + t };
}

/** Already at or above the daily kill-switch — refuse the next model call. */
export function isOverDailyBudget(s: BudgetState): boolean {
  return s.dailyTokens >= s.dailyLimit;
}

/** Task has consumed its step budget. */
export function isOverStepCap(s: BudgetState): boolean {
  return s.steps >= s.stepCap;
}

// ── loop detection ────────────────────────────────────────────────────────────

/** Deterministic stringify (sorted keys) so reordered args hash identically. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function callSignature(toolName: string, args: unknown): string {
  return `${toolName}(${stableStringify(args)})`;
}

/**
 * True when `sig` has already occurred `limit` times in `history` — i.e. the
 * about-to-run call would be the (limit+1)-th identical invocation. Default
 * limit 3 → abort on the 4th repeat (spec: "same tool+args repeated >3x").
 */
export function isLoop(history: readonly string[], sig: string, limit = 3): boolean {
  let count = 0;
  for (const h of history) if (h === sig) count++;
  return count >= limit;
}

// ── persistence ───────────────────────────────────────────────────────────────

export class BudgetTracker {
  private steps = 0;
  private readonly db: DB;
  private readonly cfg: { dailyLimit: number; stepCap: number };
  private readonly sessionId: string;

  constructor(db: DB, cfg: { dailyLimit: number; stepCap: number }, sessionId: string) {
    this.db = db;
    this.cfg = cfg;
    this.sessionId = sessionId;
    const now = Date.now();
    this.db
      .prepare('INSERT OR IGNORE INTO sessions(id, created_at, updated_at, tokens) VALUES (?, ?, ?, 0)')
      .run(sessionId, now, now);
  }

  private dailyTokens(): number {
    const row = this.db.prepare('SELECT tokens FROM budget WHERE day = ?').get(dayKey()) as
      | { tokens: number }
      | undefined;
    return row?.tokens ?? 0;
  }

  private sessionTokens(): number {
    const row = this.db.prepare('SELECT tokens FROM sessions WHERE id = ?').get(this.sessionId) as
      | { tokens: number }
      | undefined;
    return row?.tokens ?? 0;
  }

  snapshot(): BudgetState {
    return makeBudget(
      dayKey(),
      this.cfg.dailyLimit,
      this.cfg.stepCap,
      this.dailyTokens(),
      this.sessionTokens(),
      this.steps,
    );
  }

  step(): void {
    this.steps++;
  }

  /** Persist token usage from a model call and return the fresh snapshot. */
  record(usage: TokenUsage): BudgetState {
    const total = usage.inputTokens + usage.outputTokens;
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO budget(day, tokens) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens',
      )
      .run(dayKey(), total);
    this.db.prepare('UPDATE sessions SET tokens = tokens + ?, updated_at = ? WHERE id = ?').run(total, now, this.sessionId);
    return this.snapshot();
  }
}
