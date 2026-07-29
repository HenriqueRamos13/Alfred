import type { UserMsgStatus } from './thread-pure.ts';

type DB = import('better-sqlite3').Database;

export interface TurnMetricTimestamps {
  queuedTs: number;
  startedTs?: number;
  contextReadyTs?: number;
  firstTokenTs?: number;
  doneTs?: number;
}

export function turnMetricDurations(ts: TurnMetricTimestamps): {
  queueMs?: number;
  contextMs?: number;
  ttftMs?: number;
  totalMs?: number;
} {
  const duration = (end: number | undefined, start: number | undefined): number | undefined =>
    end === undefined || start === undefined ? undefined : Math.max(0, end - start);
  return {
    queueMs: duration(ts.startedTs, ts.queuedTs),
    contextMs: duration(ts.contextReadyTs, ts.startedTs),
    ttftMs: duration(ts.firstTokenTs, ts.startedTs),
    totalMs: duration(ts.doneTs, ts.queuedTs),
  };
}

export function createTurnMetric(
  db: DB,
  metric: { messageId: string; scope: 'main' | 'thread'; targetId: string; queuedTs: number },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO turn_metrics(message_id, scope, target_id, queued_ts, status)
     VALUES (?, ?, ?, ?, 'queued')`,
  ).run(metric.messageId, metric.scope, metric.targetId, metric.queuedTs);
}

export function startTurnMetrics(
  db: DB,
  ids: readonly string[],
  provider?: string,
  model?: string,
  ts = Date.now(),
): void {
  const stmt = db.prepare(
    `UPDATE turn_metrics
        SET started_ts = COALESCE(started_ts, ?), provider = COALESCE(?, provider),
            model = COALESCE(?, model), status = 'executing'
      WHERE message_id = ?`,
  );
  for (const id of ids) stmt.run(ts, provider ?? null, model ?? null, id);
}

export function markTurnMetricsContextReady(db: DB, ids: readonly string[], ts = Date.now()): void {
  const stmt = db.prepare('UPDATE turn_metrics SET context_ready_ts = COALESCE(context_ready_ts, ?) WHERE message_id = ?');
  for (const id of ids) stmt.run(ts, id);
}

export function markTurnMetricsFirstToken(db: DB, ids: readonly string[], ts = Date.now()): void {
  const stmt = db.prepare('UPDATE turn_metrics SET first_token_ts = COALESCE(first_token_ts, ?) WHERE message_id = ?');
  for (const id of ids) stmt.run(ts, id);
}

export function markTurnMetricStatus(
  db: DB,
  ids: readonly string[],
  status: UserMsgStatus,
  ts = Date.now(),
): void {
  const terminal = status === 'done' || status === 'error' || status === 'dropped';
  const stmt = terminal
    ? db.prepare('UPDATE turn_metrics SET status = ?, done_ts = COALESCE(done_ts, ?) WHERE message_id = ?')
    : db.prepare('UPDATE turn_metrics SET status = ? WHERE message_id = ?');
  for (const id of ids) {
    if (terminal) stmt.run(status, ts, id);
    else stmt.run(status, id);
  }
}
