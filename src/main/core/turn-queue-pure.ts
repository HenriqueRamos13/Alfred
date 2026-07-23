/**
 * Pure FIFO turn-queue helper for the orchestrator's single-flight drain.
 * No IO, no node:* — safe under --experimental-strip-types and unit-testable.
 */

/** Runaway guard: past this many *pending* turns we drop the oldest (with a log). */
export const TURN_QUEUE_MAX = 20;

/**
 * Append a turn to the pending queue. Bounded: past `max`, drops the oldest
 * pending turn and returns it so the caller can log the runaway — never a
 * silent unbounded grow, never a silent drop.
 */
export function enqueueTurn(queue: string[], text: string, max = TURN_QUEUE_MAX): { dropped: string | null } {
  queue.push(text);
  if (queue.length > max) return { dropped: queue.shift() ?? null };
  return { dropped: null };
}
