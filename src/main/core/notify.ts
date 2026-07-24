/**
 * Notifications — persistence (agent_notifications table) + the heartbeat runner.
 * MAIN-only: takes the Database by PARAMETER (never value-imports the driver), so
 * the pure logic (notify-pure.ts) stays testable and this file is a thin IO layer.
 *
 * This is the "create the notifications de facto" side of Stage 4: the kanban write
 * surfaces feed applyCardNotifications the lifecycle `events`, the inbox answer
 * calls notifyReply, and the JobScheduler drives runHeartbeatTick. Every write is a
 * TARGETED row (one recipient) — never a broadcast — and writing a row is a safe
 * internal action, so the heartbeat is safe to run unattended (fail-closed holds:
 * it neither delegates nor calls a governed tool).
 *
 * Import direction is one-way: notify.ts → kanban.ts / team.ts (for the heartbeat
 * sweep + dependency wakes); neither of those imports notify.ts, so there is no
 * cycle. kanban.ts only RETURNS the events; the callers apply them here.
 */
import { randomUUID } from 'node:crypto';
import {
  dependencyWakes,
  heartbeatTick,
  DEFAULT_HEARTBEAT_CONFIG,
  type AgentNotification,
  type HeartbeatConfig,
  type NotificationKind,
  type NudgeState,
} from './notify-pure.ts';
import { lifecycleRecipients, type KanbanCard, type LifecycleEvent } from './kanban-pure.ts';
import { listCards, listCardsByColumns, patchCard } from './kanban.ts';
import { listAgents } from './team.ts';
import type { StreamEvent } from './types.ts';

type DB = import('better-sqlite3').Database;

interface Row {
  id: string;
  to_agent_id: string;
  project_slug: string | null;
  card_id: string | null;
  kind: string;
  text: string;
  created_ts: number;
  seen_ts: number | null;
}

function rowToNotification(r: Row): AgentNotification {
  return {
    id: r.id,
    toAgentId: r.to_agent_id,
    projectSlug: r.project_slug ?? null,
    cardId: r.card_id ?? null,
    kind: r.kind as NotificationKind,
    text: r.text ?? '',
    createdTs: r.created_ts,
    seenTs: r.seen_ts ?? null,
  };
}

export interface NotificationFilter {
  /** Only notifications addressed to this recipient. */
  toAgentId?: string;
  /** Only notifications for this project (the Activity feed). */
  projectSlug?: string;
  /** Only unseen rows (the wake queue / badge). */
  unseenOnly?: boolean;
}

/** Notifications, newest first, optionally filtered by recipient / project / unseen. */
export function listNotifications(db: DB, filter: NotificationFilter = {}): AgentNotification[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.toAgentId) { where.push('to_agent_id = ?'); args.push(filter.toAgentId); }
  if (filter.projectSlug) { where.push('project_slug = ?'); args.push(filter.projectSlug); }
  if (filter.unseenOnly) where.push('seen_ts IS NULL');
  const sql = `SELECT * FROM agent_notifications${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_ts DESC, rowid DESC`;
  return (db.prepare(sql).all(...args) as Row[]).map(rowToNotification);
}

export interface NotificationSpec {
  toAgentId: string;
  projectSlug?: string | null;
  cardId?: string | null;
  kind: NotificationKind;
  text: string;
}

/** Insert one targeted notification. Throws only on a blank recipient (a bug). */
export function insertNotification(db: DB, spec: NotificationSpec): AgentNotification {
  const to = (spec.toAgentId ?? '').trim();
  if (!to) throw new Error('notification needs a non-empty toAgentId (targeted wake, never a broadcast)');
  const id = `NT-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_notifications (id, to_agent_id, project_slug, card_id, kind, text, created_ts, seen_ts)
     VALUES (@id, @to, @project, @card, @kind, @text, @now, NULL)`,
  ).run({ id, to, project: spec.projectSlug ?? null, card: spec.cardId ?? null, kind: spec.kind, text: spec.text ?? '', now });
  return { id, toAgentId: to, projectSlug: spec.projectSlug ?? null, cardId: spec.cardId ?? null, kind: spec.kind, text: spec.text ?? '', createdTs: now, seenTs: null };
}

