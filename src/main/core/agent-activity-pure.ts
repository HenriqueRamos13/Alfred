/**
 * Live per-agent activity — PURE & RENDERER-SAFE (Phase 8, stage 4).
 *
 * What a roster agent is doing RIGHT NOW, as data: a token'd LIFO stack of
 * activity entries per agent, plus the resolution rule that collapses that stack
 * into the single state the UI shows.
 *
 * Why a STACK and not one state: activities nest. The attended `agent_study`
 * path delegates to `delegate_to_agent`, so a 'working' entry opens inside the
 * 'studying' one; a governance approval opens a 'waiting-approval' entry inside
 * whichever turn is running. Each begin/end pair carries its OWN token, so the
 * inner one ending never clears the outer one (and an `end()` replayed twice is
 * a no-op) — no bookkeeping bug can leave an agent stuck "working" forever.
 *
 * Precedence answers "what does the human care about": a blocked approval beats
 * everything (it needs them), a study beats the turn that implements it, work is
 * the floor. Zero `node:*` / electron imports — the TEAM card imports this.
 * The stateful registry that owns the stacks lives in agent-activity.ts (main).
 */

/** What an agent is doing, as shown in the UI. */
export type AgentActivityState = 'idle' | 'working' | 'studying' | 'waiting-approval';

/** The resolved, renderable activity of one agent. */
export interface AgentActivity {
  state: AgentActivityState;
  /** Short human hint (the task / the topic). Absent for 'idle' and bare waits. */
  label?: string;
  /** When the winning activity started (ms epoch); for 'idle', when it was observed. */
  since: number;
}

/** One open activity: `token` is what its `end()` removes — never the state or label. */
export interface ActivityEntry {
  token: number;
  /** 'idle' is the ABSENCE of entries, so it can never be pushed. */
  state: Exclude<AgentActivityState, 'idle'>;
  label?: string;
  since: number;
}

/** Higher wins. A human-blocking wait outranks a study, which outranks plain work. */
const RANK: Record<Exclude<AgentActivityState, 'idle'>, number> = {
  working: 1,
  studying: 2,
  'waiting-approval': 3,
};

/** Open an activity: append (newest last). Returns a NEW array — never mutates. */
export function pushActivity(entries: readonly ActivityEntry[], e: ActivityEntry): ActivityEntry[] {
  return [...entries, e];
}

/**
 * Close the activity with this token. An unknown token — or one already removed
 * — is a NO-OP, which is what makes a replayed `end()` safe. Removal is by token
 * only, so entries may close out of order (a study outliving its inner turn).
 */
export function removeActivity(entries: readonly ActivityEntry[], token: number): ActivityEntry[] {
  return entries.filter((e) => e.token !== token);
}

/**
 * Collapse the stack into what the UI shows: the highest-precedence entry; among
 * equals the most recent one (later `since`, then higher token — tokens are
 * monotonic, so this is deterministic even within the same millisecond). The
 * winner's own label + `since` are carried through. Empty stack → idle at `now`.
 */
export function resolveActivity(entries: readonly ActivityEntry[], now: number): AgentActivity {
  let best: ActivityEntry | undefined;
  for (const e of entries) {
    if (!best) {
      best = e;
      continue;
    }
    const r = RANK[e.state];
    const rb = RANK[best.state];
    if (r > rb || (r === rb && (e.since > best.since || (e.since === best.since && e.token > best.token)))) best = e;
  }
  if (!best) return { state: 'idle', since: now };
  return best.label ? { state: best.state, label: best.label, since: best.since } : { state: best.state, since: best.since };
}

/**
 * One-line display label out of an arbitrary task/topic string: whitespace (and
 * newlines — tasks are often multi-line prompts) collapsed to single spaces,
 * trimmed, then clipped to `max` characters INCLUDING the ellipsis so the card
 * row can never be blown open by a 4 KB prompt.
 */
export function truncateLabel(s: string, max = 64): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(0, max - 1))}…`;
}
