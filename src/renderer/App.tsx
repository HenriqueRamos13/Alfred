/**
 * Alfred control centre. Owns UI state, subscribes to the main→renderer event
 * stream, and lays out the neon panels.
 *
 * App-driven components (props below are the contract the component team
 * implements against):
 *   CommandBar     { status, killed, budget, onSubmit(text), onKill() }
 *   ChatLog        { messages: ChatMessage[], streaming?: string }
 *   ProjectList    { projects: ProjectRecord[] }              (also AI-renderable)
 *   ApprovalPrompt { request: ApprovalRequest, onResolve(id, decision) }
 */
import { useEffect, useRef, useState } from 'react';
import { alfred } from './lib/ipc.ts';
import { Surface } from './surface.tsx';
import { CommandBar } from './components/CommandBar.tsx';
import { ChatLog } from './components/ChatLog.tsx';
import { ProjectList } from './components/ProjectList.tsx';
import { ApprovalPrompt } from './components/ApprovalPrompt.tsx';
import type {
  AgentStatus,
  ApprovalDecision,
  ApprovalRequest,
  BudgetState,
  ChatMessage,
  CostSnapshot,
  ProjectRecord,
  StreamEvent,
  UiNode,
} from '../main/core/types.ts';

type Tone = 'cyan' | 'lime' | 'amber' | 'magenta' | 'red' | 'dim';
interface LogRow {
  id: number;
  time: string;
  tag: string;
  tone: Tone;
  msg: string;
}

const MAX_LOG = 80;
let logSeq = 0;

