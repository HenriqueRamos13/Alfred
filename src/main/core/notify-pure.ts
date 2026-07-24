/**
 * Notifications / heartbeat — PURE logic (Phase 7, stage 4). Renderer-safe: MUST
 * stay free of any `node:*` / better-sqlite3 import so the Activity feed (UI), the
 * heartbeat runner (main), and the `notify_agent` tool all share ONE definition of
 * the notification kinds, the SELF-LIMITING heartbeat, the dependency wake, and the
 * up-the-chain notify permission — every rule unit-testable via strip-types.
 *
 * The research principle (§4/§11/§12): notify by EVENT, never blind time; wake a
 * TARGET (one card = one assignee), never a broadcast; the heartbeat is
 * self-limiting — finite pokes (`maxNudges`) then ONE escalation up the parent
 * chain, and a hard `timeoutMs` ceiling, so it can NEVER loop "unlimited". The
 * IO/db side lives in core/notify.ts; this module holds only total functions.
 */

// ── notification shape ─────────────────────────────────────────────────────────

/** The lifecycle + orchestration events an agent is woken by. */
export const NOTIFICATION_KINDS = [
  'assigned',
  'review_requested',
  'done',
  'dep_ready',
  'reply',
  'nudge',
  'escalation',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export function isNotificationKind(v: unknown): v is NotificationKind {
  return typeof v === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(v);
}

export interface AgentNotification {
  id: string;
  /** Recipient: an agentId or 'user' — a TARGET, never a broadcast. */
  toAgentId: string;
  projectSlug: string | null;
  cardId: string | null;
  kind: NotificationKind;
  text: string;
  createdTs: number;
  /** null = unseen (drives the badge); stamped once when marked seen. */
  seenTs: number | null;
}

// ── org helpers (shared by escalation + notify permission) ───────────────────

/** Minimal shape the chain helpers need. */
type OrgLink = { id: string; parentId?: string | null };
/** …plus the privilege role for the notify-permission direction rule. */
type OrgAgent = OrgLink & { delegationRole?: 'leaf' | 'orchestrator' };

/**
 * Is `ancestorId` somewhere on `nodeId`'s manager chain (strictly above it)?
 * Cycle-safe: a `seen` set bounds the walk to the roster size. Pure.
 */
function isAncestor(agents: readonly OrgLink[], ancestorId: string, nodeId: string): boolean {
  const byId = new Map(agents.map((a) => [a.id, a] as const));
  const seen = new Set<string>();
  let cur = byId.get(nodeId)?.parentId ?? null;
  while (cur != null && byId.has(cur) && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = byId.get(cur)!.parentId ?? null;
  }
  return false;
}

/**
 * Who an escalation for `agentId` goes to: its parent (manager), or null at the
 * top of the org (the caller maps null → the user). Pure.
 */
export function escalationTarget(agentId: string, agents: readonly OrgLink[]): string | null {
  const a = agents.find((x) => x.id === agentId);
  const parent = a?.parentId ?? null;
  return parent && parent.trim() ? parent : null;
}

/**
 * May `fromId` notify `toId`? A LEAF may only notify UP its own manager chain
 * (report upward); an ORCHESTRATOR may also notify DOWN to its descendants (direct
 * a report). Self-notify, or a hop across an unrelated branch, is refused. A
 * `fromId` that is not in the roster (the top-level Alfred turn) is handled by the
 * caller, NOT here — this returns false for it, so the tool must allow Alfred
 * explicitly. Cycle-safe + pure.
 */
export function notifyPermission(fromId: string, toId: string, agents: readonly OrgAgent[]): boolean {
  if (!fromId || !toId || fromId === toId) return false;
  const from = agents.find((a) => a.id === fromId);
  if (!from) return false;
  if (isAncestor(agents, toId, fromId)) return true; // toId is a manager above fromId — always OK
  const down = isAncestor(agents, fromId, toId); // toId is a descendant of fromId
  return from.delegationRole === 'orchestrator' && down;
}

// ── dependency wake (a card completes → wake the cards that depend on it) ─────

/** Minimal card shape the dependency wake needs. */
export interface DependencyCard {
  id: string;
  column: string;
  assigneeId: string | null;
  dependsOn: string[];
}

export interface DependencyWake {
  cardId: string;
  /** The downstream card's assignee to wake (null when it is unassigned). */
  toAgentId: string | null;
  /** Every dependency of the downstream card is now `done`. */
  allDepsDone: boolean;
  /** The downstream card is `blocked` AND every dep is done → the caller may unblock it. */
  unblock: boolean;
}

/**
 * When `doneCardId` reaches Done, which cards that DEPEND on it should be woken?
 * Returns one entry per card whose `dependsOn` includes `doneCardId` (targeted —
 * never a board-wide broadcast). `allDepsDone` says whether the downstream card is
 * fully unblocked; `unblock` is true only when it was in the `blocked` lane AND all
 * its deps are done, so the caller can move it back into flow. Pure.
 */
export function dependencyWakes(cards: readonly DependencyCard[], doneCardId: string): DependencyWake[] {
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  const out: DependencyWake[] = [];
  for (const c of cards) {
    if (!c.dependsOn.includes(doneCardId)) continue;
    const allDepsDone = c.dependsOn.every((d) => byId.get(d)?.column === 'done');
    const assignee = (c.assigneeId ?? '').trim();
    out.push({
      cardId: c.id,
      toAgentId: assignee || null,
      allDepsDone,
      unblock: c.column === 'blocked' && allDepsDone,
    });
  }
  return out;
}

// ── heartbeat (self-limiting: finite pokes → one escalation up the chain) ─────

export interface HeartbeatConfig {
  /** Idle time on an open card before a NUDGE fires. FINITE — never "unlimited". */
  pokeIntervalMs: number;
  /** Nudges to the assignee before ESCALATING to the parent (the self-limiting cap). */
  maxNudges: number;
  /** Hard ceiling: past this since the last real activity the card is stale → escalate straight away. */
  timeoutMs: number;
}

/** Sane finite defaults (30-min poke, 3 nudges, 4-h hard timeout). */
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  pokeIntervalMs: 30 * 60_000,
  maxNudges: 3,
  timeoutMs: 4 * 60 * 60_000,
};

