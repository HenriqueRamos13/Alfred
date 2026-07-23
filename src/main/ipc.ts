/**
 * IPC wiring: UI ⇄ core. The renderer only ever reaches the orchestrator
 * through the channels registered here.
 *
 * `Orchestrator` is the single façade this shell consumes. The core team
 * builds it in `core/orchestrator.ts` (createOrchestrator); the shape below is
 * the contract the shell relies on — streaming already flows out via the
 * injected `emit` callback (see index.ts), so IPC is only inbound commands
 * plus a couple of read queries.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { hideAllWindows, toggleAllWindows } from './windows.ts';
import type {
  ApprovalDecision,
  ProjectRecord,
  AccountRecord,
  CardLayout,
  CardPatch,
  ChatMessage,
  CostSnapshot,
  Job,
  JobApproval,
  StreamEvent,
  WakeStatus,
} from './core/types.ts';
import type { BrainInfo } from './core/providers.ts';
import type { FactoryResetInfo } from './core/orchestrator.ts';
import type { Graph } from './core/graph.ts';
import type { ReferenceRequest } from './core/reference.ts';
import {
  AGENT_IDS,
  isProviderId,
  type AgentId,
  type AgentConfig,
  type AgentConfigMap,
  type CatalogModel,
  type ProviderId,
} from './core/modelCatalog.ts';

export interface Orchestrator {
  /** Run one command / chat turn; streams StreamEvents via the injected emit. */
  send(text: string): Promise<void>;
  /** Recent persisted chat messages for the UI to reload on open. */
  getHistory(limit?: number): ChatMessage[] | Promise<ChatMessage[]>;
  /** Kill switch — abort the running task. */
  stop(): void;
  /** Resolve a pending HITL approval (unblocks governance.requestApproval). `remember` persists an auto-approve rule. */
  resolveApproval(resolution: { id: string; decision: ApprovalDecision; remember?: boolean }): void;
  /** DANGEROUS mode (bypass all approvals): read/toggle, persisted. */
  getDangerousMode(): boolean | Promise<boolean>;
  setDangerousMode(on: boolean): boolean | Promise<boolean>;
  /** GRILL-ME (plan-clarity interview): read/toggle, persisted, default ON. */
  getGrillMe(): boolean | Promise<boolean>;
  setGrillMe(on: boolean): boolean | Promise<boolean>;
  /** Clear all persisted auto-approve rules. */
  resetApprovals(): void;
  /** Reset ONLY the main conversation (chat + claude-code session); keeps memory/projects. */
  resetConversation(): void;
  /** What a factory reset will erase (paths + counts), for the confirmation modal. */
  factoryResetInfo(): FactoryResetInfo | Promise<FactoryResetInfo>;
  /** Nuke everything Alfred knows. */
  factoryReset(): Promise<void>;
  /** Manually run the memory curator (drain inbox → notes, rebuild MOCs/backlinks). */
  runCurator(): Promise<unknown>;
  /** Knowledge-graph data for the graph card. */
  getGraph(): Promise<Graph>;
  /** Read-only note markdown for the graph card's node preview. */
  getNote(ref: string): Promise<{ title: string; markdown: string } | null>;
  /** Reference agent: one isolated, read-only turn over a note/node (streams reference.*). */
  askReference(req: ReferenceRequest): Promise<void>;
  listProjects(): ProjectRecord[] | Promise<ProjectRecord[]>;
  listAccounts(): AccountRecord[] | Promise<AccountRecord[]>;
  /** Brain availability for the UI. */
  listBrains(): BrainInfo[] | Promise<BrainInfo[]>;
  /** Effective active brain id. */
  getActiveBrain(): string | null | Promise<string | null>;
  /** Persist the active brain (enabled only); returns the new effective id. */
  setActiveBrain(id: string): string | null | Promise<string | null>;
  /** Per-agent config (main / reference / curator). */
  getAgentConfig(): AgentConfigMap | Promise<AgentConfigMap>;
  /** Patch one agent's config; returns the full config. */
  setAgentConfig(id: AgentId, patch: Partial<AgentConfig>): AgentConfigMap | Promise<AgentConfigMap>;
  /** The hardcoded model catalog, per provider. */
  getModelCatalog(): Record<ProviderId, CatalogModel[]> | Promise<Record<ProviderId, CatalogModel[]>>;
  connectGmail(): Promise<AccountRecord | null>;
  /** Full floating-card layout. */
  getLayout(): CardLayout[] | Promise<CardLayout[]>;
  /** Persist a card patch from a user drag/resize; returns the new layout. */
  updateCard(id: string, patch: CardPatch): CardLayout[] | Promise<CardLayout[]>;
  /** Record the live canvas size (renderer) so the AI's ui_layout stays in-bounds. */
  setViewport(w: number, h: number): void;
  /** Today's persisted cost snapshot (read at startup). */
  getCost(): CostSnapshot | Promise<CostSnapshot>;
  /** Voice output toggle (Alfred speaks replies): read/set, persisted. */
  getTts(): boolean | Promise<boolean>;
  setTts(on: boolean): boolean | Promise<boolean>;
  /** Voice input (push-to-talk): start/stop the native STT helper. */
  startListening(): void;
  stopListening(): void;
  /** Wake word ("Alfred", always-on): read/set, persisted. */
  getWakeword(): boolean | Promise<boolean>;
  setWakeword(on: boolean): boolean | Promise<boolean>;
  /** Live wake-listener state, read on mount so the WAKE button isn't blind at boot. */
  getWakeStatus(): { status: WakeStatus; reason?: string } | Promise<{ status: WakeStatus; reason?: string }>;
  // ── Scheduled jobs (Phase 4) — data channel only; stage 3 builds the UI. ──
  /** Every persisted scheduled job (management card). */
  listJobs(): Job[] | Promise<Job[]>;
  /** Pending sensitive-action approvals for unattended agent jobs (all, or one job). */
  listPendingApprovals(jobId?: string): JobApproval[] | Promise<JobApproval[]>;
  /** Resolve a queued job approval; approve executes the stored action through normal governance. */
  resolveJobApproval(id: string, approved: boolean): Promise<JobApproval | undefined>;
  /** Stop the in-app job scheduler (clears its timers) on shutdown. */
  stopScheduler(): void;
}

