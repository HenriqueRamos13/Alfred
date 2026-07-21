/**
 * Model pricing → estimated USD cost. Visibility only — the hard kill-switch is
 * still tokens (see budget.ts). Prices are USD per 1,000,000 tokens.
 *
 * PURE + strip-types-safe: `costOf` / `isKnownModel` read a module-level table
 * and never touch the filesystem, so test/logic.test.ts can import them. The
 * optional env/file override (`loadPricingOverrides`) is called once at boot.
 *
 * Published prices (verified July 2026 — always ESTIMATES, confirm before you
 * rely on them; providers change these and caching/batch discounts apply):
 *   - claude-sonnet-5: intro $2 / $10 (until 2026-08-31; standard $3 / $15 from
 *     2026-09-01). Source: edenai.co / finout.io Sonnet 5 pricing, Jul 2026.
 *   - gpt-4o: $2.50 / $10. Source: OpenAI pricing via pecollective/finout, Jul 2026.
 *   - deepseek-v4-flash: $0.14 / $0.28 (cache-miss input). Source: chat-deep.ai /
 *     benchlm.ai DeepSeek pricing, 2026-07-10.
 *   - deepseek-v4-pro: $0.435 / $0.87 (cache-miss input). Same source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5': { inputPerM: 2, outputPerM: 10 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
  'deepseek-v4-flash': { inputPerM: 0.14, outputPerM: 0.28 },
  'deepseek-v4-pro': { inputPerM: 0.435, outputPerM: 0.87 },
};

/** Live table; starts from defaults, may be replaced by env/file overrides at boot. */
let PRICES: Record<string, ModelPrice> = { ...DEFAULT_PRICES };

export function isKnownModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRICES, model);
}

/**
 * Estimated USD cost of a call. Unknown model → 0 (use `isKnownModel` for the
 * "unknown" flag). Pure: same inputs, same output.
 */
export function costOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (usage.inputTokens / 1_000_000) * p.inputPerM + (usage.outputTokens / 1_000_000) * p.outputPerM;
}

/**
 * Merge overrides on top of the defaults. Precedence: file at ALFRED_PRICING_JSON,
 * else optional data/pricing.json. Malformed JSON is ignored (keeps defaults).
 * Called once at boot from the main process; safe to skip in tests.
 */
export function loadPricingOverrides(env: Record<string, string | undefined>, dataDir?: string): void {
  const candidates = [env.ALFRED_PRICING_JSON, dataDir ? join(dataDir, 'pricing.json') : undefined];
  for (const path of candidates) {
    if (!path) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ModelPrice>;
      PRICES = { ...PRICES, ...parsed };
    } catch {
      // Missing file or bad JSON — keep whatever we have. ponytail: best-effort override.
    }
  }
}
