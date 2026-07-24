/**
 * Send-delay (edit-window) pure logic. Renderer-safe: NO `node:*` /
 * better-sqlite3 import so it is shared by App.tsx and unit-tested via strip-types.
 *
 * The edit window is a short hold before a submitted message actually reaches the
 * AI: text (typed OR dictated/auto-sent) becomes a PENDING bubble for
 * `send_delay_ms`, giving the user a beat to catch a transcription slip before it
 * goes out. 0 = disabled (send immediately, the pre-feature behaviour).
 */

export const SEND_DELAY_DEFAULT_MS = 2000;

/**
 * Parse the persisted `send_delay_ms` setting. Absent → default; non-numeric /
 * negative → default. Any finite ≥0 value (0 = off) is floored to an integer.
 */
export function parseSendDelay(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return SEND_DELAY_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SEND_DELAY_DEFAULT_MS;
  return Math.floor(n);
}

/**
 * Hold the send behind the edit window? Only when a delay is configured AND the
 * text is non-empty (whitespace-only never holds — nor sends). delay 0 = off →
 * send immediately.
 */
export function shouldHoldSend(delayMs: number, text: string): boolean {
  return delayMs > 0 && text.trim().length > 0;
}
