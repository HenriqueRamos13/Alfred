/**
 * Budget / kill-switch.
 *
 * Pure helpers (dayKey, makeBudget, addTokens, isOver*, callSignature, isLoop)
 * are strip-types-safe — no native imports — and are exercised by
 * test/logic.test.ts. `BudgetTracker` persists counters in sqlite; it takes the
 * db as a param so this module never value-imports better-sqlite3.
 */

import type { BudgetState, CostSnapshot, CostTotals, ModelCost, TokenUsage } from './types.ts';
import { costOf, isKnownModel } from './pricing.ts';

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

/**
 * Tokens a roster agent has spent TODAY, summed across models. Reuses the
 * day-keyed usage_by_model rows already written by every agent run (delegate /
 * study), which use the sessionId convention `agent:<agentId>` — so there is no
 * separate per-agent counter to maintain. Returns 0 before an agent's first run.
 * ponytail: only API-brain runs record usage (claude-cli spawns an external child
 * with no token accounting), so a claude-cli agent's per-agent cap can't bite —
 * same limitation as the global kill-switch. Upgrade path: parse `claude -p`'s
 * usage JSON and record it here too.
 */
export function agentTokensToday(db: DB, agentId: string, day: string = dayKey()): number {
  const r = db
    .prepare(
      "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM usage_by_model WHERE session_id = ? AND day = ?",
    )
    .get(`agent:${agentId}`, day) as { t: number };
  return r.t;
}

// ── persistence ───────────────────────────────────────────────────────────────

export class BudgetTracker {
  private steps = 0;
  private readonly db: DB;
  private readonly cfg: { dailyLimit: number; stepCap: number; dailyUsdBudget?: number };
  private readonly sessionId: string;

  constructor(db: DB, cfg: { dailyLimit: number; stepCap: number; dailyUsdBudget?: number }, sessionId: string) {
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

  /**
   * Persist token usage from a model call and return the fresh snapshot. When
   * `model` is given, also records the per-model tokens + estimated USD cost
   * (visibility only — the hard cap is still the token total above).
   */
  record(usage: TokenUsage, model?: string): BudgetState {
    const total = usage.inputTokens + usage.outputTokens;
    const now = Date.now();
    const day = dayKey();
    this.db
      .prepare(
        'INSERT INTO budget(day, tokens) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens',
      )
      .run(day, total);
    this.db.prepare('UPDATE sessions SET tokens = tokens + ?, updated_at = ? WHERE id = ?').run(total, now, this.sessionId);

    if (model) {
      const cost = costOf(model, usage);
      this.db
        .prepare(
          `INSERT INTO usage_by_model(day, session_id, model, input_tokens, output_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, session_id, model) DO UPDATE SET
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             cost_usd = cost_usd + excluded.cost_usd`,
        )
        .run(day, this.sessionId, model, usage.inputTokens, usage.outputTokens, cost);
    }
    return this.snapshot();
  }

  /** Estimated-cost breakdown for the UI. `activeModel` is the current turn's model. */
  costSnapshot(activeBrain: string, activeModel: string): CostSnapshot {
    const day = dayKey();
    const totals = (where: string, param: string): CostTotals => {
      const r = this.db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(cost_usd),0) AS c
           FROM usage_by_model WHERE ${where}`,
        )
        .get(param) as { i: number; o: number; c: number };
      return { inputTokens: r.i, outputTokens: r.o, tokens: r.i + r.o, usd: r.c };
    };

    const byModel = (
      this.db
        .prepare(
          `SELECT model, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost_usd) AS c
           FROM usage_by_model WHERE day = ? GROUP BY model ORDER BY c DESC`,
        )
        .all(day) as { model: string; i: number; o: number; c: number }[]
    ).map(
      (r): ModelCost => ({
        model: r.model,
        inputTokens: r.i,
        outputTokens: r.o,
        tokens: r.i + r.o,
        usd: r.c,
        unknownPrice: !isKnownModel(r.model),
      }),
    );

    const today = totals('day = ?', day);
    const budget = this.cfg.dailyUsdBudget;
    return {
      activeBrain,
      activeModel,
      day,
      today,
      session: totals('session_id = ?', this.sessionId),
      byModel,
      dailyTokenCap: this.cfg.dailyLimit,
      dailyUsdBudget: budget,
      overUsdBudget: budget != null && today.usd > budget,
    };
  }
}