/** Mark one notification seen (idempotent — only stamps seen_ts the first time). */
export function markNotificationSeen(db: DB, id: string): AgentNotification | undefined {
  db.prepare('UPDATE agent_notifications SET seen_ts = COALESCE(seen_ts, ?) WHERE id = ?').run(Date.now(), id);
  const r = db.prepare('SELECT * FROM agent_notifications WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToNotification(r) : undefined;
}

// ── card lifecycle → targeted notifications (the "de facto" wiring) ─────────────

/**
 * Turn the lifecycle `events` a kanban write produced into the actual notification
 * rows (via the pure lifecycleRecipients — assignee on assign, reviewer on review,
 * creator+for_whom on done). On `done` it ALSO runs the dependency wakes: any card
 * that depends on the just-completed one wakes its assignee (dep_ready), and a card
 * that was BLOCKED solely on now-satisfied deps is moved back into flow (blocked →
 * todo). Returns every created notification so the caller emits notification.changed.
 */
export function applyCardNotifications(db: DB, card: KanbanCard, events: readonly LifecycleEvent[]): AgentNotification[] {
  const out: AgentNotification[] = [];
  const label = `${card.id} "${card.title}"`;
  for (const ev of events) {
    if (ev === 'assign') {
      for (const to of lifecycleRecipients(card, 'assign')) {
        out.push(insertNotification(db, { toAgentId: to, projectSlug: card.projectSlug, cardId: card.id, kind: 'assigned', text: `Assigned to you: ${label}` }));
      }
    } else if (ev === 'review') {
      for (const to of lifecycleRecipients(card, 'review')) {
        out.push(insertNotification(db, { toAgentId: to, projectSlug: card.projectSlug, cardId: card.id, kind: 'review_requested', text: `Review requested: ${label}` }));
      }
    } else if (ev === 'done') {
      for (const to of lifecycleRecipients(card, 'done')) {
        out.push(insertNotification(db, { toAgentId: to, projectSlug: card.projectSlug, cardId: card.id, kind: 'done', text: `Done: ${label}` }));
      }
      out.push(...wakeDependents(db, card));
    }
  }
  return out;
}

/** dep_ready wakes + auto-unblock for the cards that depend on `doneCard`. */
function wakeDependents(db: DB, doneCard: KanbanCard): AgentNotification[] {
  const wakes = dependencyWakes(listCards(db, doneCard.projectSlug), doneCard.id);
  const out: AgentNotification[] = [];
  for (const w of wakes) {
    if (w.toAgentId) {
      const text = w.allDepsDone
        ? `Dependency clear — ${w.cardId} can proceed (${doneCard.id} done)`
        : `Dependency ${doneCard.id} done — ${w.cardId} still waiting on its other deps`;
      out.push(insertNotification(db, { toAgentId: w.toAgentId, projectSlug: doneCard.projectSlug, cardId: w.cardId, kind: 'dep_ready', text }));
    }
    // A card blocked ONLY by dependencies, now all satisfied → move it back into
    // flow so it stops sitting silently in Blocked (blocked → todo is allowed).
    if (w.unblock) patchCard(db, w.cardId, { column: 'todo' });
  }
  return out;
}

// ── inbox answer → re-wake the agent that asked ─────────────────────────────────

/**
 * The user answered a pending ask → wake the agent that raised it (`reply`), so a
 * delegated agent that yielded on a HITL checkpoint is re-woken. The top-level
 * Alfred turn ('alfred') is the user's live chat and polls nothing, so it is not
 * self-notified. Returns the created row (or undefined).
 */
export function notifyReply(
  db: DB,
  msg: { fromAgentId: string; projectSlug: string | null; cardId: string | null; subject: string },
): AgentNotification | undefined {
  const to = (msg.fromAgentId ?? '').trim();
  if (!to || to === 'alfred') return undefined;
  return insertNotification(db, { toAgentId: to, projectSlug: msg.projectSlug, cardId: msg.cardId, kind: 'reply', text: `Your ask was answered: ${msg.subject}` });
}

// ── heartbeat runner (ONE global sweep, self-limiting) ──────────────────────────

export interface HeartbeatRunOpts {
  emit?: (event: StreamEvent) => void;
  now?: () => number;
  cfg?: HeartbeatConfig;
}

/**
 * One heartbeat sweep across EVERY open card (doing/review) in ONE pass — not a job
 * per card. heartbeatTick (pure) decides the targeted nudges/escalations, bounded by
 * the config (finite pokes → one escalation up the chain), using the per-card nudge
 * history read back from the notification rows. Persists the actions + emits
 * notification.changed once. Zero AI tokens, no delegation, no governed tool — a
 * safe internal write, so it runs unattended without piercing fail-closed. Returns
 * the number of actions taken.
 */
export function runHeartbeatTick(db: DB, opts: HeartbeatRunOpts = {}): number {
  const now = (opts.now ?? Date.now)();
  const cfg = opts.cfg ?? DEFAULT_HEARTBEAT_CONFIG;
  const cards = listCardsByColumns(db, ['doing', 'review']);
  if (cards.length === 0) return 0;
  const agents = listAgents(db);
  const state = nudgeStateByCard(db, cards.map((c) => c.id));
  const actions = heartbeatTick(cards, agents, now, cfg, state);
  if (actions.length === 0) return 0;
  for (const a of actions) {
    const text =
      a.kind === 'nudge'
        ? `Nudge — ${a.cardId} has been idle; still on it?`
        : `Escalation — ${a.cardId} is stalled and needs your attention`;
    insertNotification(db, { toAgentId: a.toAgentId, projectSlug: a.projectSlug, cardId: a.cardId, kind: a.kind, text });
  }
  opts.emit?.({ kind: 'notification.changed' });
  return actions.length;
}

/** Per-card nudge history from the stored nudge/escalation rows (drives the cap). */
function nudgeStateByCard(db: DB, cardIds: readonly string[]): Record<string, NudgeState> {
  const out: Record<string, NudgeState> = {};
  if (cardIds.length === 0) return out;
  const ph = cardIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT card_id, kind, created_ts FROM agent_notifications WHERE kind IN ('nudge','escalation') AND card_id IN (${ph})`)
    .all(...cardIds) as { card_id: string; kind: string; created_ts: number }[];
  for (const r of rows) {
    if (!r.card_id) continue;
    const s = out[r.card_id] ?? { count: 0, lastTs: 0, escalated: false };
    if (r.kind === 'nudge') s.count++;
    if (r.kind === 'escalation') s.escalated = true;
    if (r.created_ts > s.lastTs) s.lastTs = r.created_ts;
    out[r.card_id] = s;
  }
  return out;
}
