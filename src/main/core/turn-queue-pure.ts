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

/**
 * Coalesce a batch of pending turns into ONE prompt (Claude-Code-style): while a
 * turn runs, the messages that pile up behind it are joined and run as a single
 * next turn. Empty/whitespace entries are dropped; the rest are joined by a blank
 * line. One text returns unchanged; an empty (or all-blank) list returns "".
 */
export function coalesceTurns(texts: string[]): string {
  return texts.map((t) => t.trim()).filter((t) => t.length > 0).join('\n\n');
}

// ── identified turns (Phase 8 stage 7) ────────────────────────────────────────
//
// The status ladder (thread-pure.ts) needs to say WHICH stored message is queued /
// executing / done / dropped, so the queue carries the persisted message id next to
// the text. Same FIFO + same bound as the string API above. Since stage 8 BOTH
// queues (the main chat and every user↔agent thread) run on the item API; the string
// functions stay as the id-less reference implementation the item ones mirror.

/** A pending turn plus the id of the row it was persisted as. */
export interface TurnItem {
  /** The persisted message id (`messages.id` or `agent_thread_messages.id`). */
  id: string;
  text: string;
}

/**
 * Append a turn item. Bounded exactly like `enqueueTurn`: past `max` the OLDEST
 * item is dropped and RETURNED, so the caller can both log the runaway and mark
 * that message `dropped` on the ladder (a user message never vanishes silently).
 */
export function enqueueTurnItem(queue: TurnItem[], item: TurnItem, max = TURN_QUEUE_MAX): { dropped: TurnItem | null } {
  queue.push(item);
  if (queue.length > max) return { dropped: queue.shift() ?? null };
  return { dropped: null };
}

/**
 * Coalesce a batch of turn items into ONE prompt plus the ids that actually made it
 * in. Blank-only texts contribute NEITHER text nor id: they are not part of the
 * prompt, so the caller must not mark them executing/done on the ladder. Pure.
 */
export function coalesceTurnItems(items: readonly TurnItem[]): { text: string; ids: string[] } {
  const kept = items.map((i) => ({ id: i.id, text: i.text.trim() })).filter((i) => i.text.length > 0);
  return { text: kept.map((i) => i.text).join('\n\n'), ids: kept.map((i) => i.id) };
}