function now(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function summarize(value: unknown): string {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** Estimated USD: sub-dollar amounts need more precision to be meaningful. */
function usd(n: number): string {
  return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState('');
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [tree, setTree] = useState<UiNode | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [cost, setCost] = useState<CostSnapshot | null>(null);
  const [killed, setKilled] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);

  const pushLog = (row: Omit<LogRow, 'id' | 'time'>) =>
    setLogs((prev) => {
      const next = [...prev, { ...row, id: logSeq++, time: now() }];
      return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
    });

  const refreshProjects = () => {
    alfred.listProjects().then(setProjects).catch(() => {});
  };

  useEffect(() => {
    refreshProjects();
    const off = alfred.onStream((e: StreamEvent) => {
      switch (e.kind) {
        case 'chat.delta':
          setStreaming((s) => s + e.text);
          break;
        case 'chat.message':
          setMessages((m) => [...m, e.message]);
          if (e.message.role === 'assistant') setStreaming('');
          break;
        case 'tool.start':
          pushLog({ tag: e.toolName, tone: 'cyan', msg: summarize(e.args) });
          break;
        case 'tool.end':
          pushLog({
            tag: e.toolName,
            tone: e.status === 'ok' ? 'lime' : e.status === 'denied' ? 'amber' : 'red',
            msg: e.error ?? e.status,
          });
          break;
        case 'approval.request':
          setApproval(e.request);
          pushLog({ tag: 'HITL', tone: 'amber', msg: `${e.request.tier} ${e.request.toolName}` });
          break;
        case 'approval.resolved':
          setApproval((a) => (a && a.id === e.resolution.id ? null : a));
          pushLog({
            tag: 'HITL',
            tone: e.resolution.decision === 'approve' ? 'lime' : 'red',
            msg: e.resolution.timedOut ? `${e.resolution.decision} (timeout)` : e.resolution.decision,
          });
          break;
        case 'ui.render':
          setTree(e.payload.tree);
          break;
        case 'agent.status':
          setStatus(e.status);
          if (e.status === 'done' || e.status === 'idle') refreshProjects();
          break;
        case 'budget':
          setBudget(e.state);
          break;
        case 'cost':
          setCost(e.snapshot);
          break;
        case 'error':
          pushLog({ tag: 'ERROR', tone: 'red', msg: e.message });
          break;
      }
    });
    return off;
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || killed) return;
    const msg: ChatMessage = {
      id: `u-${Date.now()}`,
      sessionId: 'local',
      role: 'user',
      content: trimmed,
      ts: Date.now(),
    };
    setMessages((m) => [...m, msg]);
    alfred.send(trimmed).catch((err) => pushLog({ tag: 'ERROR', tone: 'red', msg: String(err) }));
  };

  const onKill = () => {
    alfred.stop();
    setKilled(true);
    setApproval(null);
    setStatus('idle');
    pushLog({ tag: 'KERNEL', tone: 'red', msg: '!! kill switch engaged' });
  };

  const onResolve = (id: string, decision: ApprovalDecision) => {
    alfred.resolveApproval(id, decision);
    setApproval((a) => (a && a.id === id ? null : a));
  };

  return (
    <div className="app">
      <div className="scanline">
        <div />
      </div>

      <div className="topbar">
        <span className="topbar-title">◆ ALFRED</span>
        <span className="topbar-spacer" />
        <button type="button" className="topbar-btn no-drag" onClick={() => alfred.hideWindow()} title="Hide (⌘⇧A to toggle)">
          HIDE
        </button>
        <button type="button" className="topbar-btn danger no-drag" onClick={() => alfred.quitWindow()} title="Quit Alfred">
          QUIT
        </button>
      </div>

      <CommandBar status={status} killed={killed} budget={budget} onSubmit={onSubmit} onKill={onKill} />

      <div className="grid">
        <div className="col">
          <section className="panel grow">
            <div className="panel-head">
              <div className="panel-title">
                <span className="dot" />
                CONVERSATION
              </div>
            </div>
            <ChatLog messages={messages} streaming={streaming} />
          </section>
        </div>

        <div className="col">
          <section className="panel grow">
            <div className="panel-head">
              <div className="panel-title">
                <span className="dot live" style={{ background: 'var(--violet)', boxShadow: '0 0 8px var(--violet)' }} />
                GENERATIVE SURFACE
              </div>
              <span className="panel-meta">{status.toUpperCase()}</span>
            </div>
            <div className="surface-body">
              <Surface tree={tree} />
            </div>
          </section>
        </div>

        <div className="col">
          <section className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <span className="dot live" style={{ background: 'var(--lime)', boxShadow: '0 0 8px var(--lime)' }} />
                COST · ESTIMATED US$
              </div>
              <span className="panel-meta">{cost ? cost.activeBrain.toUpperCase() : '—'}</span>
            </div>
            {cost ? (
              <div className="cost">
                <div className="cost-active">
                  <span className="cost-active-label">ACTIVE MODEL</span>
                  <span className="cost-active-model">{cost.activeModel}</span>
                </div>
                <div className="cost-tiles">
                  <div className={`cost-tile${cost.overUsdBudget ? ' warn' : ''}`}>
                    <span className="cost-tile-label">TODAY ~US$</span>
                    <span className="cost-tile-value">{usd(cost.today.usd)}</span>
                    <span className="cost-tile-sub">
                      {cost.today.tokens.toLocaleString()} / {cost.dailyTokenCap.toLocaleString()} tok
                    </span>
                  </div>
                  <div className="cost-tile">
                    <span className="cost-tile-label">SESSION ~US$</span>
                    <span className="cost-tile-value">{usd(cost.session.usd)}</span>
                    <span className="cost-tile-sub">{cost.session.tokens.toLocaleString()} tok</span>
                  </div>
                </div>
                {cost.overUsdBudget && (
                  <div className="cost-warn">
                    ⚠ over daily US$ budget ({usd(cost.dailyUsdBudget ?? 0)}) — soft warning, not blocking
                  </div>
                )}
                <table className="cost-table">
                  <thead>
                    <tr>
                      <th>MODEL</th>
                      <th>TOK</th>
                      <th>~US$</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cost.byModel.map((m) => (
                      <tr key={m.model}>
                        <td>
                          {m.model}
                          {m.unknownPrice && ' *'}
                        </td>
                        <td>{m.tokens.toLocaleString()}</td>
                        <td>{usd(m.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {cost.byModel.some((m) => m.unknownPrice) && (
                  <div className="cost-note">* no price on file — US$ estimated as 0</div>
                )}
              </div>
            ) : (
              <div className="empty">NO SPEND YET</div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <span className="dot" />
                PROJECTS
              </div>
              <span className="panel-meta">{projects.length}</span>
            </div>
            <ProjectList projects={projects} />
          </section>

          <section className="panel grow">
            <div className="panel-head">
              <div className="panel-title">
                <span className="dot live" style={{ background: 'var(--lime)', boxShadow: '0 0 8px var(--lime)' }} />
                OBSERVABILITY · TOOL-CALL STREAM
              </div>
              <span className="panel-meta">live tail —f</span>
            </div>
            <div className="log" ref={logRef}>
              {logs.map((l) => (
                <div className="log-row" key={l.id}>
                  <span className="log-time">{l.time}</span>
                  <span className={`log-tag tone-${l.tone}`}>{l.tag}</span>
                  <span className="log-msg">{l.msg}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {approval && (
        <div className="overlay">
          <ApprovalPrompt request={approval} onResolve={onResolve} />
        </div>
      )}
    </div>
  );
}