/** Trust boundary: keep only well-formed numeric/boolean fields from the renderer. */
function sanitizeCardPatch(patch: unknown): CardPatch {
  const p = (patch ?? {}) as Record<string, unknown>;
  const out: CardPatch = {};
  for (const k of ['x', 'y', 'w', 'h', 'z'] as const) {
    if (typeof p[k] === 'number' && Number.isFinite(p[k])) out[k] = p[k] as number;
  }
  if (typeof p.visible === 'boolean') out.visible = p.visible;
  if (typeof p.displayId === 'string' && p.displayId) out.displayId = p.displayId;
  return out;
}

export function registerIpc(core: Orchestrator, emit: (e: StreamEvent) => void): void {
  // Never let a raw rejection reach the renderer as the truncated, unreadable
  // "Error invoking remote method 'alfred:...'". Catch, log to the terminal, and
  // surface the FULL message to the UI as an 'error' stream event.
  const fail = (label: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[alfred] ${label} failed:`, message);
    emit({ kind: 'error', sessionId: '', message: `${label} failed: ${message}` });
  };
  const guard = <T>(label: string, fn: () => T | Promise<T>, fallback: T) => async (): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      fail(label, err);
      return fallback;
    }
  };

  ipcMain.handle('alfred:send', async (_e, text: unknown) => {
    try {
      await core.send(String(text ?? ''));
    } catch (err) {
      fail('send', err);
    }
  });
  ipcMain.handle('alfred:getHistory', async (_e, limit: unknown) => {
    const n = typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined;
    try {
      return await core.getHistory(n);
    } catch (err) {
      fail('get history', err);
      return [] as ChatMessage[];
    }
  });
  ipcMain.handle('alfred:listProjects', guard('list projects', () => core.listProjects(), [] as ProjectRecord[]));
  ipcMain.handle('alfred:listAccounts', guard('list accounts', () => core.listAccounts(), [] as AccountRecord[]));
  ipcMain.handle('alfred:listBrains', guard('list brains', () => core.listBrains(), [] as BrainInfo[]));
  ipcMain.handle('alfred:getActiveBrain', guard('get active brain', () => core.getActiveBrain(), null as string | null));
  ipcMain.handle('alfred:setActiveBrain', async (_e, id: unknown) => {
    if (typeof id !== 'string') return null;
    try {
      return await core.setActiveBrain(id);
    } catch (err) {
      fail('set active brain', err);
      return null;
    }
  });
  ipcMain.handle('alfred:getAgentConfig', guard('get agent config', () => core.getAgentConfig(), null as AgentConfigMap | null));
  ipcMain.handle('alfred:setAgentConfig', async (_e, id: unknown, patch: unknown) => {
    // Trust boundary: id must be a known agent; patch fields validated (provider
    // against the catalog, model/name as strings) — core coerces the rest.
    if (typeof id !== 'string' || !(AGENT_IDS as readonly string[]).includes(id)) return null;
    const p = (patch ?? {}) as Record<string, unknown>;
    const clean: Partial<AgentConfig> = {};
    if (isProviderId(p.provider)) clean.provider = p.provider;
    if (typeof p.model === 'string') clean.model = p.model;
    if (typeof p.name === 'string') clean.name = p.name;
    try {
      return await core.setAgentConfig(id as AgentId, clean);
    } catch (err) {
      fail('set agent config', err);
      return null;
    }
  });
  ipcMain.handle(
    'alfred:getModelCatalog',
    guard('get model catalog', () => core.getModelCatalog(), {} as Record<ProviderId, CatalogModel[]>),
  );
  ipcMain.handle('alfred:connectGmail', guard('connect Gmail', () => core.connectGmail(), null as AccountRecord | null));
  ipcMain.handle('alfred:getLayout', guard('get layout', () => core.getLayout(), [] as CardLayout[]));
  ipcMain.handle('alfred:updateCard', async (_e, id: unknown, patch: unknown) => {
    if (typeof id !== 'string') return [] as CardLayout[];
    try {
      return await core.updateCard(id, sanitizeCardPatch(patch));
    } catch (err) {
      fail('update card', err);
      return [] as CardLayout[];
    }
  });

  ipcMain.handle('alfred:getCost', guard('get cost', () => core.getCost(), null as CostSnapshot | null));

  ipcMain.handle('alfred:getTts', guard('get tts', () => core.getTts(), false));
  ipcMain.handle('alfred:setTts', async (_e, on: unknown) => {
    try {
      return await core.setTts(on === true);
    } catch (err) {
      fail('set tts', err);
      return false;
    }
  });

  ipcMain.on('alfred:setViewport', (_e, w: unknown, h: unknown) => {
    if (typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h)) {
      core.setViewport(w, h);
    }
  });

  ipcMain.on('alfred:stop', () => core.stop());
  ipcMain.on('alfred:startListening', () => {
    try {
      core.startListening();
    } catch (err) {
      fail('start listening', err);
    }
  });
  ipcMain.on('alfred:stopListening', () => {
    try {
      core.stopListening();
    } catch (err) {
      fail('stop listening', err);
    }
  });
  ipcMain.handle('alfred:getWakeword', guard('get wakeword', () => core.getWakeword(), false));
  ipcMain.handle('alfred:setWakeword', async (_e, on: unknown) => {
    try {
      return await core.setWakeword(on === true);
    } catch (err) {
      fail('set wakeword', err);
      return false;
    }
  });
  ipcMain.handle(
    'alfred:getWakeStatus',
    guard('get wake status', () => core.getWakeStatus(), { status: 'stopped' as WakeStatus }),
  );

  ipcMain.on('alfred:resolveApproval', (_e, id: unknown, decision: unknown, remember: unknown) => {
    // Trust boundary: only forward well-formed decisions.
    if (typeof id !== 'string') return;
    if (decision !== 'approve' && decision !== 'deny') return;
    core.resolveApproval({ id, decision, remember: remember === true });
  });

  ipcMain.handle('alfred:getDangerousMode', guard('get dangerous mode', () => core.getDangerousMode(), false));
  ipcMain.handle('alfred:setDangerousMode', async (_e, on: unknown) => {
    try {
      return await core.setDangerousMode(on === true);
    } catch (err) {
      fail('set dangerous mode', err);
      return false;
    }
  });
  ipcMain.handle('alfred:getGrillMe', guard('get grill me', () => core.getGrillMe(), true));
  ipcMain.handle('alfred:setGrillMe', async (_e, on: unknown) => {
    try {
      return await core.setGrillMe(on === true);
    } catch (err) {
      fail('set grill me', err);
      return true;
    }
  });
  ipcMain.on('alfred:resetApprovals', () => {
    try {
      core.resetApprovals();
    } catch (err) {
      fail('reset approvals', err);
    }
  });
  ipcMain.on('alfred:resetConversation', () => {
    try {
      core.resetConversation();
    } catch (err) {
      fail('reset conversation', err);
    }
  });
  ipcMain.handle(
    'alfred:factoryResetInfo',
    guard('factory reset info', () => core.factoryResetInfo(), null as FactoryResetInfo | null),
  );
  ipcMain.handle('alfred:factoryReset', async () => {
    try {
      await core.factoryReset();
    } catch (err) {
      fail('factory reset', err);
    }
  });
  ipcMain.handle('alfred:runCurator', guard('run curator', () => core.runCurator(), null as unknown));
  ipcMain.handle(
    'alfred:getGraph',
    guard('get graph', () => core.getGraph(), { nodes: [], edges: [] } as Graph),
  );
  ipcMain.handle('alfred:getNote', async (_e, ref: unknown) => {
    if (typeof ref !== 'string' || !ref.trim()) return null;
    try {
      return await core.getNote(ref);
    } catch (err) {
      fail('get note', err);
      return null;
    }
  });

  // ── Scheduled jobs — read the job list + the pending approval queue, and
  // resolve one approval. Data channel only; stage 3 wires the buttons. ──
  ipcMain.handle('alfred:listJobs', guard('list jobs', () => core.listJobs(), [] as Job[]));
  ipcMain.handle('alfred:listPendingApprovals', async (_e, jobId: unknown) => {
    const id = typeof jobId === 'string' && jobId ? jobId : undefined;
    try {
      return await core.listPendingApprovals(id);
    } catch (err) {
      fail('list pending approvals', err);
      return [] as JobApproval[];
    }
  });
  ipcMain.handle('alfred:resolveJobApproval', async (_e, id: unknown, approved: unknown) => {
    // Trust boundary: id must be a string, approved a real boolean.
    if (typeof id !== 'string' || !id || typeof approved !== 'boolean') return null;
    try {
      return (await core.resolveJobApproval(id, approved)) ?? null;
    } catch (err) {
      fail('resolve job approval', err);
      return null;
    }
  });

  // Reference agent — validate the whole payload at the boundary before it reaches
  // core. A missing threadId means we can't scope the stream, so drop silently.
  ipcMain.handle('alfred:askReference', async (_e, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (typeof p.threadId !== 'string' || !p.threadId) return;
    const t = (p.target ?? {}) as Record<string, unknown>;
    const target = {
      note: typeof t.note === 'string' ? t.note : undefined,
      project: typeof t.project === 'string' ? t.project : undefined,
      file: typeof t.file === 'string' ? t.file : undefined,
    };
    const history = Array.isArray(p.history)
      ? p.history
          .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
          .map((h) => ({
            role: h.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: typeof h.content === 'string' ? h.content : '',
          }))
          .filter((h) => h.content.trim())
      : [];
    try {
      await core.askReference({
        threadId: p.threadId,
        target,
        question: typeof p.question === 'string' ? p.question : '',
        history,
      });
    } catch (err) {
      fail('ask reference', err);
    }
  });
}

/**
 * Window controls for the frameless overlays — without these (and the draggable
 * top-bar in the UI) frameless always-on-top windows would trap the user.
 * Operate on EVERY window so hide/toggle cover all per-display overlays at once.
 *
 * `overlay:setInteractive` is the click-through pivot: each overlay starts
 * click-through (setIgnoreMouseEvents(true,{forward})); the renderer flips its
 * own window interactive while the pointer is over a card and back to
 * click-through when it leaves, so empty desktop stays clickable behind Alfred.
 */
export function registerWindowIpc(): void {
  ipcMain.on('window:hide', () => hideAllWindows());
  ipcMain.on('window:quit', () => app.quit());
  ipcMain.on('window:toggle', () => toggleAllWindows());
  ipcMain.on('overlay:setInteractive', (e, interactive: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    // forward:true keeps move events flowing so the renderer can detect the
    // pointer re-entering a card and flip back to interactive.
    win?.setIgnoreMouseEvents(!interactive, { forward: true });
  });
}