/** The lanes a heartbeat watches — OPEN, in-flight work (never done/failed/blocked/backlog/todo). */
const ACTIVE_LANES: ReadonlySet<string> = new Set(['doing', 'review']);

/** Minimal card shape the heartbeat needs. KanbanCard is a superset (assignable). */
export interface HeartbeatCard {
  id: string;
  projectSlug: string;
  column: string;
  assigneeId: string | null;
  /** Last real activity on the card (a move/edit bumps it; a nudge does NOT). */
  updatedTs: number;
  /** Per-card hard timeout override; null → cfg.timeoutMs. */
  timeoutMs: number | null;
}

/** Per-card nudge history (derived from stored nudge/escalation notifications). */
export interface NudgeState {
  /** Nudges already sent for this card. */
  count: number;
  /** ts of the most recent nudge/escalation (0 when none) — so pokes are SPACED. */
  lastTs: number;
  /** An escalation already fired → the card is capped (no more heartbeat actions). */
  escalated: boolean;
}

export interface HeartbeatAction {
  toAgentId: string;
  cardId: string;
  projectSlug: string;
  kind: 'nudge' | 'escalation';
}

/**
 * One heartbeat sweep. For every OPEN card (in doing/review) with an assignee that
 * has been idle past `pokeIntervalMs`, emit a targeted NUDGE to the assignee; after
 * `maxNudges` (or once the hard `timeoutMs` is blown) emit ONE ESCALATION up the
 * parent chain (null parent → the user). An already-escalated card is skipped, so
 * the loop is bounded to at most `maxNudges` nudges + 1 escalation per card — it
 * can NEVER fire "unlimited". Nudges are spaced by the poke interval (idle counts
 * from the later of the last activity and the last poke), so a sweep that runs more
 * often than the interval does not burst. Pure — the runner persists + emits.
 */
export function heartbeatTick(
  cards: readonly HeartbeatCard[],
  agents: readonly OrgLink[],
  now: number,
  cfg: HeartbeatConfig,
  state: Readonly<Record<string, NudgeState>> = {},
): HeartbeatAction[] {
  const out: HeartbeatAction[] = [];
  for (const card of cards) {
    if (!ACTIVE_LANES.has(card.column)) continue;
    const assignee = (card.assigneeId ?? '').trim();
    if (!assignee) continue; // targeted only — an unowned card has nobody to wake

    const s = state[card.id] ?? { count: 0, lastTs: 0, escalated: false };
    if (s.escalated) continue; // capped — self-limiting, never re-escalate in a loop

    const reference = Math.max(card.updatedTs, s.lastTs);
    if (now - reference < cfg.pokeIntervalMs) continue; // not stalled long enough since the last poke

    const hardTimeout = card.timeoutMs != null && card.timeoutMs > 0 ? card.timeoutMs : cfg.timeoutMs;
    const stale = now - card.updatedTs > hardTimeout;

    if (stale || s.count >= cfg.maxNudges) {
      out.push({
        toAgentId: escalationTarget(assignee, agents) ?? 'user',
        cardId: card.id,
        projectSlug: card.projectSlug,
        kind: 'escalation',
      });
    } else {
      out.push({ toAgentId: assignee, cardId: card.id, projectSlug: card.projectSlug, kind: 'nudge' });
    }
  }
  return out;
}
