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
import { useEffect, useState } from 'react';
import { alfred } from '../lib/ipc.ts';
import { humanizeSchedule, relativeTime, formatBudget, describeApproval } from '../../main/core/jobs-format-pure.ts';
import type { Job, JobApproval, StreamEvent } from '../../main/core/types.ts';

function summarizeResult(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** State chip: enabled / paused (+ reason). */
function stateLabel(job: Job): { text: string; tone: string } {
  if (!job.enabled) return { text: 'PAUSADO', tone: 'var(--dim)' };
  const r = job.runtime.pausedReason;
  if (r === 'budget') return { text: 'PAUSADO · orçamento', tone: 'var(--amber)' };
  if (r === 'approval') return { text: 'PAUSADO · aprovação', tone: 'var(--amber)' };
  if (r === 'error') return { text: 'PAUSADO · erro', tone: 'var(--red)' };
  return { text: 'ATIVO', tone: 'var(--lime, #b8ff3a)' };
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
      {approvals.length > 0 && (
        <div>
          <div style={sectionHead}>APROVAÇÕES PENDENTES · {approvals.length}</div>
          {approvals.map((a) => (
            <div key={a.id} style={{ ...box, borderColor: 'var(--amber)' }}>
              <div style={{ fontSize: 12, marginBottom: 6, lineHeight: 1.4 }}>{describeApproval(a.toolName, a.args)}</div>
              <div style={{ fontSize: 10, color: 'var(--dim)', marginBottom: 8 }}>{relativeTime(a.ts, now)}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="no-drag" style={{ ...btn, borderColor: 'var(--lime, #b8ff3a)', color: 'var(--lime, #b8ff3a)' }} onClick={() => resolve(a.id, true)}>
                  ✓ Aprovar
                </button>
                <button type="button" className="no-drag" style={{ ...btn, borderColor: 'var(--red)', color: 'var(--red)' }} onClick={() => resolve(a.id, false)}>
                  ✕ Recusar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <div style={sectionHead}>TAREFAS · {jobs.length}</div>
        {jobs.length === 0 ? (
          <div className="empty">NO SCHEDULED TASKS</div>
        ) : (
          jobs.map((job) => {
            const st = stateLabel(job);
            const paused = !job.enabled || !!job.runtime.pausedReason;
            return (
              <div key={job.id} style={box}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {job.title}
                  </span>
                  <span style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--cyan, #35e5ff)', border: '1px solid currentColor', borderRadius: 4, padding: '0 5px' }}>
                    {job.kind}
                  </span>
                  <span style={{ fontSize: 9, textTransform: 'uppercase', color: st.tone }}>{st.text}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--dim)', display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginBottom: 6 }}>
                  <span>⏱ {humanizeSchedule(job.schedule)}</span>
                  {job.kind === 'agent' && <span>tok {formatBudget(job.runtime.tokensToday, job.tokenBudgetDaily)}</span>}
                  <span>último {relativeTime(job.runtime.lastRunTs, now)}</span>
                  <span>próximo {paused ? '—' : relativeTime(job.runtime.nextRunTs, now)}</span>
                </div>
                {job.runtime.lastResult != null && (
                  <div style={{ fontSize: 11, color: 'var(--text)', opacity: 0.85, marginBottom: 8, wordBreak: 'break-word' }}>
                    {summarizeResult(job.runtime.lastResult)}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  {paused ? (
                    <button type="button" className="no-drag" style={btn} onClick={() => resume(job.id)}>▶ Retomar</button>
                  ) : (
                    <button type="button" className="no-drag" style={btn} onClick={() => pause(job.id)}>❚❚ Pausar</button>
                  )}
                  {confirmDelete === job.id ? (
                    <>
                      <button type="button" className="no-drag" style={{ ...btn, borderColor: 'var(--red)', color: 'var(--red)' }} onClick={() => del(job.id)}>
                        Confirmar apagar
                      </button>
                      <button type="button" className="no-drag" style={btn} onClick={() => setConfirmDelete(null)}>Cancelar</button>
                    </>
                  ) : (
                    <button type="button" className="no-drag" style={{ ...btn, borderColor: 'var(--red)', color: 'var(--red)' }} onClick={() => setConfirmDelete(job.id)}>
                      🗑 Apagar
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const sectionHead: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.08em',
  color: 'var(--dim)',
  textTransform: 'uppercase',
  marginBottom: 6,
};

const box: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '8px 10px',
  marginBottom: 8,
  background: 'var(--panel-2, rgba(255,255,255,0.02))',
};

const btn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: 6,
  color: 'var(--dim)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11,
  padding: '3px 9px',
};
