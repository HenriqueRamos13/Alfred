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
  TeamAgentInfo,
  VoiceConfig,
  WakeStatus,
} from './core/types.ts';
import type { ProjectDetail } from './core/projects.ts';
import type { KanbanCard } from './core/kanban-pure.ts';
import type { InboxMessage } from './core/inbox-pure.ts';
import type { InboxFilter, InboxResult } from './core/inbox.ts';
import type { AgentNotification } from './core/notify-pure.ts';
import type { NotificationFilter } from './core/notify.ts';
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
  /** Kill switch — abort the running task (latches: suppresses mic/wake). */
  stop(): void;
  /** Soft cancel — abort the turn without latching; input stays usable. */
  cancel(): void;
  /** Resolve a pending HITL approval (unblocks governance.requestApproval). `remember` persists an auto-approve rule. */
  resolveApproval(resolution: { id: string; decision: ApprovalDecision; remember?: boolean }): void;
  /** DANGEROUS mode (bypass all approvals): read/toggle, persisted. */
  getDangerousMode(): boolean | Promise<boolean>;
  setDangerousMode(on: boolean): boolean | Promise<boolean>;
  /** SPAWN kill-switch (freeze new fan-out): read/toggle, persisted, default OFF. */
  getSpawnPaused(): boolean | Promise<boolean>;
  setSpawnPaused(on: boolean): boolean | Promise<boolean>;
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
  /** UI accent (recolours only --acc): read/set, persisted, validated, default "cyan". */
  getAccent(): string | Promise<string>;
  setAccent(name: string): string | Promise<string>;
  /** ElevenLabs cloud voice toggle (which voice, not whether to speak): read/set, persisted. */
  getElevenlabs(): boolean | Promise<boolean>;
  setElevenlabs(on: boolean): boolean | Promise<boolean>;
  /** TTS voice knobs (engine/voice/rate/eleven voice id): read/set, persisted, hot-applied. */
  getVoiceConfig(): VoiceConfig | Promise<VoiceConfig>;
  setVoiceConfig(patch: VoiceConfig): VoiceConfig | Promise<VoiceConfig>;
  /** Auto-send toggle (submit dictation on stt.final): read/set, persisted. */
  getAutosend(): boolean | Promise<boolean>;
  setAutosend(on: boolean): boolean | Promise<boolean>;
  /** Send-delay / edit window (ms): hold a submitted message before it reaches the AI. Read/set, persisted, default 2000, 0 = off. */
  getSendDelay(): number | Promise<number>;
  setSendDelay(ms: number): number | Promise<number>;
  /** Widget JS toggle (run tier-2 widget scripts via the alfred-widget:// protocol): read/set, persisted, default OFF. */
  getWidgetScripts(): boolean | Promise<boolean>;
  setWidgetScripts(on: boolean): boolean | Promise<boolean>;
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
  /** One job by id (management-card refresh after a mutation). */
  getJob(id: string): Job | undefined | Promise<Job | undefined>;
  /** Pause a job (disable + disarm) from the management card. */
  pauseJob(id: string): Job | undefined | Promise<Job | undefined>;
  /** Resume a paused job (re-enable + re-arm) from the management card. */
  resumeJob(id: string): Job | undefined | Promise<Job | undefined>;
  /** Delete a job (+ runs/approvals) and disarm it. */
  deleteJob(id: string): void | Promise<void>;
  /** Stop the in-app job scheduler (clears its timers) on shutdown. */
  stopScheduler(): void;
  // ── Team roster (Phase 5) — data-only for the TEAM card. ──
  /** Roster projection for the TEAM card (role/model, tokens today, studied topics). */
  listTeamAgents(): TeamAgentInfo[] | Promise<TeamAgentInfo[]>;
  /** Delete a roster agent (row + index entry). Resolves to whether a row was removed. */
  deleteTeamAgent(id: string): Promise<boolean>;
  /** Reparent an agent in the org hierarchy (parentId null = top). Refuses cycles / over-depth explicitly. */
  setManager(agentId: string, parentId: string | null): { ok: boolean; error?: string };
  // ── Projects + Kanban (Phase 7) ──
  /** One project's manifest + file tree by slug (the missing IPC bridge; core exists). */
  getProject(slug: string): ProjectDetail | null | Promise<ProjectDetail | null>;
  /** Every kanban card on a project's board. */
  listCards(projectSlug: string): KanbanCard[] | Promise<KanbanCard[]>;
  /** The user's direct board op (drag/edit/delete) — see the orchestrator method. */
  kanban(op: string, args: Record<string, unknown>): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  // ── Human inbox (Phase 7 stage 3). ──
  /** Speak arbitrary text (the Inbox "▶ Ouvir" button). */
  speakText(text: string): void;
  /** Inbox messages, optionally filtered (newest first). */
  listInbox(filter?: InboxFilter): InboxMessage[] | Promise<InboxMessage[]>;
  /** Apply the user's typed answer (accept/edit/respond/reject; reject needs a reason). */
  answerInbox(id: string, action: string, text?: string): InboxResult | Promise<InboxResult>;
  /** Mark a message read (drops the unread badge). */
  markInboxRead(id: string): InboxMessage | undefined | Promise<InboxMessage | undefined>;
  // ── Notifications + heartbeat (Phase 7 stage 4). ──
  /** Notifications for the Activity feed, optionally filtered (newest first). */
  listNotifications(filter?: NotificationFilter): AgentNotification[] | Promise<AgentNotification[]>;
  /** Mark one notification seen. */
  markNotificationSeen(id: string): AgentNotification | undefined | Promise<AgentNotification | undefined>;
  /** Heartbeat toggle + sweep interval (read/set). */
  getHeartbeat(): { enabled: boolean; intervalMs: number } | Promise<{ enabled: boolean; intervalMs: number }>;
  setHeartbeat(patch: { enabled?: boolean; intervalMs?: number }): { enabled: boolean; intervalMs: number } | Promise<{ enabled: boolean; intervalMs: number }>;
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

  ipcMain.handle('alfred:getAccent', guard('get accent', () => core.getAccent(), 'cyan'));
  ipcMain.handle('alfred:setAccent', async (_e, name: unknown) => {
    try {
      return await core.setAccent(typeof name === 'string' ? name : '');
    } catch (err) {
      fail('set accent', err);
      return 'cyan';
    }
  });

  ipcMain.handle('alfred:getElevenlabs', guard('get elevenlabs', () => core.getElevenlabs(), false));
  ipcMain.handle('alfred:setElevenlabs', async (_e, on: unknown) => {
    try {
      return await core.setElevenlabs(on === true);
    } catch (err) {
      fail('set elevenlabs', err);
      return false;
    }
  });

  ipcMain.handle('alfred:getVoiceConfig', guard('get voice config', () => core.getVoiceConfig(), {} as VoiceConfig));
  ipcMain.handle('alfred:setVoiceConfig', async (_e, patch: unknown) => {
    try {
      // Trust boundary: pass only a plain object; the core re-parses/sanitises it.
      return await core.setVoiceConfig(patch && typeof patch === 'object' ? (patch as VoiceConfig) : {});
    } catch (err) {
      fail('set voice config', err);
      return {} as VoiceConfig;
    }
  });

  ipcMain.handle('alfred:getAutosend', guard('get autosend', () => core.getAutosend(), false));
  ipcMain.handle('alfred:setAutosend', async (_e, on: unknown) => {
    try {
      return await core.setAutosend(on === true);
    } catch (err) {
      fail('set autosend', err);
      return false;
    }
  });

  ipcMain.handle('alfred:getSendDelay', guard('get send delay', () => core.getSendDelay(), 2000));
  ipcMain.handle('alfred:setSendDelay', async (_e, ms: unknown) => {
    try {
      return await core.setSendDelay(typeof ms === 'number' ? ms : 0);
    } catch (err) {
      fail('set send delay', err);
      return 0;
    }
  });

  ipcMain.handle('alfred:getWidgetScripts', guard('get widget scripts', () => core.getWidgetScripts(), false));
  ipcMain.handle('alfred:setWidgetScripts', async (_e, on: unknown) => {
    try {
      return await core.setWidgetScripts(on === true);
    } catch (err) {
      fail('set widget scripts', err);
      return false;
    }
  });

  ipcMain.on('alfred:setViewport', (_e, w: unknown, h: unknown) => {
    if (typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h)) {
      core.setViewport(w, h);
    }
  });

  ipcMain.on('alfred:stop', () => core.stop());
  ipcMain.on('alfred:cancel', () => core.cancel());
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
  ipcMain.handle('alfred:getSpawnPaused', guard('get spawn paused', () => core.getSpawnPaused(), false));
  ipcMain.handle('alfred:setSpawnPaused', async (_e, on: unknown) => {
    try {
      return await core.setSpawnPaused(on === true);
    } catch (err) {
      fail('set spawn paused', err);
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
  // Job management from the "Scheduled Tasks" card. Data-only mutations; the id
  // is validated at this trust boundary (createJob is NOT exposed — jobs are made
  // by command/tool). Each returns the fresh job (or null) so the card can patch.
  const jobMutate =
    (label: string, run: (id: string) => Job | undefined | Promise<Job | undefined>) =>
    async (_e: unknown, id: unknown): Promise<Job | null> => {
      if (typeof id !== 'string' || !id) return null;
      try {
        return (await run(id)) ?? null;
      } catch (err) {
        fail(label, err);
        return null;
      }
    };
  ipcMain.handle('alfred:getJob', jobMutate('get job', (id) => core.getJob(id)));
  ipcMain.handle('alfred:pauseJob', jobMutate('pause job', (id) => core.pauseJob(id)));
  ipcMain.handle('alfred:resumeJob', jobMutate('resume job', (id) => core.resumeJob(id)));
  ipcMain.handle('alfred:deleteJob', async (_e, id: unknown): Promise<boolean> => {
    if (typeof id !== 'string' || !id) return false;
    try {
      await core.deleteJob(id);
      return true;
    } catch (err) {
      fail('delete job', err);
      return false;
    }
  });

  // ── Team roster — data-only. Read the roster projection; delete an agent.
  // create is NOT exposed (agents are made by the `team` command/tool). ──
  ipcMain.handle('alfred:listTeamAgents', guard('list team agents', () => core.listTeamAgents(), [] as TeamAgentInfo[]));
  ipcMain.handle('alfred:deleteTeamAgent', async (_e, id: unknown): Promise<boolean> => {
    if (typeof id !== 'string' || !id) return false;
    try {
      return await core.deleteTeamAgent(id);
    } catch (err) {
      fail('delete team agent', err);
      return false;
    }
  });
  // Reparent an agent in the org hierarchy. Trust boundary: agentId must be a
  // non-empty string; parentId is a non-empty string or null (top). Core re-checks
  // existence + refuses cycles / over-depth.
  ipcMain.handle('alfred:setManager', (_e, agentId: unknown, parentId: unknown): { ok: boolean; error?: string } => {
    if (typeof agentId !== 'string' || !agentId) return { ok: false, error: 'agentId is required' };
    const pid = typeof parentId === 'string' && parentId ? parentId : null;
    try {
      return core.setManager(agentId, pid);
    } catch (err) {
      fail('set manager', err);
      return { ok: false, error: 'set manager failed' };
    }
  });

  // ── Projects + Kanban (Phase 7) ──
  ipcMain.handle('alfred:getProject', async (_e, slug: unknown): Promise<ProjectDetail | null> => {
    if (typeof slug !== 'string' || !slug) return null;
    try {
      return (await core.getProject(slug)) ?? null;
    } catch (err) {
      fail('get project', err);
      return null;
    }
  });
  ipcMain.handle('alfred:listCards', async (_e, projectSlug: unknown): Promise<KanbanCard[]> => {
    if (typeof projectSlug !== 'string' || !projectSlug) return [];
    try {
      return await core.listCards(projectSlug);
    } catch (err) {
      fail('list cards', err);
      return [];
    }
  });
  // The user's direct board op. Trust boundary: op is a whitelisted string; args
  // is coerced to a plain object of primitive/array fields (core re-validates).
  ipcMain.handle('alfred:kanban', async (_e, op: unknown, rawArgs: unknown): Promise<{ ok: boolean; error?: string }> => {
    const OPS = ['create_card', 'update_card', 'move_card', 'assign', 'comment', 'claim', 'complete', 'delete_card'];
    if (typeof op !== 'string' || !OPS.includes(op)) return { ok: false, error: 'unknown kanban op' };
    const src = (rawArgs ?? {}) as Record<string, unknown>;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v)) args[k] = v;
    }
    try {
      return await core.kanban(op, args);
    } catch (err) {
      fail('kanban', err);
      return { ok: false, error: 'kanban failed' };
    }
  });

  // ── Human inbox (Phase 7 stage 3) — async HITL. ──
  // Speak arbitrary text (the "▶ Ouvir" button). Fire-and-forget like startListening.
  ipcMain.on('alfred:speakText', (_e, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return;
    try {
      core.speakText(text);
    } catch (err) {
      fail('speak text', err);
    }
  });
  ipcMain.handle('alfred:listInbox', async (_e, rawFilter: unknown): Promise<InboxMessage[]> => {
    // Trust boundary: keep only well-formed string filter fields.
    const src = (rawFilter ?? {}) as Record<string, unknown>;
    const filter: InboxFilter = {};
    if (typeof src.projectSlug === 'string' && src.projectSlug) filter.projectSlug = src.projectSlug;
    if (typeof src.status === 'string' && src.status) filter.status = src.status;
    if (typeof src.agentId === 'string' && src.agentId) filter.agentId = src.agentId;
    try {
      return await core.listInbox(filter);
    } catch (err) {
      fail('list inbox', err);
      return [];
    }
  });
  ipcMain.handle('alfred:answerInbox', async (_e, id: unknown, action: unknown, text: unknown): Promise<InboxResult> => {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'id is required' };
    if (typeof action !== 'string') return { ok: false, error: 'action is required' };
    const t = typeof text === 'string' ? text : undefined;
    try {
      return await core.answerInbox(id, action, t);
    } catch (err) {
      fail('answer inbox', err);
      return { ok: false, error: 'answer inbox failed' };
    }
  });
  ipcMain.handle('alfred:markInboxRead', async (_e, id: unknown): Promise<InboxMessage | null> => {
    if (typeof id !== 'string' || !id) return null;
    try {
      return (await core.markInboxRead(id)) ?? null;
    } catch (err) {
      fail('mark inbox read', err);
      return null;
    }
  });

  // ── Notifications + heartbeat (Phase 7 stage 4). ──
  ipcMain.handle('alfred:listNotifications', async (_e, rawFilter: unknown): Promise<AgentNotification[]> => {
    const src = (rawFilter ?? {}) as Record<string, unknown>;
    const filter: NotificationFilter = {};
    if (typeof src.toAgentId === 'string' && src.toAgentId) filter.toAgentId = src.toAgentId;
    if (typeof src.projectSlug === 'string' && src.projectSlug) filter.projectSlug = src.projectSlug;
    if (src.unseenOnly === true) filter.unseenOnly = true;
    try {
      return await core.listNotifications(filter);
    } catch (err) {
      fail('list notifications', err);
      return [];
    }
  });
  ipcMain.handle('alfred:markNotificationSeen', async (_e, id: unknown): Promise<AgentNotification | null> => {
    if (typeof id !== 'string' || !id) return null;
    try {
      return (await core.markNotificationSeen(id)) ?? null;
    } catch (err) {
      fail('mark notification seen', err);
      return null;
    }
  });
  ipcMain.handle('alfred:getHeartbeat', guard('get heartbeat', () => core.getHeartbeat(), { enabled: false, intervalMs: 60_000 }));
  ipcMain.handle('alfred:setHeartbeat', async (_e, patch: unknown): Promise<{ enabled: boolean; intervalMs: number }> => {
    const src = (patch ?? {}) as Record<string, unknown>;
    const clean: { enabled?: boolean; intervalMs?: number } = {};
    if (typeof src.enabled === 'boolean') clean.enabled = src.enabled;
    if (typeof src.intervalMs === 'number' && Number.isFinite(src.intervalMs)) clean.intervalMs = src.intervalMs;
    try {
      return await core.setHeartbeat(clean);
    } catch (err) {
      fail('set heartbeat', err);
      return { enabled: false, intervalMs: 60_000 };
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
