/**
 * The live agent-activity REGISTRY (Phase 8, stage 4) — main-process only.
 *
 * Owns one activity stack per roster agent and emits `agent.activity` when the
 * RESOLVED activity of an agent actually changes. The pure stack + resolution
 * rules live in agent-activity-pure.ts (renderer-safe); this file is only the
 * mutable state around them.
 *
 * ponytail: in-process Map, exactly like `activeByParent` in delegate-to-agent.ts
 * — there is one orchestrator process, and this state is deliberately EPHEMERAL:
 * nothing is running after a restart, so an empty registry ("inativo") is the
 * truthful answer, whereas a persisted row would be a lie waiting to be believed.
 *
 * Usage is always bracket-style, so a throw/abort can never leak a stuck state:
 *   const end = beginActivity(ctx.emit, agent.id, 'working', truncateLabel(task));
 *   try { … } finally { end(); }
 */
import {
  pushActivity,
  removeActivity,
  resolveActivity,
  type ActivityEntry,
  type AgentActivity,
  type AgentActivityState,
} from './agent-activity-pure.ts';
import type { StreamEvent } from './types.ts';

/** agentId → its OPEN activity entries (LIFO nesting; empty/absent = idle). */
const stacks = new Map<string, ActivityEntry[]>();
/** Monotonic token source — the handle an `end()` removes, never a state/label match. */
let nextToken = 1;

function entriesFor(agentId: string): readonly ActivityEntry[] {
  return stacks.get(agentId) ?? [];
}

/** Two resolved activities look the same to the UI (state + label; `since` alone is not news). */
function sameActivity(a: AgentActivity, b: AgentActivity): boolean {
  return a.state === b.state && (a.label ?? '') === (b.label ?? '');
}

/**
 * The stream is best-effort UI candy: a broken emitter must never break the turn
 * it is describing (this runs inside a `finally`). Log with context — never swallow.
 */
function safeEmit(emit: (e: StreamEvent) => void, agentId: string, activity: AgentActivity): void {
  try {
    emit({ kind: 'agent.activity', agentId, activity });
  } catch (err) {
    console.error('[agent-activity] emit failed', { agentId, state: activity.state, err });
  }
}

/**
 * Open an activity for `agentId` and return its IDEMPOTENT closer. Emits only
 * when the resolved activity changes — so an inner 'working' entry nested under
 * an outer 'studying' one is silent (studying still wins), and closing it is
 * silent too. Calling the returned `end()` twice is a no-op.
 */
export function beginActivity(
  emit: (e: StreamEvent) => void,
  agentId: string,
  state: Exclude<AgentActivityState, 'idle'>,
  label?: string,
): () => void {
  const now = Date.now();
  const before = resolveActivity(entriesFor(agentId), now);
  const token = nextToken++;
  const entry: ActivityEntry = label ? { token, state, label, since: now } : { token, state, since: now };
  stacks.set(agentId, pushActivity(entriesFor(agentId), entry));
  const after = resolveActivity(entriesFor(agentId), now);
  if (!sameActivity(before, after)) safeEmit(emit, agentId, after);

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const ts = Date.now();
    const prev = resolveActivity(entriesFor(agentId), ts);
    const rest = removeActivity(entriesFor(agentId), token);
    // Drop the key entirely when the agent goes idle, so the Map can't grow
    // unbounded with empty arrays over a long session.
    if (rest.length === 0) stacks.delete(agentId);
    else stacks.set(agentId, rest);
    const next = resolveActivity(rest, ts);
    if (!sameActivity(prev, next)) safeEmit(emit, agentId, next);
  };
}

/** This agent's current activity (idle when it has nothing open). */
export function getActivity(agentId: string): AgentActivity {
  return resolveActivity(entriesFor(agentId), Date.now());
}
