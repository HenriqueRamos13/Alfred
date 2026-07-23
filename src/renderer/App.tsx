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
import { ReferenceChat } from './components/ReferenceChat.tsx';
import { GraphCard } from './components/GraphCard.tsx';
import { ScheduledTasksCard } from './components/ScheduledTasksCard.tsx';
import { WidgetCard } from './components/WidgetCard.tsx';
import { HtmlWidgetCard } from './components/HtmlWidgetCard.tsx';
import type { ReferenceTarget } from '../main/core/reference.ts';
import { clampBox, tileLayout, cardOnDisplay, nextDisplayId, type Bounds } from '../main/core/layout.ts';
import { initialDictation, dictationReduce } from '../main/core/dictation.ts';
import { confirmMatches } from '../main/core/reset-pure.ts';
import type { FactoryResetInfo } from '../main/core/orchestrator.ts';
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
  DisplayInfo,
  Job,
  ProjectRecord,
  StreamEvent,
  UiNode,
  WakeStatus,
} from '../main/core/types.ts';
import type { BrainInfo } from '../main/core/providers.ts';
import {
  AGENT_IDS,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  DEFAULT_MODEL,
  listModels,
  findModel,
  type AgentId,
  type AgentConfig,
  type AgentConfigMap,
  type CatalogModel,
  type ProviderId,
} from '../main/core/modelCatalog.ts';

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
  const [agentCfg, setAgentCfg] = useState<AgentConfigMap | null>(null);
  const [catalog, setCatalog] = useState<Record<ProviderId, CatalogModel[]> | null>(null);
  const [cards, setCards] = useState<CardLayout[]>([]);
  // Scheduled jobs — drives the "Scheduled Tasks" card meta + the per-job data
  // widgets. Widget cards are first-class layout rows (`widget:<jobId>`) in the
  // layout store, so their geometry/visibility persist and ui_layout can move them;
  // `jobs` here only supplies each widget's live content + title.
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dangerous, setDangerous] = useState(false);
  const [grill, setGrill] = useState(true); // GRILL-ME defaults ON
  // Factory-reset modal: null = closed; the info object = open, listing what will be erased.
  const [factoryInfo, setFactoryInfo] = useState<FactoryResetInfo | null>(null);
  const [factoryConfirm, setFactoryConfirm] = useState('');
  const [factoryBusy, setFactoryBusy] = useState(false);
  const [tts, setTts] = useState(false);
  const [wake, setWake] = useState(false);
  // Live wake-listener state so the WAKE button shows WHY it is (not) hearing you
  // (listening / muted while speaking / failed+reason / stopped / disabled).
  const [wakeStatus, setWakeStatus] = useState<{ status: WakeStatus; reason?: string }>({ status: 'stopped' });
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false); // Alfred is talking → mic muted (half-duplex)
  // Voice→input state machine: partials preview, a final commits ONCE per
  // activation, then it stops touching the input (see dictation.ts). partial =
  // transient preview; commit = the settled text the CommandBar appends off seq.
  const [dict, setDict] = useState(initialDictation);
  const partial = dict.preview;
  const dictation = dict.commit;
  // Bumped by a bare "Alfred, enviar" voice command → CommandBar submits its input.
  const [submitSeq, setSubmitSeq] = useState(0);

  // Reference agent — an ISOLATED side-thread over one note/node. Ephemeral: the
  // thread lives only in these states and is cleared on close; history is passed
  // back to main on each ask. refThreadRef scopes the reference.* stream (the
  // onStream closure is set once on mount, so it reads the live id via the ref).
  const [refTarget, setRefTarget] = useState<ReferenceTarget | null>(null);
  const [refTitle, setRefTitle] = useState('');
  const [refMessages, setRefMessages] = useState<ChatMessage[]>([]);
  const [refStreaming, setRefStreaming] = useState('');
  const [refBusy, setRefBusy] = useState(false);
  const refThreadRef = useRef('');

  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);

  // This window's display identity (baked in at creation via --display-id).
  // Empty displayId = windowed / single-window fallback → no per-display filter.
  const myDisplayId = alfred.displayId ?? '';
  const isPrimary = alfred.isPrimary ?? false;
  const overlay = alfred.overlay ?? true;

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
  const stripOpen = !autoHide || nearTop || hoverStrip || inputFocused || listening;

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

  // Click-through pivot (overlay windows only): the window starts click-through
  // so empty desktop stays clickable; while the pointer is over a card / the top
  // strip we flip it interactive, and back to click-through on leave. forward:true
  // (main side) keeps mousemove flowing so we can detect re-entry.
  useEffect(() => {
    if (!overlay) return;
    let interactive = true; // force the first setInteractive(false) to fire
    const INTERACTIVE = '.dcard, .topstrip, .top-hint, .alerts, .overlay';
    const set = (v: boolean) => {
      if (v === interactive) return;
      interactive = v;
      alfred.setInteractive(v);
    };
    const onMove = (e: MouseEvent) => set(!!(e.target as HTMLElement | null)?.closest(INTERACTIVE));
    window.addEventListener('mousemove', onMove);
    set(false); // begin click-through
    return () => window.removeEventListener('mousemove', onMove);
  }, [overlay]);

  // Physical displays for the "move card to next monitor" control. Rare to
  // change, so refresh on mount and whenever this window regains focus.
  useEffect(() => {
    const refresh = () => alfred.listDisplays?.().then(setDisplays).catch(() => {});
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  /** Send a card to the next physical display (cycles). displayId sentinels resolve to the primary. */
  const moveToNextDisplay = (card: CardLayout) => {
    const target = nextDisplayId(card.displayId, displays);
    // The target window's clamp-rescue effect repositions it into that display's bounds on arrival.
    if (target) patchCard(card.id, { displayId: target });
  };

  /** Recoloca todos os cards (incl. escondidos) numa grelha limpa ajustada à janela. */
  const arrangeAll = () => {
    if (!bounds) return;
    // Only this window's own cards: tiling every display's cards into one
    // window's bounds would drag other monitors' cards to bogus positions.
    const list = cardsRef.current.filter((c) => cardOnDisplay(c.displayId, myDisplayId, isPrimary));
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
      // Only clamp cards that belong to THIS window's display against its
      // bounds — otherwise two differently-sized monitors' windows keep
      // rewriting each other's cards (write storm + cross-display corruption).
      if (!cardOnDisplay(c.displayId, myDisplayId, isPrimary)) continue;
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
    // The main agent's provider is the source of truth behind the active brain,
    // so keep the settings card in step whenever brains refresh.
    alfred.getAgentConfig().then((c) => c && setAgentCfg(c)).catch(() => {});
  };

  const selectBrain = (b: BrainInfo) => {
    if (!b.enabled || b.id === activeBrain) return;
    // Reconcile: picking a brain here updates agent_config.main.provider; refresh
    // both the highlight and the settings card from the new source of truth.
    alfred.setActiveBrain(b.id).then(() => refreshBrains()).catch(() => {});
  };

  /** Persist one agent's config (settings card). Refreshes the BRAINS panel when 'main' changes. */
  const saveAgent = (id: AgentId, patch: AgentConfig) => {
    alfred
      .setAgentConfig(id, patch)
      .then((c) => {
        if (c) setAgentCfg(c);
        if (id === 'main') refreshBrains();
      })
      .catch(() => {});
    pushLog({ tag: 'SETTINGS', tone: 'lime', msg: `${id}: ${patch.provider} · ${patch.model}` });
  };

  const pushLog = (row: Omit<LogRow, 'id' | 'time'>) =>
    setLogs((prev) => {
      const next = [...prev, { ...row, id: logSeq++, time: now() }];
      return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
    });

  const refreshProjects = () => {
    alfred.listProjects().then(setProjects).catch(() => {});
  };

  const refreshJobs = () => {
    alfred.listJobs().then(setJobs).catch(() => {});
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
    refreshJobs();
    // Reload the persisted conversation so history survives restarts.
    alfred.getHistory().then(setMessages).catch(() => {});
    alfred.getLayout().then(setCards).catch(() => {});
    // Show today's persisted spend immediately (don't wait for the first turn).
    alfred.getCost().then((c) => c && setCost(c)).catch(() => {});
    // Per-agent config + the model catalog for the SETTINGS card.
    alfred.getAgentConfig().then((c) => c && setAgentCfg(c)).catch(() => {});
    alfred.getModelCatalog().then(setCatalog).catch(() => {});
    // Reflect the persisted DANGEROUS-mode state in the toggle + visuals.
    alfred.getDangerousMode().then(setDangerous).catch(() => {});
    // Reflect the persisted GRILL-ME toggle (default on).
    alfred.getGrillMe().then(setGrill).catch(() => {});
    // Reflect the persisted voice-output toggle.
    alfred.getTts().then(setTts).catch(() => {});
    // Reflect the persisted wake-word toggle (default on when the STT binary exists).
    alfred.getWakeword().then(setWake).catch(() => {});
    // Read the live wake state so the button isn't blind at boot (events only
    // arrive on the NEXT transition, which the renderer would otherwise miss).
    alfred.getWakeStatus().then((s) => s && setWakeStatus(s)).catch(() => {});
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
          setDict((d) => dictationReduce(d, { kind: 'partial', text: e.text }));
          break;
        case 'stt.final':
          setListening(false);
          // Commits once per activation; a late/duplicate or empty final writes
          // nothing (see dictation.ts) so the user keeps control of the input.
          setDict((d) => dictationReduce(d, { kind: 'final', text: e.text }));
          break;
        case 'wake.detected':
          // Show the same "listening" feedback as the mic button; the command's
          // stt.partial/stt.final that follow reuse the mic path (fill the input).
          setListening(true);
          setDict((d) => dictationReduce(d, { kind: 'activate' }));
          pushLog({
            tag: 'WAKE',
            tone: 'cyan',
            msg: e.bargeIn ? 'interrompi o Alfred — a captar comando' : 'ouvi “Alfred” — a captar comando',
          });
          break;
        case 'wake.status': {
          setWakeStatus({ status: e.status, reason: e.reason });
          // Log only real problems / recovery, not the routine speaking mute (which
          // the SPEAKING pill already shows) — keeps the activity feed readable.
          if (e.status === 'failed')
            pushLog({ tag: 'WAKE', tone: 'red', msg: `falhou: ${e.reason ?? 'helper parou'}` });
          else if (e.status === 'disabled')
            pushLog({ tag: 'WAKE', tone: 'dim', msg: e.reason ?? 'indisponível' });
          break;
        }
        case 'speaking':
          // While Alfred speaks the wake mic is silenced (half-duplex); reflect it.
          setSpeaking(e.speaking);
          break;
        case 'voice.command': {
          // An action command (hide/show already applied in main). Leave the
          // "listening" state, clear the preview and disarm — the action isn't
          // dictation, so nothing is written to the input.
          setListening(false);
          setDict((d) => dictationReduce(d, { kind: 'final', text: '' }));
          const label = e.action === 'hide' ? 'esconder' : e.action === 'show' ? 'mostrar' : 'enviar';
          pushLog({ tag: 'WAKE', tone: 'lime', msg: `comando de voz: ${label}${e.text ? ` — “${e.text}”` : ''}` });
          // Bare "enviar" → submit whatever the input already holds.
          if (e.action === 'send' && !e.text) setSubmitSeq((n) => n + 1);
          // "enviar <texto>" → main already ran the turn (send() persists but
          // doesn't re-emit the user turn); show the bubble optimistically, like
          // onSubmit does, so voice-sent commands appear in the chat immediately.
          else if (e.action === 'send' && e.text) {
            const spoken = e.text;
            setMessages((m) => [
              ...m,
              { id: `u-${Date.now()}`, sessionId: 'local', role: 'user', content: spoken, ts: Date.now() },
            ]);
          }
          break;
        }
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
            refreshJobs(); // a turn may have created/edited a job via the schedule tool
            // The agent may have flipped GRILL-ME via the system tool — reflect it.
            alfred.getGrillMe().then(setGrill).catch(() => {});
          }
          break;
        case 'job.data':
        case 'job.approval':
          // A run refreshed / an approval changed → resync the jobs (card meta +
          // widget layer). WidgetCard patches its own live value from job.data too.
          refreshJobs();
          break;
        case 'budget':
          setBudget(e.state);
          break;
        case 'cost':
          setCost(e.snapshot);
          break;
        case 'conversation.reset':
          setMessages([]);
          setStreaming('');
          pushLog({ tag: 'KERNEL', tone: 'amber', msg: 'conversation reset — chat cleared' });
          break;
        case 'factory.reset.done':
          // Everything Alfred knew is gone; reload into the blank factory state.
          window.location.reload();
          break;
        // Reference agent — scoped by threadId so a stale/other thread never bleeds
        // into the open panel. Never persisted; lives only in the panel's state.
        case 'reference.delta':
          if (e.threadId === refThreadRef.current) setRefStreaming((s) => s + e.text);
          break;
        case 'reference.message':
          if (e.threadId === refThreadRef.current) {
            setRefMessages((m) => [...m, e.message]);
            setRefStreaming('');
          }
          break;
        case 'reference.done':
          if (e.threadId === refThreadRef.current) setRefBusy(false);
          break;
        case 'reference.error':
          if (e.threadId === refThreadRef.current) {
            setRefBusy(false);
            setRefStreaming('');
            pushLog({ tag: 'REFERENCE', tone: 'red', msg: e.message });
          }
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

  const toggleGrill = () => {
    const next = !grill;
    setGrill(next); // optimistic
    alfred.setGrillMe(next).then(setGrill).catch(() => setGrill(!next));
    pushLog({
      tag: 'KERNEL',
      tone: next ? 'lime' : 'dim',
      msg: next ? 'grill-me on — interview to lock the plan first' : 'grill-me off — act directly',
    });
  };

  const resetApprovals = () => {
    alfred.resetApprovals();
    pushLog({ tag: 'HITL', tone: 'lime', msg: 'auto-approve rules cleared' });
  };

  const resetConversation = () => {
    if (!window.confirm('Limpar a conversa atual? (memória, factos e projetos mantêm-se)')) return;
    alfred.resetConversation();
    setMessages([]); // optimistic; the conversation.reset event confirms across windows
    setStreaming('');
  };

  const openFactoryReset = () => {
    setFactoryConfirm('');
    alfred
      .factoryResetInfo()
      .then((info) => info && setFactoryInfo(info))
      .catch(() => {});
  };

  const confirmFactoryReset = () => {
    if (!confirmMatches(factoryConfirm) || factoryBusy) return;
    setFactoryBusy(true);
    pushLog({ tag: 'KERNEL', tone: 'red', msg: '!! FACTORY RESET — erasing everything' });
    alfred
      .factoryReset()
      .catch((err) => {
        const m = err instanceof Error ? err.message : String(err);
        pushLog({ tag: 'ERROR', tone: 'red', msg: m });
        pushAlert(m);
      })
      .finally(() => {
        setFactoryBusy(false);
        setFactoryInfo(null);
        // main emits factory.reset.done → the window reloads; this is the fallback.
      });
  };

  const toggleTts = () => {
    const next = !tts;
    setTts(next); // optimistic
    alfred.setTts(next).then(setTts).catch(() => setTts(!next));
    pushLog({ tag: 'VOICE', tone: next ? 'lime' : 'dim', msg: next ? 'voice output on' : 'voice output off' });
  };

  const toggleWake = () => {
    const next = !wake;
    setWake(next); // optimistic
    alfred.setWakeword(next).then(setWake).catch(() => setWake(!next));
    pushLog({
      tag: 'WAKE',
      tone: next ? 'lime' : 'dim',
      msg: next ? 'wake word on — diz “Alfred …”' : 'wake word off',
    });
  };

  const toggleMic = () => {
    if (killed) return;
    if (listening) {
      alfred.stopListening();
      setListening(false); // the flushed stt.final still commits (armed until then)
      return;
    }
    setDict((d) => dictationReduce(d, { kind: 'activate' }));
    setListening(true);
    alfred.startListening();
    pushLog({ tag: 'VOICE', tone: 'cyan', msg: 'listening…' });
  };

  /**
   * Open the isolated Reference panel for a target (a note/node, or a project).
   * Phase 3's graph calls this with a node; here it is directly invokable/testable.
   * Starts a fresh ephemeral thread (new threadId, empty history).
   */
  const openReference = (target: ReferenceTarget, title?: string) => {
    const threadId = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    refThreadRef.current = threadId;
    setRefTarget(target);
    setRefTitle(title || target.note || target.project || 'Reference');
    setRefMessages([]);
    setRefStreaming('');
    setRefBusy(false);
  };

  const closeReference = () => {
    refThreadRef.current = ''; // ignore any late stream events for this thread
    setRefTarget(null);
    setRefMessages([]);
    setRefStreaming('');
    setRefBusy(false);
  };

  const askReference = (question: string) => {
    if (!refTarget) return;
    const threadId = refThreadRef.current;
    const userMsg: ChatMessage = {
      id: `rq-${Date.now()}`,
      sessionId: threadId,
      role: 'user',
      content: question,
      ts: Date.now(),
    };
    // History = the settled thread so far (exclude the in-flight message).
    const history = refMessages.map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    }));
    setRefMessages((m) => [...m, userMsg]);
    setRefStreaming('');
    setRefBusy(true);
    alfred.askReference({ threadId, target: refTarget, question, history }).catch((err) => {
      setRefBusy(false);
      pushLog({ tag: 'REFERENCE', tone: 'red', msg: err instanceof Error ? err.message : String(err) });
    });
  };

  /** Right-of-header meta + scrollable body for each card, keyed by id. */
  const cardParts = (id: string): { meta?: ReactNode; body: ReactNode } => {
    // Dynamic per-job data widget (`widget:<jobId>`): content comes from the live
    // job (Tier-2 = the self-contained HTML page, else the builtin data widget).
    if (id.startsWith('widget:')) {
      const job = jobs.find((j) => `widget:${j.id}` === id);
      if (!job) return { body: null };
      return { body: job.render?.tier === 2 ? <HtmlWidgetCard job={job} /> : <WidgetCard job={job} /> };
    }
    switch (id) {
      case 'conversation':
        return {
          meta: (
            <button
              type="button"
              className="panel-meta-btn no-drag"
              onClick={resetConversation}
              title="Clear this conversation (keeps memory, facts and projects)"
            >
              ⟲ RESET
            </button>
          ),
          body: <ChatLog messages={messages} streaming={streaming} />,
        };
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
      case 'settings':
        return {
          meta: <span className="panel-meta">{AGENT_IDS.length} AGENTS</span>,
          body:
            agentCfg && catalog ? (
              <AgentSettings config={agentCfg} catalog={catalog} onSave={saveAgent} />
            ) : (
              <div className="empty">LOADING…</div>
            ),
        };
      case 'graph':
        return {
          meta: <span className="panel-meta">notes + projects · live</span>,
          body: <GraphCard onReference={openReference} />,
        };
      case 'jobs':
        return {
          meta: <span className="panel-meta">{jobs.length} tasks · live</span>,
          body: <ScheduledTasksCard />,
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

  // WAKE button face: the toggle says whether it's ARMED; the live status says
  // what it's actually doing right now, so a stuck/failed mic is visible at a glance.
  const wakeFace = ((): { label: string; tone: '' | ' on' | ' danger'; title: string } => {
    if (!wake) return { label: '👂 WAKE OFF', tone: '', title: 'Wake word off — click to listen for “Alfred” (needs the STT helper compiled).' };
    switch (wakeStatus.status) {
      case 'suppressed':
        return { label: '👂 WAKE MUTED', tone: ' on', title: 'Wake word armed but muted — Alfred is speaking (half-duplex). Resumes when he stops.' };
      case 'failed':
        return { label: '⚠ WAKE FAILED', tone: ' danger', title: `Wake word failed: ${wakeStatus.reason ?? 'voice helper stopped'}. Auto-retrying; toggle to retry now.` };
      case 'disabled':
        return { label: '👂 WAKE N/A', tone: '', title: `Wake word unavailable: ${wakeStatus.reason ?? 'STT helper not found'}.` };
      case 'stopped':
        return { label: '👂 WAKE …', tone: ' on', title: 'Wake word armed — starting the listener.' };
      default: // listening
        return { label: '👂 WAKE ON', tone: ' on', title: 'Wake word on — say “Alfred …” to dictate a command (local, no account). Click to disable.' };
    }
  })();

  return (
    <div className="app">
      <div className="scanline">
        <div />
      </div>

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
            title={
              speaking
                ? 'Alfred is speaking — mic silenced (half-duplex). Click to mute voice output.'
                : tts
                  ? 'Voice output on — click to mute Alfred'
                  : 'Voice output off — click to let Alfred speak'
            }
          >
            {speaking ? '🗣 SPEAKING' : tts ? '🔊 VOICE ON' : '🔈 VOICE OFF'}
          </button>
          <button
            type="button"
            className={`topbar-btn no-drag${wakeFace.tone}`}
            onClick={toggleWake}
            title={wakeFace.title}
          >
            {wakeFace.label}
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
            className={`topbar-btn no-drag${grill ? ' on' : ''}`}
            onClick={toggleGrill}
            title={
              grill
                ? 'Grill-me on — Alfred interviews you to lock the plan before acting on ambiguous/high-stakes requests. Click to act directly.'
                : 'Grill-me off — Alfred acts directly. Click to make it lock the plan first on ambiguous/high-stakes requests.'
            }
          >
            {grill ? '◆ GRILL ON' : '◇ GRILL'}
          </button>
          <button
            type="button"
            className={`topbar-btn no-drag${dangerous ? ' on' : ''}`}
            onClick={toggleDangerous}
            title="Bypass ALL approvals (T2/T3 auto-run). Persisted. Use with care."
          >
            {dangerous ? '● DANGEROUS ON' : '○ DANGEROUS'}
          </button>
          <button
            type="button"
            className="topbar-btn danger no-drag"
            onClick={openFactoryReset}
            title="Factory reset — erase EVERYTHING Alfred knows (memory, DB, secrets, browser profile, projects)"
          >
            ⌫ FACTORY RESET
          </button>
          <button
            type="button"
            className={`topbar-btn no-drag${refTarget ? ' on' : ''}`}
            onClick={() => {
              const note = window.prompt('Reference — nota do grafo (slug ou título):');
              if (note && note.trim()) openReference({ note: note.trim() });
            }}
            title="Open the isolated Reference panel for a note (Phase 3: the graph opens this per node)"
          >
            ◈ REFERENCE
          </button>
          <button
            type="button"
            className="topbar-btn no-drag"
            onClick={() => {
              patchCard('jobs', { visible: true });
              focusCard('jobs');
            }}
            title="Scheduled Tasks — manage jobs (pause/resume/delete) and pending approvals"
          >
            ⏱ SCHEDULED
          </button>
          <button
            type="button"
            className="topbar-btn no-drag"
            onClick={() => {
              patchCard('settings', { visible: true });
              focusCard('settings');
            }}
            title="Settings — provider + model per agent (main / reference / curator)"
          >
            ⚙ SETTINGS
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
          speaking={speaking}
          partial={partial}
          onMic={toggleMic}
          dictation={dictation}
          submitSignal={submitSeq}
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
          .filter((c) => c.visible && cardOnDisplay(c.displayId, myDisplayId, isPrimary))
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
                onMoveDisplay={displays.length > 1 ? () => moveToNextDisplay(c) : undefined}
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

      {refTarget && (
        <ReferenceChat
          target={refTarget}
          title={refTitle}
          messages={refMessages}
          streaming={refStreaming}
          busy={refBusy}
          onAsk={askReference}
          onClose={closeReference}
        />
      )}

      {factoryInfo && (
        <div className="overlay">
          <div
            className="factory-reset no-drag"
            role="alertdialog"
            aria-label="Factory reset confirmation"
            style={{
              minWidth: 'min(560px, 92vw)',
              maxWidth: 'min(560px, 92vw)',
              background: 'var(--glass)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1px solid var(--red)',
              borderRadius: 14,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 0 44px -6px var(--red)',
              padding: 20,
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              color: 'var(--text)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span
                style={{
                  color: 'var(--red)',
                  border: '1px solid var(--red)',
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                DESTRUCTIVE
              </span>
              <span style={{ fontWeight: 600 }}>Factory reset</span>
            </div>

            <p style={{ fontSize: 13, margin: '0 0 12px', lineHeight: 1.5 }}>
              Isto apaga <strong>tudo o que o Alfred sabe e tem</strong>. Irreversível. Vai eliminar:
            </p>

            <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
              <li>
                Base de dados (chat, audit, budget, índice de projetos, contas, layout, settings/toggles) —{' '}
                <code>{factoryInfo.dbPath}</code>
                <br />
                <span style={{ color: 'var(--dim)' }}>
                  {factoryInfo.counts.messages} mensagens · {factoryInfo.counts.projects} projetos (índice) ·{' '}
                  {factoryInfo.counts.accounts} contas
                </span>
              </li>
              {factoryInfo.paths.map((p) => (
                <li key={p.path}>
                  {p.label}
                  <br />
                  <code>{p.path}</code>
                </li>
              ))}
              <li>
                Segredos no Keychain (tokens Gmail, serviço "alfred") —{' '}
                <span style={{ color: 'var(--dim)' }}>{factoryInfo.counts.secrets} conta(s)</span>
              </li>
            </ul>

            <label style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
              Escreve <strong>confirmar</strong> para ativar o botão:
            </label>
            <input
              type="text"
              className="no-drag"
              value={factoryConfirm}
              autoFocus
              disabled={factoryBusy}
              onChange={(ev) => setFactoryConfirm(ev.target.value)}
              placeholder="confirmar"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: 'var(--panel-2, #131b2b)',
                border: `1px solid ${confirmMatches(factoryConfirm) ? 'var(--red)' : 'rgba(255,255,255,0.15)'}`,
                borderRadius: 8,
                padding: '8px 10px',
                color: 'var(--text)',
                fontFamily: 'inherit',
                fontSize: 13,
                marginBottom: 14,
              }}
            />

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="topbar-btn no-drag"
                disabled={factoryBusy}
                onClick={() => setFactoryInfo(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="topbar-btn danger no-drag"
                disabled={!confirmMatches(factoryConfirm) || factoryBusy}
                onClick={confirmFactoryReset}
                style={{ opacity: confirmMatches(factoryConfirm) && !factoryBusy ? 1 : 0.4 }}
              >
                {factoryBusy ? 'A apagar…' : 'Confirmar reset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const AGENT_HINT: Record<AgentId, string> = {
  main: 'chat principal',
  reference: 'referência (fase 2)',
  curator: 'curador da memória',
};

/**
 * SETTINGS card body: per agent (main / reference / curator) an editable name, a
 * provider dropdown and a model dropdown (filtered by provider, with in/out price).
 * Edits are held in a local draft; SAVE persists via IPC. Changing the provider
 * snaps the model to that provider's first entry so the pair is always valid.
 */
function AgentSettings({
  config,
  catalog,
  onSave,
}: {
  config: AgentConfigMap;
  catalog: Record<ProviderId, CatalogModel[]>;
  onSave: (id: AgentId, patch: AgentConfig) => void;
}) {
  const [draft, setDraft] = useState<AgentConfigMap>(config);
  // Resync when the store changes underneath us (e.g. the BRAINS panel changed main).
  useEffect(() => setDraft(config), [config]);

  const setField = (id: AgentId, patch: Partial<AgentConfig>) =>
    setDraft((d) => {
      const next = { ...d[id], ...patch };
      if (patch.provider && !listModels(patch.provider).some((m) => m.id === next.model)) {
        // Snap to the provider default (same as the BRAINS-panel switch) so both
        // paths land on the same model — not the first list entry.
        next.model = DEFAULT_MODEL[patch.provider] ?? listModels(patch.provider)[0]?.id ?? next.model;
      }
      return { ...d, [id]: next };
    });

  return (
    <div className="settings">
      {AGENT_IDS.map((id) => {
        const a = draft[id];
        const models = catalog[a.provider] ?? listModels(a.provider);
        const note = findModel(a.provider, a.model)?.notes;
        const dirty = JSON.stringify(a) !== JSON.stringify(config[id]);
        return (
          <div className="settings-agent" key={id}>
            <div className="settings-agent-id">
              {id.toUpperCase()} <span className="settings-agent-hint">· {AGENT_HINT[id]}</span>
            </div>
            <input
              className="settings-name no-drag"
              value={a.name}
              placeholder={id}
              onChange={(e) => setField(id, { name: e.target.value })}
            />
            <div className="settings-row">
              <select
                className="settings-select no-drag"
                value={a.provider}
                onChange={(e) => setField(id, { provider: e.target.value as ProviderId })}
              >
                {PROVIDER_IDS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
              <select
                className="settings-select no-drag"
                value={a.model}
                onChange={(e) => setField(id, { model: e.target.value })}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} — ${m.inputPerM}/${m.outputPerM}
                  </option>
                ))}
              </select>
            </div>
            {note && <div className="settings-note">{note}</div>}
            <button
              type="button"
              className={`settings-save no-drag${dirty ? ' dirty' : ''}`}
              disabled={!dirty}
              onClick={() => onSave(id, a)}
            >
              {dirty ? 'GUARDAR' : 'GUARDADO'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
