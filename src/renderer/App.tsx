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
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { alfred } from './lib/ipc.ts';
import { Surface } from './surface.tsx';
import { CommandBar } from './components/CommandBar.tsx';
import { ChatLog } from './components/ChatLog.tsx';
import { ProjectList } from './components/ProjectList.tsx';
import { ApprovalPrompt } from './components/ApprovalPrompt.tsx';
import { DraggableCard } from './components/DraggableCard.tsx';
import { clampBox, tileLayout, type Bounds } from '../main/core/layout.ts';
import type {
  AgentStatus,
  ApprovalDecision,
  ApprovalRequest,
  AccountRecord,
  BudgetState,
  CardLayout,
  CardPatch,
  ChatMessage,
  CostSnapshot,
  ProjectRecord,
  StreamEvent,
  UiNode,
} from '../main/core/types.ts';
import type { BrainInfo } from '../main/core/providers.ts';

type Tone = 'cyan' | 'lime' | 'amber' | 'magenta' | 'red' | 'dim';
interface LogRow {
  id: number;
  time: string;
  tag: string;
  tone: Tone;
  msg: string;
}

const MAX_LOG = 80;
const MAX_ALERTS = 12;
let logSeq = 0;
let alertSeq = 0;

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
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [connectingGmail, setConnectingGmail] = useState(false);
  const [cost, setCost] = useState<CostSnapshot | null>(null);
  const [killed, setKilled] = useState(false);
  const [alerts, setAlerts] = useState<{ id: number; msg: string }[]>([]);
  const [brains, setBrains] = useState<BrainInfo[]>([]);
  const [activeBrain, setActiveBrain] = useState<string | null>(null);
  const [cards, setCards] = useState<CardLayout[]>([]);
  const [dangerous, setDangerous] = useState(false);
  const [tts, setTts] = useState(false);
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [dictation, setDictation] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });

  const [bounds, setBounds] = useState<Bounds | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<HTMLTextAreaElement>(null);
  const cardsRef = useRef<CardLayout[]>([]);
  cardsRef.current = cards;

  // Auto-hide top strip (macOS-menubar style). ALFRED_AUTOHIDE_TOP=0 disables it.
  const autoHide = alfred.autoHideTop ?? true;
  const [nearTop, setNearTop] = useState(false); // cursor at the very top edge
  const [hoverStrip, setHoverStrip] = useState(false); // pointer over the strip
  const [inputFocused, setInputFocused] = useState(false); // never hide while typing
  const [stripH, setStripH] = useState(96); // measured strip height → anchors alerts below it
  const stripOpen = !autoHide || nearTop || hoverStrip || inputFocused;

  // Reveal when the cursor touches the top edge; hide after a short delay so it doesn't flicker.
  useEffect(() => {
    if (!autoHide) return;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const onMove = (e: MouseEvent) => {
      if (e.clientY <= 6) {
        clearTimeout(hideTimer);
        setNearTop(true);
      } else {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => setNearTop(false), 400);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      clearTimeout(hideTimer);
    };
  }, [autoHide]);

  // ⌘/Ctrl+K reveals the strip and focuses the command input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setNearTop(true);
        commandInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep alerts anchored just below the strip's real height (grows if the toolbar wraps).
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = () => setStripH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Track the real canvas size: clamp cards on-screen and tell main so the AI's
  // ui_layout tool knows the live bounds.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const report = () => {
      const b = { w: el.clientWidth, h: el.clientHeight };
      setBounds(b);
      alfred.setViewport(b.w, b.h);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Recoloca todos os cards (incl. escondidos) numa grelha limpa ajustada à janela. */
  const arrangeAll = () => {
    if (!bounds) return;
    const list = cardsRef.current;
    const tiles = tileLayout(list.map((c) => c.id), bounds);
    list.forEach((c, i) => patchCard(c.id, { ...tiles[i], visible: true }));
  };

  const patchCard = (id: string, patch: CardPatch) => {
    // Optimistic: reflect immediately; the 'layout' event will confirm.
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    alfred.updateCard(id, patch).catch(() => {});
  };

  // Rescue cards whose persisted geometry sits outside the current visible
  // canvas (e.g. a layout saved when the overlay spanned every display): clamp
  // every card on-screen and persist the correction. clampBox is idempotent, so
  // once everything fits this re-runs to a no-op — no render loop.
  useEffect(() => {
    if (!bounds) return;
    for (const c of cardsRef.current) {
      const fit = clampBox(c, bounds);
      if (fit.x !== c.x || fit.y !== c.y || fit.w !== c.w || fit.h !== c.h) patchCard(c.id, fit);
    }
  }, [bounds, cards]);

  const focusCard = (id: string) => {
    const list = cardsRef.current;
    const maxZ = list.reduce((m, c) => Math.max(m, c.z), 0);
    const card = list.find((c) => c.id === id);
    if (!card || card.z === maxZ) return;
    patchCard(id, { z: maxZ + 1 });
  };

  const pushAlert = (msg: string) =>
    setAlerts((prev) => {
      const next = [...prev, { id: alertSeq++, msg }];
      return next.length > MAX_ALERTS ? next.slice(next.length - MAX_ALERTS) : next;
    });

  const refreshBrains = () => {
    alfred.listBrains().then(setBrains).catch(() => {});
    alfred.getActiveBrain().then(setActiveBrain).catch(() => {});
  };

  const selectBrain = (b: BrainInfo) => {
    if (!b.enabled || b.id === activeBrain) return;
    alfred.setActiveBrain(b.id).then(setActiveBrain).catch(() => {});
  };

  const pushLog = (row: Omit<LogRow, 'id' | 'time'>) =>
    setLogs((prev) => {
      const next = [...prev, { ...row, id: logSeq++, time: now() }];
      return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
    });

  const refreshProjects = () => {
    alfred.listProjects().then(setProjects).catch(() => {});
  };

  const refreshAccounts = () => {
    alfred.listAccounts().then(setAccounts).catch(() => {});
  };

  const connectGmail = () => {
    if (connectingGmail) return;
    setConnectingGmail(true);
    pushLog({ tag: 'GMAIL', tone: 'cyan', msg: 'connect — approve in the HITL prompt, then Google consent' });
    alfred
      .connectGmail()
      .then((acc) => {
        if (acc) pushLog({ tag: 'GMAIL', tone: 'lime', msg: `connected ${acc.email}` });
        refreshAccounts();
      })
      .catch((err) => {
        const m = err instanceof Error ? err.message : String(err);
        pushLog({ tag: 'GMAIL', tone: 'red', msg: m });
        pushAlert(m);
      })
      .finally(() => setConnectingGmail(false));
  };

  useEffect(() => {
    refreshProjects();
    refreshBrains();
    refreshAccounts();
    // Reload the persisted conversation so history survives restarts.
    alfred.getHistory().then(setMessages).catch(() => {});
    alfred.getLayout().then(setCards).catch(() => {});
    // Show today's persisted spend immediately (don't wait for the first turn).
    alfred.getCost().then((c) => c && setCost(c)).catch(() => {});
    // Reflect the persisted DANGEROUS-mode state in the toggle + visuals.
    alfred.getDangerousMode().then(setDangerous).catch(() => {});
    // Reflect the persisted voice-output toggle.
    alfred.getTts().then(setTts).catch(() => {});
    const off = alfred.onStream((e: StreamEvent) => {
      switch (e.kind) {
        case 'chat.delta':
          setStreaming((s) => s + e.text);
          break;
        case 'chat.message':
          setMessages((m) => [...m, e.message]);
          if (e.message.role === 'assistant') setStreaming('');
          break;
        case 'stt.partial':
          setPartial(e.text);
          break;
        case 'stt.final':
          setListening(false);
          setPartial('');
          if (e.text.trim()) setDictation((d) => ({ text: e.text, seq: d.seq + 1 }));
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
            msg: e.resolution.timedOut
              ? `${e.resolution.decision} (timeout)`
              : e.resolution.note
                ? `${e.resolution.decision} — ${e.resolution.note}`
                : e.resolution.decision,
          });
          break;
        case 'ui.render':
          setTree(e.payload.tree);
          break;
        case 'layout':
          setCards(e.cards);
          break;
        case 'agent.status':
          setStatus(e.status);
          if (e.status === 'done' || e.status === 'idle') {
            refreshProjects();
            refreshBrains();
          }
          break;
        case 'budget':
          setBudget(e.state);
          break;
        case 'cost':
          setCost(e.snapshot);
          break;
        case 'error':
          pushLog({ tag: 'ERROR', tone: 'red', msg: e.message });
          pushAlert(e.message);
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
    alfred.send(trimmed).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      pushLog({ tag: 'ERROR', tone: 'red', msg });
      pushAlert(msg);
    });
  };

  const onKill = () => {
    alfred.stop();
    setKilled(true);
    setApproval(null);
    setStatus('idle');
    pushLog({ tag: 'KERNEL', tone: 'red', msg: '!! kill switch engaged' });
  };

  const onResolve = (id: string, decision: ApprovalDecision, remember?: boolean) => {
    alfred.resolveApproval(id, decision, remember);
    if (remember && decision === 'approve') {
      pushLog({ tag: 'HITL', tone: 'amber', msg: 'rule saved — won’t ask again for this action' });
    }
    setApproval((a) => (a && a.id === id ? null : a));
  };

  const toggleDangerous = () => {
    const next = !dangerous;
    setDangerous(next); // optimistic
    alfred
      .setDangerousMode(next)
      .then(setDangerous)
      .catch(() => setDangerous(!next));
    pushLog({
      tag: 'KERNEL',
      tone: next ? 'red' : 'lime',
      msg: next ? '!! DANGEROUS MODE ON — approvals bypassed' : 'dangerous mode off — approvals restored',
    });
  };

  const resetApprovals = () => {
    alfred.resetApprovals();
    pushLog({ tag: 'HITL', tone: 'lime', msg: 'auto-approve rules cleared' });
  };

  const toggleTts = () => {
    const next = !tts;
    setTts(next); // optimistic
    alfred.setTts(next).then(setTts).catch(() => setTts(!next));
    pushLog({ tag: 'VOICE', tone: next ? 'lime' : 'dim', msg: next ? 'voice output on' : 'voice output off' });
  };

  const toggleMic = () => {
    if (killed) return;
    if (listening) {
      alfred.stopListening();
      setListening(false); // stt.final will also confirm
      return;
    }
    setPartial('');
    setListening(true);
    alfred.startListening();
    pushLog({ tag: 'VOICE', tone: 'cyan', msg: 'listening…' });
  };

  /** Right-of-header meta + scrollable body for each card, keyed by id. */
  const cardParts = (id: string): { meta?: ReactNode; body: ReactNode } => {
    switch (id) {
      case 'conversation':
        return { body: <ChatLog messages={messages} streaming={streaming} /> };
      case 'surface':
        return {
          meta: <span className="panel-meta">{status.toUpperCase()}</span>,
          body: (
            <div className="surface-body">
              <Surface tree={tree} />
            </div>
          ),
        };
      case 'brains':
        return {
          meta: (
            <span className="panel-meta">
              {brains.filter((b) => b.enabled).length}/{brains.length} CONNECTED
            </span>
          ),
          body: brains.length ? (
            <div className="brains">
              {brains.map((b) => {
                const active = activeBrain === b.id;
                return (
                  <button
                    type="button"
                    className={`brain no-drag${b.enabled ? ' on' : ''}${active ? ' active' : ''}`}
                    key={b.id}
                    disabled={!b.enabled}
                    title={b.enabled ? (active ? 'Active brain' : 'Set as main brain') : 'Not connected'}
                    onClick={() => selectBrain(b)}
                  >
                    <span className={`brain-dot${b.enabled ? ' on' : ''}`} />
                    <span className="brain-label">{b.label}</span>
                    <span className="brain-model">{b.model}</span>
                    <span className="brain-state">
                      {active && b.enabled ? 'ACTIVE' : b.enabled ? 'CONNECTED' : 'offline'}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="empty">NO BRAINS</div>
          ),
        };
      case 'cost':
        return {
          meta: <span className="panel-meta">{cost ? cost.activeBrain.toUpperCase() : '—'}</span>,
          body: cost?.external ? (
            <div className="cost">
              <div className="cost-active">
                <span className="cost-active-label">ACTIVE MODEL</span>
                <span className="cost-active-model">{cost.activeModel}</span>
              </div>
              <div className="cost-note" style={{ marginTop: 8 }}>
                externo / gerido pelo Claude Code — sem estimativa US$ (subscrição / faturação à parte)
              </div>
            </div>
          ) : cost ? (
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
          ),
        };
      case 'projects':
        return {
          meta: <span className="panel-meta">{projects.length}</span>,
          body: <ProjectList projects={projects} />,
        };
      case 'accounts':
        return {
          meta: <span className="panel-meta">{accounts.length} CONNECTED</span>,
          body: (
            <div className="accounts">
              {accounts.length ? (
                accounts.map((a) => (
                  <div className="account" key={a.id}>
                    <span className="account-dot" />
                    <span className="account-email">{a.email}</span>
                    <span className="account-provider">{a.provider}</span>
                  </div>
                ))
              ) : (
                <div className="empty">NO ACCOUNTS</div>
              )}
              <button
                type="button"
                className="account-connect no-drag"
                disabled={connectingGmail}
                onClick={connectGmail}
              >
                {connectingGmail ? 'CONNECTING…' : '+ Conectar Gmail'}
              </button>
              {!alfred.gmailConfigured && (
                <div className="account-hint">
                  Falta o OAuth client do Google. Cria um em Google Cloud Console e define
                  GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET no .env (ver README).
                </div>
              )}
            </div>
          ),
        };
      case 'activity':
        return {
          meta: <span className="panel-meta">live tail —f · memory on</span>,
          body: (
            <div className="log" ref={logRef}>
              {logs.map((l) => (
                <div className="log-row" key={l.id}>
                  <span className="log-time">{l.time}</span>
                  <span className={`log-tag tone-${l.tone}`}>{l.tag}</span>
                  <span className="log-msg">{l.msg}</span>
                </div>
              ))}
            </div>
          ),
        };
      default:
        return { body: null };
    }
  };

  const hidden = cards.filter((c) => !c.visible);

  return (
    <div className={`app${dangerous ? ' dangerous' : ''}`}>
      <div className="scanline">
        <div />
      </div>

      {dangerous && (
        <div className="danger-banner" role="alert">
          ⚠ DANGEROUS MODE — approvals off · every action auto-runs
        </div>
      )}

      {/* Always-visible hint that the strip lives at the top edge; fades out once revealed. */}
      <div className={`top-hint${stripOpen ? ' hidden' : ''}`} aria-hidden />

      <div
        className={`topstrip${stripOpen ? ' open' : ''}`}
        ref={stripRef}
        onMouseEnter={() => setHoverStrip(true)}
        onMouseLeave={() => setHoverStrip(false)}
      >
        <div className="topbar">
          <span className="topbar-title">◆ ALFRED</span>
          {hidden.map((c) => (
            <button
              key={c.id}
              type="button"
              className="topbar-btn no-drag"
              title={`Show ${c.title}`}
              onClick={() => patchCard(c.id, { visible: true })}
            >
              + {c.title}
            </button>
          ))}
          <span className="topbar-spacer" />
          <button
            type="button"
            className={`topbar-btn no-drag${tts ? ' on' : ''}`}
            onClick={toggleTts}
            title={tts ? 'Voice output on — click to mute Alfred' : 'Voice output off — click to let Alfred speak'}
          >
            {tts ? '🔊 VOICE ON' : '🔈 VOICE OFF'}
          </button>
          <button
            type="button"
            className="topbar-btn no-drag"
            onClick={resetApprovals}
            title="Clear all saved auto-approve rules (start asking again)"
          >
            ⟲ RESET APPROVALS
          </button>
          <button
            type="button"
            className={`topbar-btn danger no-drag${dangerous ? ' on' : ''}`}
            onClick={toggleDangerous}
            title="Bypass ALL approvals (T2/T3 auto-run). Persisted. Use with care."
          >
            {dangerous ? '● DANGEROUS ON' : '○ DANGEROUS'}
          </button>
          <button
            type="button"
            className="topbar-btn no-drag"
            onClick={arrangeAll}
            title="Organise all cards into a clean grid"
          >
            ⊞ ORGANIZAR
          </button>
          <button type="button" className="topbar-btn no-drag" onClick={() => alfred.hideWindow()} title="Hide (⌘⇧A to toggle)">
            HIDE
          </button>
          <button type="button" className="topbar-btn danger no-drag" onClick={() => alfred.quitWindow()} title="Quit Alfred">
            QUIT
          </button>
        </div>

        <CommandBar
          status={status}
          killed={killed}
          budget={budget}
          onSubmit={onSubmit}
          onKill={onKill}
          inputRef={commandInputRef}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          listening={listening}
          partial={partial}
          onMic={toggleMic}
          dictation={dictation}
        />
      </div>

      {alerts.length > 0 && (
        <div className="alerts" role="alert" style={{ top: stripH }}>
          {alerts.map((a) => (
            <div className="alert" key={a.id}>
              <span className="alert-tag">ERROR</span>
              <span className="alert-msg">{a.msg}</span>
              <button
                type="button"
                className="alert-btn no-drag"
                title="Copy"
                onClick={() => navigator.clipboard?.writeText(a.msg).catch(() => {})}
              >
                COPY
              </button>
              <button
                type="button"
                className="alert-btn no-drag"
                title="Dismiss"
                onClick={() => setAlerts((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="canvas" ref={canvasRef}>
        {cards
          .filter((c) => c.visible)
          .map((c) => {
            const { meta, body } = cardParts(c.id);
            // Defensive: never render a card off-screen, whatever the store/AI wrote.
            const view = bounds ? { ...c, ...clampBox(c, bounds) } : c;
            return (
              <DraggableCard
                key={c.id}
                card={view}
                meta={meta}
                onChange={(patch) => patchCard(c.id, patch)}
                onFocus={() => focusCard(c.id)}
                onHide={() => patchCard(c.id, { visible: false })}
              >
                {body}
              </DraggableCard>
            );
          })}
      </div>

      {approval && (
        <div className="overlay">
          <ApprovalPrompt request={approval} onResolve={onResolve} />
        </div>
      )}
    </div>
  );
}
