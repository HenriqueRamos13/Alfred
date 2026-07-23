/**
 * ScheduledTasksCard — the Phase 4 "Scheduled Tasks" management card (stage 3).
 *
 * Self-contained like GraphCard: reads the job list + the pending sensitive-action
 * approval queue over IPC on mount, and stays live by listening to the SAME
 * stream the rest of the UI gets — `job.data` (a run refreshed) and `job.approval`
 * (an approval was created/resolved) trigger a cheap re-fetch. Zero new tools.
 *
 * Per job: title, kind, a legible schedule, state (enabled / paused + reason),
 * tokens today / limit, last + next run (relative), a lastResult summary, and
 * Pause/Resume + Delete (with confirm) buttons. The APPROVALS section shows a
 * clear human description of each queued action (so the user knows what they are
 * approving) with Approve / Deny. All display strings come from the tested pure
 * formatters (jobs-format-pure.ts).
 */
import { Fragment, useEffect, useState } from 'react';
import { alfred } from '../lib/ipc.ts';
import { humanizeSchedule, relativeTime, formatBudget, describeApproval } from '../../main/core/jobs-format-pure.ts';
import type { Job, JobApproval, JobKind, StreamEvent } from '../../main/core/types.ts';

function summarizeResult(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** Kind → coloured type tag (ported palette: agent=magenta, fetch=cyan, study=amber). */
const KIND_TAG: Record<JobKind, { label: string; cls: string }> = {
  agent: { label: 'AGENTE', cls: 'agent' },
  fetch: { label: 'FETCH', cls: 'fetch' },
  study: { label: 'ESTUDO', cls: 'study' },
};

/** Run/pause state → the last→next cell tone + a ✓/✗ glyph. */
function runState(job: Job): { cls: string; glyph: string } {
  const r = job.runtime.pausedReason;
  if (r === 'error') return { cls: 'err', glyph: '✗' };
  if (!job.enabled || r === 'budget' || r === 'approval') return { cls: 'warn', glyph: '❚❚' };
  return { cls: 'ok', glyph: job.runtime.lastRunTs ? '✓' : '·' };
}

export function ScheduledTasksCard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [approvals, setApprovals] = useState<JobApproval[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refetch = (): void => {
    alfred.listJobs().then(setJobs).catch(() => {});
    alfred.listPendingApprovals().then(setApprovals).catch(() => {});
    setNow(Date.now());
  };

  useEffect(() => {
    refetch();
    // Keep relative times honest without a re-fetch storm.
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    const off = alfred.onStream((e: StreamEvent) => {
      if (e.kind === 'job.data' || e.kind === 'job.approval') refetch();
      else if (e.kind === 'agent.status' && (e.status === 'done' || e.status === 'idle')) refetch();
    });
    return () => {
      clearInterval(clock);
      off();
    };
  }, []);

  const pause = (id: string): void => {
    alfred.pauseJob(id).then(refetch).catch(() => {});
  };
  const resume = (id: string): void => {
    alfred.resumeJob(id).then(refetch).catch(() => {});
  };
  const del = (id: string): void => {
    alfred.deleteJob(id).then(() => {
      setConfirmDelete(null);
      refetch();
    }).catch(() => {});
  };
  const resolve = (id: string, approved: boolean): void => {
    alfred.resolveJobApproval(id, approved).then(refetch).catch(() => {});
  };

  return (
    <div className="sched" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
      <div>
        {jobs.length === 0 ? (
          <div className="empty">NO SCHEDULED TASKS</div>
        ) : (
          <div className="sched-table">
            <span className="sched-th">TAREFA</span>
            <span className="sched-th">AGENDA</span>
            <span className="sched-th">TOKENS HOJE</span>
            <span className="sched-th">ÚLTIMO → PRÓXIMO</span>
            {jobs.map((job) => {
              const tag = KIND_TAG[job.kind];
              const rs = runState(job);
              const paused = !job.enabled || !!job.runtime.pausedReason;
              const usesAi = job.kind === 'agent' || job.kind === 'study';
              return (
                <Fragment key={job.id}>
                  <span className="sched-task" title={job.title}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.title}</span>
                    <span className={`sched-tag ${tag.cls}`}>{tag.label}</span>
                  </span>
                  <span className="sched-cell">{humanizeSchedule(job.schedule)}</span>
                  <span className="sched-cell">
                    {usesAi ? formatBudget(job.runtime.tokensToday, job.tokenBudgetDaily) : '0 (sem IA)'}
                  </span>
                  <span className={`sched-cell sched-state ${rs.cls}`}>
                    {relativeTime(job.runtime.lastRunTs, now)} {rs.glyph} → {paused ? '—' : relativeTime(job.runtime.nextRunTs, now)}
                  </span>
                  {job.runtime.lastResult != null && (
                    <span className="sched-cell" style={{ gridColumn: '1 / -1', opacity: 0.7, wordBreak: 'break-word', whiteSpace: 'normal' }}>
                      {summarizeResult(job.runtime.lastResult)}
                    </span>
                  )}
                  <span className="sched-actions">
                    {paused ? (
                      <button type="button" className="sched-btn no-drag" onClick={() => resume(job.id)}>▶ Retomar</button>
                    ) : (
                      <button type="button" className="sched-btn no-drag" onClick={() => pause(job.id)}>❚❚ Pausar</button>
                    )}
                    {confirmDelete === job.id ? (
                      <>
                        <button type="button" className="sched-btn danger no-drag" onClick={() => del(job.id)}>Confirmar apagar</button>
                        <button type="button" className="sched-btn no-drag" onClick={() => setConfirmDelete(null)}>Cancelar</button>
                      </>
                    ) : (
                      <button type="button" className="sched-btn danger no-drag" onClick={() => setConfirmDelete(job.id)}>🗑 Apagar</button>
                    )}
                  </span>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>

      {approvals.length > 0 && (
        <div>
          <div className="sched-ap-head">⚠ APROVAÇÕES PENDENTES — {approvals.length}</div>
          {approvals.map((a) => (
            <div key={a.id} className="sched-ap">
              <div className="sched-ap-body">
                <div className="sched-ap-meta">{relativeTime(a.ts, now)}</div>
                <div className="sched-ap-text">{describeApproval(a.toolName, a.args)}</div>
              </div>
              <button type="button" className="sched-ap-btn ok no-drag" onClick={() => resolve(a.id, true)}>APROVAR</button>
              <button type="button" className="sched-ap-btn no no-drag" onClick={() => resolve(a.id, false)}>RECUSAR</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
