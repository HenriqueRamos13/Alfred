/**
 * AtWorkCard — the Phase P4 "EM ATIVIDADE" aggregate card.
 *
 * A read-only VIEW over the SAME live activity the TEAM card already shows: who
 * is busy RIGHT NOW vs idle. It owns no engine — it consumes the roster
 * projection (listTeamAgents, which carries the resolved `activity`) and stays
 * live off the exact stream events the TeamCard listens to (agent.activity /
 * team.changed / agent.status). No new tools, no new events.
 *
 * Reuse: `agentsAtWork` / `atWorkSummary` (atwork-pure) slice + count the
 * roster; `activityLabelPt` (team-format-pure) and the `.team-dot` styles are
 * the concurrent engine's own — same dot, same PT captions as the TEAM card.
 * Pure renderer; zero node:*.
 */
import { useEffect, useState } from 'react';
import { alfred } from '../lib/ipc.ts';
import { activityLabelPt, humanizeRole } from '../../main/core/team-format-pure.ts';
import { agentsAtWork, atWorkSummary } from '../../main/core/atwork-pure.ts';
import type { TeamAgentInfo, StreamEvent } from '../../main/core/types.ts';

export function AtWorkCard() {
  const [agents, setAgents] = useState<TeamAgentInfo[]>([]);

  useEffect(() => {
    const refetch = (): void => {
      alfred.listTeamAgents().then(setAgents).catch(() => {});
    };
    refetch();
    const off = alfred.onStream((e: StreamEvent) => {
      if (e.kind === 'team.changed' || e.kind === 'agent.activity') refetch();
      else if (e.kind === 'agent.status' && (e.status === 'done' || e.status === 'idle')) refetch();
    });
    return off;
  }, []);

  const busy = agentsAtWork(agents);
  const s = atWorkSummary(agents);

  return (
    <div className="atwork">
      <div className="atwork-summary">
        {s.working > 0 && <span><b>{s.working}</b> a trabalhar</span>}
        {s.studying > 0 && <span><b>{s.studying}</b> a estudar</span>}
        {s.waiting > 0 && <span className="amber"><b>{s.waiting}</b> aguarda</span>}
        <span className="dim"><b>{s.idle}</b> idle</span>
      </div>

      {busy.length === 0 ? (
        <div className="empty">Ninguém a trabalhar agora</div>
      ) : (
        busy.map((agent) => {
          const activity = agent.activity;
          return (
            <div key={agent.id} className="atwork-agent">
              <span className={`team-dot ${activity.state}`} title={activityLabelPt(activity.state)} />
              <div className="atwork-agent-body">
                <div className="atwork-agent-top">
                  <span className="atwork-name">{agent.name}</span>
                  <span className="atwork-role">{humanizeRole(agent.delegationRole)}</span>
                </div>
                <div className="atwork-what">
                  {activityLabelPt(activity.state)}{activity.label ? ` · ${activity.label}` : ''}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
