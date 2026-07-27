/**
 * "AT WORK" card selectors — PURE & RENDERER-SAFE (Phase P4).
 *
 * A read-only VIEW over the live activity the roster already carries: it does
 * NOT own or emit anything. `agent-activity-pure.ts` (the concurrent engine)
 * resolves each agent's stack into `activity`; this module only slices the
 * roster into "who is busy right now" and counts the states. Zero `node:*` /
 * electron imports — the AT WORK card imports this directly.
 */

import type { AgentActivity, AgentActivityState } from './agent-activity-pure.ts';

/** The one field this view needs; any roster row (TeamAgentInfo) satisfies it. */
export interface HasActivity {
  activity?: AgentActivity;
}

/** A missing activity means the engine has nothing open for that agent → idle. */
function stateOf(a: HasActivity): AgentActivityState {
  return a.activity?.state ?? 'idle';
}

/** Higher = more human-relevant. Same precedence as the engine's RANK (waiting > study > work). */
const ORDER: Record<AgentActivityState, number> = {
  'waiting-approval': 3,
  studying: 2,
  working: 1,
  idle: 0,
};

/**
 * The busy agents (activity.state !== 'idle'; no activity = idle = excluded),
 * most-relevant first: waiting-approval, then studying, then working. Stable
 * within a state (original roster order preserved). Returns a new array.
 */
export function agentsAtWork<T extends HasActivity>(agents: readonly T[]): T[] {
  return agents
    .filter((a) => stateOf(a) !== 'idle')
    .sort((a, b) => ORDER[stateOf(b)] - ORDER[stateOf(a)]);
}

/** Per-state head-count of the whole roster (`waiting` = waiting-approval). */
export function atWorkSummary(agents: readonly HasActivity[]): {
  working: number;
  studying: number;
  waiting: number;
  idle: number;
} {
  const c = { working: 0, studying: 0, waiting: 0, idle: 0 };
  for (const a of agents) {
    switch (stateOf(a)) {
      case 'working':
        c.working++;
        break;
      case 'studying':
        c.studying++;
        break;
      case 'waiting-approval':
        c.waiting++;
        break;
      default:
        c.idle++;
    }
  }
  return c;
}
