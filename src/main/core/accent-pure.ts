/**
 * Accent palette — pure + renderer-safe (NO `node:*` / better-sqlite3 import),
 * so it is shared by the renderer, the orchestrator setter and the unit tests.
 *
 * The accent recolours ONLY the primary/neon token (`--acc`) and its color-mix
 * derivatives (the whole neon UI keys off `--acc`). The semantic tokens are
 * independent and NEVER change with the accent: `--grn` (active/ok), `--red`
 * (danger), `--amb` (warn). Values reuse the design tokens from theme.css, plus
 * two coherent extras (a cooler blue, a warmer orange).
 */

export const ACCENTS = {
  cyan: '#59e8ff',
  amber: '#ffb45e',
  magenta: '#c77bff',
  green: '#4dffa6',
  blue: '#5e9bff',
  orange: '#ff8f4d',
} as const;

export type AccentName = keyof typeof ACCENTS;

/** Default accent (matches theme.css `--acc`). */
export const DEFAULT_ACCENT: AccentName = 'cyan';

/** Known accent names, in swatch order. */
export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];

/** Narrow an arbitrary value to a known accent name. */
export function isAccent(name: unknown): name is AccentName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ACCENTS, name);
}

/** Accent name → hex. Unknown / invalid → the default (cyan). */
export function resolveAccent(name: unknown): string {
  return isAccent(name) ? ACCENTS[name] : ACCENTS[DEFAULT_ACCENT];
}
