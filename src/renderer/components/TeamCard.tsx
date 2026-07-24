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
import { humanizeRole, formatAgentBudget, canMessageUserResolved } from '../../main/core/team-format-pure.ts';
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
      if (e.kind === 'job.approval' || e.kind === 'job.data' || e.kind === 'team.changed') refetch();
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

  // id → name, so "reporta a: <manager>" shows the manager's display name.
  const nameById: Record<string, string> = {};
  for (const a of agents) nameById[a.id] = a.name;

  // Map an approval → the agent that raised it, via its scheduled STUDY job.
  const agentByJob: Record<string, string> = {};
  for (const j of jobs) if (j.study) agentByJob[j.id] = j.study.agentId;
  const approvalsFor = (agentId: string): JobApproval[] => approvals.filter((a) => agentByJob[a.jobId] === agentId);
  const orphanApprovals = approvals.filter((a) => !agentByJob[a.jobId] || !agents.some((ag) => ag.id === agentByJob[a.jobId]));

  const approvalRow = (a: JobApproval) => (
    <div key={a.id} className="team-ap">
      <div className="team-ap-desc">{describeApproval(a.toolName, a.args)}</div>
      <div className="team-ap-time">{relativeTime(a.ts, now)}</div>
      <div className="team-btns">
        <button type="button" className="sched-ap-btn ok no-drag" onClick={() => resolve(a.id, true)}>
          ✓ APROVAR
        </button>
        <button type="button" className="sched-ap-btn no no-drag" onClick={() => resolve(a.id, false)}>
          ✕ RECUSAR
        </button>
      </div>
    </div>
  );

  return (
    <div className="team">
      {orphanApprovals.length > 0 && (
        <div>
          <div className="team-section-head amber">⚠ APROVAÇÕES · {orphanApprovals.length}</div>
          {orphanApprovals.map(approvalRow)}
        </div>
      )}

      <div>
        <div className="team-section-head">ESPECIALISTAS · {agents.length}</div>
        {agents.length === 0 ? (
          <div className="empty">NO TEAM AGENTS</div>
        ) : (
          agents.map((agent) => {
            const pending = approvalsFor(agent.id);
            const orch = agent.delegationRole === 'orchestrator';
            return (
              <div key={agent.id} className={`team-agent${orch ? ' orchestrator' : ''}`}>
                <div className="team-agent-head">
                  <span className="team-agent-name">{agent.name}</span>
                  <span className={`team-role${orch ? ' orchestrator' : ' leaf'}`}>
                    {humanizeRole(agent.delegationRole)}
                  </span>
                  {canMessageUserResolved(agent) && (
                    <span className="team-role msg" title="pode falar com o utilizador">✉</span>
                  )}
                </div>
                <div className="team-meta">
                  <span>{agent.provider}:{agent.model}</span>
                  <span>tok <span className="v">{formatAgentBudget(agent.tokensToday, agent.tokenBudgetDaily)}</span></span>
                  <span>reporta a: <span className="v">{agent.parentId ? (nameById[agent.parentId] ?? agent.parentId) : '—'}</span></span>
                </div>
                {agent.topics.length > 0 && (
                  <div className="team-topics">
                    {agent.topics.map((t) => (
                      <span key={t} className="team-topic">{t}</span>
                    ))}
                  </div>
                )}
                {pending.length > 0 && (
                  <div className="team-pending">
                    <div className="team-pending-head">Aprovações pendentes · {pending.length}</div>
                    {pending.map(approvalRow)}
                  </div>
                )}
                <div className="team-btns">
                  {confirmDelete === agent.id ? (
                    <>
                      <button type="button" className="sched-btn danger no-drag" onClick={() => del(agent.id)}>
                        Confirmar apagar
                      </button>
                      <button type="button" className="sched-btn no-drag" onClick={() => setConfirmDelete(null)}>Cancelar</button>
                    </>
                  ) : (
                    <button type="button" className="sched-btn danger no-drag" onClick={() => setConfirmDelete(agent.id)}>
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
