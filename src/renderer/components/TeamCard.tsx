/**
 * TeamCard — the Phase 5 "TEAM" roster management card (stage 5).
 *
 * Self-contained like ScheduledTasksCard: on mount it reads the roster
 * projection (listTeamAgents — role/model, tokens today, studied topics from the
 * shared index), the pending sensitive-action approval queue, and the job list
 * (to map an approval → the agent whose scheduled STUDY job raised it). It stays
 * live by listening to the SAME stream the rest of the UI gets — job.approval /
 * job.data / agent.status trigger a cheap re-fetch. Zero new tools; create is not
 * exposed here (agents are made by the `team` command/tool).
 *
 * Per agent: name, role (leaf/orchestrator), provider:model, tokens today / limit,
 * studied topics, and that agent's pending approvals (Approve/Deny → resolveJobApproval).
 * Delete needs a double confirm. No XSS surface — all data lands in React text nodes.
 */
import { useEffect, useState } from 'react';
import { alfred } from '../lib/ipc.ts';
import { humanizeRole, formatAgentBudget } from '../../main/core/team-format-pure.ts';
import { relativeTime, describeApproval } from '../../main/core/jobs-format-pure.ts';
import type { Job, JobApproval, TeamAgentInfo, StreamEvent } from '../../main/core/types.ts';

export function TeamCard() {
  const [agents, setAgents] = useState<TeamAgentInfo[]>([]);
  const [approvals, setApprovals] = useState<JobApproval[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refetch = (): void => {
    alfred.listTeamAgents().then(setAgents).catch(() => {});
    alfred.listPendingApprovals().then(setApprovals).catch(() => {});
    alfred.listJobs().then(setJobs).catch(() => {});
    setNow(Date.now());
  };

  useEffect(() => {
    refetch();
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    const off = alfred.onStream((e: StreamEvent) => {
      if (e.kind === 'job.approval' || e.kind === 'job.data') refetch();
      else if (e.kind === 'agent.status' && (e.status === 'done' || e.status === 'idle')) refetch();
    });
    return () => {
      clearInterval(clock);
      off();
    };
  }, []);

  const del = (id: string): void => {
    alfred.deleteTeamAgent(id).then(() => {
      setConfirmDelete(null);
      refetch();
    }).catch(() => {});
  };
  const resolve = (id: string, approved: boolean): void => {
    alfred.resolveJobApproval(id, approved).then(refetch).catch(() => {});
  };

  // Map an approval → the agent that raised it, via its scheduled STUDY job.
  const agentByJob: Record<string, string> = {};
  for (const j of jobs) if (j.study) agentByJob[j.id] = j.study.agentId;
  const approvalsFor = (agentId: string): JobApproval[] => approvals.filter((a) => agentByJob[a.jobId] === agentId);
  const orphanApprovals = approvals.filter((a) => !agentByJob[a.jobId] || !agents.some((ag) => ag.id === agentByJob[a.jobId]));

  const approvalRow = (a: JobApproval) => (
    <div key={a.id} style={{ ...box, borderColor: 'var(--amber)', marginTop: 6 }}>
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
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
      {orphanApprovals.length > 0 && (
        <div>
          <div style={sectionHead}>APROVAÇÕES · {orphanApprovals.length}</div>
          {orphanApprovals.map(approvalRow)}
        </div>
      )}

      <div>
        <div style={sectionHead}>ESPECIALISTAS · {agents.length}</div>
        {agents.length === 0 ? (
          <div className="empty">NO TEAM AGENTS</div>
        ) : (
          agents.map((agent) => {
            const pending = approvalsFor(agent.id);
            return (
              <div key={agent.id} style={box}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {agent.name}
                  </span>
                  <span style={{ fontSize: 9, textTransform: 'uppercase', color: agent.delegationRole === 'orchestrator' ? 'var(--magenta, #ff5cf0)' : 'var(--cyan, #35e5ff)', border: '1px solid currentColor', borderRadius: 4, padding: '0 5px' }}>
                    {humanizeRole(agent.delegationRole)}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--dim)', display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginBottom: 6 }}>
                  <span>{agent.provider}:{agent.model}</span>
                  <span>tok {formatAgentBudget(agent.tokensToday, agent.tokenBudgetDaily)}</span>
                </div>
                {agent.topics.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                    {agent.topics.map((t) => (
                      <span key={t} style={{ fontSize: 10, color: 'var(--text)', opacity: 0.85, border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, padding: '0 5px' }}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {pending.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Aprovações pendentes · {pending.length}
                    </div>
                    {pending.map(approvalRow)}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  {confirmDelete === agent.id ? (
                    <>
                      <button type="button" className="no-drag" style={{ ...btn, borderColor: 'var(--red)', color: 'var(--red)' }} onClick={() => del(agent.id)}>
                        Confirmar apagar
                      </button>
                      <button type="button" className="no-drag" style={btn} onClick={() => setConfirmDelete(null)}>Cancelar</button>
                    </>
                  ) : (
                    <button type="button" className="no-drag" style={{ ...btn, borderColor: 'var(--red)', color: 'var(--red)' }} onClick={() => setConfirmDelete(agent.id)}>
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
