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
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hideAllWindows, toggleAllWindows } from './windows.ts';
import { listVoices } from './core/voice-list.ts';
import type { VoiceOption } from './core/voice-list-pure.ts';
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
  TeamAgentDetail,
  TeamAgentInfo,
  VoiceConfig,
  WakeStatus,
  SttSettings,
} from './core/types.ts';
import type { SpawnLimits } from './core/team-pure.ts';
import type { ProjectDetail } from './core/projects.ts';
import type { KanbanCard } from './core/kanban-pure.ts';
import type { InboxMessage } from './core/inbox-pure.ts';
import type { InboxFilter, InboxResult } from './core/inbox.ts';
import { isValidMessageId, type ThreadInfo, type ThreadMessage } from './core/thread-pure.ts';
import type { SendUserMessageResult } from './core/threads.ts';
import type { AgentNotification } from './core/notify-pure.ts';
import type { NotificationFilter } from './core/notify.ts';
import type { BrainInfo } from './core/providers.ts';
import type { FactoryResetInfo } from './core/orchestrator.ts';
import type { Graph } from './core/graph.ts';
import type { ReferenceRequest } from './core/reference.ts';
import type { AgentFormSpec, AugmentFlags } from './core/agent-augment-pure.ts';
import type { TeamAgent } from './core/team-pure.ts';
import {
  AGENT_IDS,
  isProviderId,
  type AgentId,
  type AgentConfig,
  type AgentConfigMap,
  type CatalogModel,
  type ProviderId,
} from './core/modelCatalog.ts';
import { isTrustedPageUrl } from './core/electron-security-pure.ts';

function trustedRendererUrl(): string {
  return process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href;
}

/** Every privileged IPC call must come from Alfred's top-level renderer page. */
export function assertTrustedIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!frame || frame !== frame.top || !isTrustedPageUrl(frame.url, trustedRendererUrl())) {
    throw new Error(`Blocked IPC from untrusted frame: ${frame?.url || 'unknown'}`);
  }
}

type InvokeListener = Parameters<typeof ipcMain.handle>[1];

function secureHandle(channel: string, listener: InvokeListener): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event);
    return listener(event, ...args);
  });
}

function secureOn(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    assertTrustedIpcSender(event);
    listener(event, ...args);
  });
}

export interface Orchestrator {
  /**
   * Run one command / chat turn; streams StreamEvents via the injected emit.
   * `messageId` is the renderer's validated correlation id (turn.status events).
   */
  send(text: string, messageId?: string): Promise<void>;
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
  /** Spawn ceilings (maxConcurrentChildren / maxSpawnDepth): read/patch, persisted, clamped. */
  getSpawnLimits(): SpawnLimits | Promise<SpawnLimits>;
  setSpawnLimits(patch: Partial<SpawnLimits>): SpawnLimits | Promise<SpawnLimits>;
  /** GRILL-ME (plan-clarity interview): read/toggle, persisted, default ON. */
  getGrillMe(): boolean | Promise<boolean>;
  setGrillMe(on: boolean): boolean | Promise<boolean>;
  /** LOW-CPU mode (animations off, graph throttled): read/toggle, persisted, default OFF. */
  getLowCpu(): boolean | Promise<boolean>;
  setLowCpu(on: boolean): boolean | Promise<boolean>;
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
  getLanguage(): string | Promise<string>;
  setLanguage(lang: string): string | Promise<string>;
  /** ElevenLabs cloud voice toggle (which voice, not whether to speak): read/set, persisted. */
  getElevenlabs(): boolean | Promise<boolean>;
  setElevenlabs(on: boolean): boolean | Promise<boolean>;
  /** TTS voice knobs (engine/voice/rate/eleven voice id): read/set, persisted, hot-applied. */
  getVoiceConfig(): VoiceConfig | Promise<VoiceConfig>;
  setVoiceConfig(patch: VoiceConfig): VoiceConfig | Promise<VoiceConfig>;
  /** Auto-send toggle (submit dictation on stt.final): read/set, persisted. */
  getAutosend(): boolean | Promise<boolean>;
  setAutosend(on: boolean): boolean | Promise<boolean>;
  /** STT engine + cloud knobs (engine local|openai, speed, trim, model): read/patch, persisted. */
  getSttSettings(): SttSettings | Promise<SttSettings>;
  setSttSettings(patch: Partial<Omit<SttSettings, 'hasKey'>>): SttSettings | Promise<SttSettings>;
  /** Send-delay / edit window (ms): hold a submitted message before it reaches the AI. Read/set, persisted, default 0. */
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
  /** Full detail of one roster agent (row + tokens/topics/activity + knowledge notes); null when unknown. */
  getTeamAgentDetail(id: string): TeamAgentDetail | null | Promise<TeamAgentDetail | null>;
  /** Markdown of one of an agent's knowledge notes (the modal's viewer); null when absent. */
  readAgentNote(agentId: string, slug: string): string | null | Promise<string | null>;
  /** Delete a roster agent (row + index entry). Resolves to whether a row was removed. */
  deleteTeamAgent(id: string): Promise<boolean>;
  /** Reparent an agent in the org hierarchy (parentId null = top). Refuses cycles / over-depth explicitly. */
  setManager(agentId: string, parentId: string | null): { ok: boolean; error?: string };
  /** AI-augment a draft agent form spec (read-only cheap turn; no side effects). */
  augmentAgentSpec(spec: AgentFormSpec, flags: AugmentFlags): Promise<AgentFormSpec>;
  /** Create a roster agent from a completed form spec (UI create). Emits team.changed. */
  createTeamAgent(spec: AgentFormSpec): Promise<{ ok: boolean; error?: string; agent?: TeamAgent }>;
  /** Edit a roster agent from a completed form spec (UI edit; id/slug immutable). Emits team.changed. */
  updateTeamAgent(id: string, spec: AgentFormSpec): Promise<{ ok: boolean; error?: string; agent?: TeamAgent }>;
  // ── Projects + Kanban (Phase 7) ──
  /** One project's manifest + file tree by slug (the missing IPC bridge; core exists). */
  getProject(slug: string): ProjectDetail | null | Promise<ProjectDetail | null>;
  /** Every kanban card on a project's board. */
  listCards(projectSlug: string): KanbanCard[] | Promise<KanbanCard[]>;
  /** P7 "PARAR": is this project stopped? */
  getProjectPaused(slug: string): boolean | Promise<boolean>;
  /** P7 "PARAR": stop/resume a project (emits project.changed). */
  setProjectPaused(slug: string, on: boolean): void | Promise<void>;
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
  // ── User↔agent threads (Phase 8 stage 8) — the direct conversation. ──
  /** Send the user's message to a roster agent; resolves once queued (events do the rest). */
  messageAgent(agentId: string, text: string, messageId?: string): Promise<SendUserMessageResult>;
  /** Stop the active/queued work in one direct conversation. */
  cancelAgentThread(threadId: string): boolean | Promise<boolean>;
  /** Threads with last message + unread count (newest activity first). */
  listThreads(): ThreadInfo[] | Promise<ThreadInfo[]>;
  /** One thread's transcript (oldest→newest). */
  listThreadMessages(threadId: string): ThreadMessage[] | Promise<ThreadMessage[]>;
  /** Mark a thread's agent replies read (clears the badge in every window). */
  markThreadRead(threadId: string): number | Promise<number>;
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

  // Trust boundary: `messageId` is the renderer's correlation id and becomes a
  // PRIMARY KEY, so only `[A-Za-z0-9-]{1,64}` passes — anything else is dropped and
  // main mints its own (the renderer learns the real id from turn.status).
  secureHandle('alfred:send', async (_e, text: unknown, messageId: unknown) => {
    try {
      await core.send(String(text ?? ''), isValidMessageId(messageId) ? messageId : undefined);
    } catch (err) {
      fail('send', err);
    }
  });
  secureHandle('alfred:getHistory', async (_e, limit: unknown) => {
    const n = typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined;
    try {
      return await core.getHistory(n);
    } catch (err) {
      fail('get history', err);
      return [] as ChatMessage[];
    }
  });
  secureHandle('alfred:listProjects', guard('list projects', () => core.listProjects(), [] as ProjectRecord[]));
  secureHandle('alfred:listAccounts', guard('list accounts', () => core.listAccounts(), [] as AccountRecord[]));
  secureHandle('alfred:listBrains', guard('list brains', () => core.listBrains(), [] as BrainInfo[]));
  secureHandle('alfred:getActiveBrain', guard('get active brain', () => core.getActiveBrain(), null as string | null));
  secureHandle('alfred:setActiveBrain', async (_e, id: unknown) => {
    if (typeof id !== 'string') return null;
    try {
      return await core.setActiveBrain(id);
    } catch (err) {
      fail('set active brain', err);
      return null;
    }
  });
  secureHandle('alfred:getAgentConfig', guard('get agent config', () => core.getAgentConfig(), null as AgentConfigMap | null));
  secureHandle('alfred:setAgentConfig', async (_e, id: unknown, patch: unknown) => {
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
  secureHandle(
    'alfred:getModelCatalog',
    guard('get model catalog', () => core.getModelCatalog(), {} as Record<ProviderId, CatalogModel[]>),
  );
  secureHandle('alfred:connectGmail', guard('connect Gmail', () => core.connectGmail(), null as AccountRecord | null));
  secureHandle('alfred:getLayout', guard('get layout', () => core.getLayout(), [] as CardLayout[]));
  secureHandle('alfred:updateCard', async (_e, id: unknown, patch: unknown) => {
    if (typeof id !== 'string') return [] as CardLayout[];
    try {
      return await core.updateCard(id, sanitizeCardPatch(patch));
    } catch (err) {
      fail('update card', err);
      return [] as CardLayout[];
    }
  });

  secureHandle('alfred:getCost', guard('get cost', () => core.getCost(), null as CostSnapshot | null));

  secureHandle('alfred:getTts', guard('get tts', () => core.getTts(), false));
  secureHandle('alfred:setTts', async (_e, on: unknown) => {
    try {
      return await core.setTts(on === true);
    } catch (err) {
      fail('set tts', err);
      return false;
    }
  });

  secureHandle('alfred:getAccent', guard('get accent', () => core.getAccent(), 'cyan'));
  secureHandle('alfred:setAccent', async (_e, name: unknown) => {
    try {
      return await core.setAccent(typeof name === 'string' ? name : '');
    } catch (err) {
      fail('set accent', err);
      return 'cyan';
    }
  });

  secureHandle('alfred:getLanguage', guard('get language', () => core.getLanguage(), 'pt-BR'));
  secureHandle('alfred:setLanguage', async (_e, lang: unknown) => {
    try {
      return await core.setLanguage(typeof lang === 'string' ? lang : '');
    } catch (err) {
      fail('set language', err);
      return 'pt-BR';
    }
  });

  secureHandle('alfred:getElevenlabs', guard('get elevenlabs', () => core.getElevenlabs(), false));
  secureHandle('alfred:setElevenlabs', async (_e, on: unknown) => {
    try {
      return await core.setElevenlabs(on === true);
    } catch (err) {
      fail('set elevenlabs', err);
      return false;
    }
  });

  secureHandle('alfred:getVoiceConfig', guard('get voice config', () => core.getVoiceConfig(), {} as VoiceConfig));
  secureHandle('alfred:setVoiceConfig', async (_e, patch: unknown) => {
    try {
      // Trust boundary: pass only a plain object; the core re-parses/sanitises it.
      return await core.setVoiceConfig(patch && typeof patch === 'object' ? (patch as VoiceConfig) : {});
    } catch (err) {
      fail('set voice config', err);
      return {} as VoiceConfig;
    }
  });

  // Voice catalog for the Settings selector — main-only (spawns macOS `say`);
  // degrades to [] off-Mac / on failure so the dropdown just shows no voices.
  secureHandle('alfred:listVoices', async (_e, engine: unknown) => {
    try {
      return await listVoices(typeof engine === 'string' ? engine : '');
    } catch (err) {
      fail('list voices', err);
      return [] as VoiceOption[];
    }
  });

  secureHandle('alfred:getAutosend', guard('get autosend', () => core.getAutosend(), false));
  secureHandle('alfred:setAutosend', async (_e, on: unknown) => {
    try {
      return await core.setAutosend(on === true);
    } catch (err) {
      fail('set autosend', err);
      return false;
    }
  });

  const STT_DEFAULTS: SttSettings = { engine: 'local', hasKey: false, speed: 2.3, trimTailMs: 2000, model: 'gpt-4o-mini-transcribe' };
  secureHandle('alfred:getSttSettings', guard('get stt settings', () => core.getSttSettings(), STT_DEFAULTS));
  secureHandle('alfred:setSttSettings', async (_e, patch: unknown) => {
    try {
      // Trust boundary: pass only a plain object; the core clamps/validates each field.
      return await core.setSttSettings(patch && typeof patch === 'object' ? (patch as Partial<Omit<SttSettings, 'hasKey'>>) : {});
    } catch (err) {
      fail('set stt settings', err);
      return STT_DEFAULTS;
    }
  });

  secureHandle('alfred:getSendDelay', guard('get send delay', () => core.getSendDelay(), 0));
  secureHandle('alfred:setSendDelay', async (_e, ms: unknown) => {
    try {
      return await core.setSendDelay(typeof ms === 'number' ? ms : 0);
    } catch (err) {
      fail('set send delay', err);
      return 0;
    }
  });

  secureHandle('alfred:getWidgetScripts', guard('get widget scripts', () => core.getWidgetScripts(), false));
  secureHandle('alfred:setWidgetScripts', async (_e, on: unknown) => {
    try {
      return await core.setWidgetScripts(on === true);
    } catch (err) {
      fail('set widget scripts', err);
      return false;
    }
  });

  secureOn('alfred:setViewport', (_e, w: unknown, h: unknown) => {
    if (typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h)) {
      core.setViewport(w, h);
    }
  });

  secureOn('alfred:stop', () => core.stop());
  secureOn('alfred:cancel', () => core.cancel());
  secureOn('alfred:startListening', () => {
    try {
      core.startListening();
    } catch (err) {
      fail('start listening', err);
    }
  });
  secureOn('alfred:stopListening', () => {
    try {
      core.stopListening();
    } catch (err) {
      fail('stop listening', err);
    }
  });
  secureHandle('alfred:getWakeword', guard('get wakeword', () => core.getWakeword(), false));
  secureHandle('alfred:setWakeword', async (_e, on: unknown) => {
    try {
      return await core.setWakeword(on === true);
    } catch (err) {
      fail('set wakeword', err);
      return false;
    }
  });
  secureHandle(
    'alfred:getWakeStatus',
    guard('get wake status', () => core.getWakeStatus(), { status: 'stopped' as WakeStatus }),
  );

  secureOn('alfred:resolveApproval', (_e, id: unknown, decision: unknown, remember: unknown) => {
    // Trust boundary: only forward well-formed decisions.
    if (typeof id !== 'string') return;
    if (decision !== 'approve' && decision !== 'deny') return;
    core.resolveApproval({ id, decision, remember: remember === true });
  });

  secureHandle('alfred:getDangerousMode', guard('get dangerous mode', () => core.getDangerousMode(), false));
  secureHandle('alfred:setDangerousMode', async (_e, on: unknown) => {
    try {
      return await core.setDangerousMode(on === true);
    } catch (err) {
      fail('set dangerous mode', err);
      return false;
    }
  });
  secureHandle('alfred:getSpawnPaused', guard('get spawn paused', () => core.getSpawnPaused(), false));
  secureHandle('alfred:setSpawnPaused', async (_e, on: unknown) => {
    try {
      return await core.setSpawnPaused(on === true);
    } catch (err) {
      fail('set spawn paused', err);
      return false;
    }
  });
  const SPAWN_LIMITS_DEFAULT: SpawnLimits = { maxConcurrentChildren: 3, maxSpawnDepth: 2 };
  secureHandle('alfred:getSpawnLimits', guard('get spawn limits', () => core.getSpawnLimits(), SPAWN_LIMITS_DEFAULT));
  secureHandle('alfred:setSpawnLimits', async (_e, patch: unknown) => {
    try {
      const p = (patch ?? {}) as Record<string, unknown>;
      const clean: Partial<SpawnLimits> = {};
      if (typeof p.maxConcurrentChildren === 'number') clean.maxConcurrentChildren = p.maxConcurrentChildren;
      if (typeof p.maxSpawnDepth === 'number') clean.maxSpawnDepth = p.maxSpawnDepth;
      return await core.setSpawnLimits(clean);
    } catch (err) {
      fail('set spawn limits', err);
      return SPAWN_LIMITS_DEFAULT;
    }
  });
  secureHandle('alfred:getGrillMe', guard('get grill me', () => core.getGrillMe(), true));
  secureHandle('alfred:setGrillMe', async (_e, on: unknown) => {
    try {
      return await core.setGrillMe(on === true);
    } catch (err) {
      fail('set grill me', err);
      return true;
    }
  });
  secureHandle('alfred:getLowCpu', guard('get low cpu', () => core.getLowCpu(), false));
  secureHandle('alfred:setLowCpu', async (_e, on: unknown) => {
    try {
      return await core.setLowCpu(on === true);
    } catch (err) {
      fail('set low cpu', err);
      return false;
    }
  });
  secureOn('alfred:resetApprovals', () => {
    try {
      core.resetApprovals();
    } catch (err) {
      fail('reset approvals', err);
    }
  });
  secureOn('alfred:resetConversation', () => {
    try {
      core.resetConversation();
    } catch (err) {
      fail('reset conversation', err);
    }
  });
  secureHandle(
    'alfred:factoryResetInfo',
    guard('factory reset info', () => core.factoryResetInfo(), null as FactoryResetInfo | null),
  );
  secureHandle('alfred:factoryReset', async () => {
    try {
      await core.factoryReset();
    } catch (err) {
      fail('factory reset', err);
    }
  });
  secureHandle('alfred:runCurator', guard('run curator', () => core.runCurator(), null as unknown));
  secureHandle(
    'alfred:getGraph',
    guard('get graph', () => core.getGraph(), { nodes: [], edges: [] } as Graph),
  );
  secureHandle('alfred:getNote', async (_e, ref: unknown) => {
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
  secureHandle('alfred:listJobs', guard('list jobs', () => core.listJobs(), [] as Job[]));
  secureHandle('alfred:listPendingApprovals', async (_e, jobId: unknown) => {
    const id = typeof jobId === 'string' && jobId ? jobId : undefined;
    try {
      return await core.listPendingApprovals(id);
    } catch (err) {
      fail('list pending approvals', err);
      return [] as JobApproval[];
    }
  });
  secureHandle('alfred:resolveJobApproval', async (_e, id: unknown, approved: unknown) => {
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
  secureHandle('alfred:getJob', jobMutate('get job', (id) => core.getJob(id)));
  secureHandle('alfred:pauseJob', jobMutate('pause job', (id) => core.pauseJob(id)));
  secureHandle('alfred:resumeJob', jobMutate('resume job', (id) => core.resumeJob(id)));
  secureHandle('alfred:deleteJob', async (_e, id: unknown): Promise<boolean> => {
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
  secureHandle('alfred:listTeamAgents', guard('list team agents', () => core.listTeamAgents(), [] as TeamAgentInfo[]));
  // Full detail of one agent (the agent-detail modal). Trust boundary: a non-empty
  // string id; core returns null for an unknown/deleted agent and the slug charset is
  // re-asserted before any of it reaches the filesystem (listKnowledgeNotes).
  secureHandle('alfred:getTeamAgentDetail', async (_e, id: unknown): Promise<TeamAgentDetail | null> => {
    if (typeof id !== 'string' || !id) return null;
    try {
      return (await core.getTeamAgentDetail(id)) ?? null;
    } catch (err) {
      fail('get team agent detail', err);
      return null;
    }
  });
  // One knowledge note's markdown (the modal's note viewer). Both ids must be non-empty
  // strings here; core enforces the slug charset (defence in depth on a path segment).
  secureHandle('alfred:readAgentNote', async (_e, agentId: unknown, slug: unknown): Promise<string | null> => {
    if (typeof agentId !== 'string' || !agentId) return null;
    if (typeof slug !== 'string' || !slug) return null;
    try {
      return (await core.readAgentNote(agentId, slug)) ?? null;
    } catch (err) {
      fail('read agent note', err);
      return null;
    }
  });
  secureHandle('alfred:deleteTeamAgent', async (_e, id: unknown): Promise<boolean> => {
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
  secureHandle('alfred:setManager', (_e, agentId: unknown, parentId: unknown): { ok: boolean; error?: string } => {
    if (typeof agentId !== 'string' || !agentId) return { ok: false, error: 'agentId is required' };
    const pid = typeof parentId === 'string' && parentId ? parentId : null;
    try {
      return core.setManager(agentId, pid);
    } catch (err) {
      fail('set manager', err);
      return { ok: false, error: 'set manager failed' };
    }
  });
  // AI-augment a draft form spec (read-only; no side effects). The renderer's
  // fillFormSpec re-defaults anything malformed, so pass the payload through as a
  // partial spec and let core + the pure helpers sanitise it.
  secureHandle('alfred:augmentAgentSpec', async (_e, spec: unknown, flags: unknown): Promise<AgentFormSpec | null> => {
    try {
      return await core.augmentAgentSpec((spec ?? {}) as AgentFormSpec, (flags ?? {}) as AugmentFlags);
    } catch (err) {
      fail('augment agent spec', err);
      return null;
    }
  });
  // Create a roster agent from the completed form (the UI "Criar" button). Core
  // validates (name/provider/model/parent) and emits team.changed on success.
  secureHandle('alfred:createTeamAgent', async (_e, spec: unknown): Promise<{ ok: boolean; error?: string; agent?: TeamAgent }> => {
    try {
      return await core.createTeamAgent((spec ?? {}) as AgentFormSpec);
    } catch (err) {
      fail('create team agent', err);
      return { ok: false, error: 'create team agent failed' };
    }
  });
  // Edit a roster agent from the completed form (the modal's "editar" tab). The id/slug
  // is immutable — it identifies the row, the folder and the budget key. Core validates
  // (name/provider/model/parent/budget) and emits team.changed on success.
  secureHandle('alfred:updateTeamAgent', async (_e, id: unknown, spec: unknown): Promise<{ ok: boolean; error?: string; agent?: TeamAgent }> => {
    if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'invalid agent id' };
    try {
      return await core.updateTeamAgent(id, (spec ?? {}) as AgentFormSpec);
    } catch (err) {
      fail('update team agent', err);
      return { ok: false, error: 'update team agent failed' };
    }
  });

  // ── Projects + Kanban (Phase 7) ──
  secureHandle('alfred:getProject', async (_e, slug: unknown): Promise<ProjectDetail | null> => {
    if (typeof slug !== 'string' || !slug) return null;
    try {
      return (await core.getProject(slug)) ?? null;
    } catch (err) {
      fail('get project', err);
      return null;
    }
  });
  secureHandle('alfred:listCards', async (_e, projectSlug: unknown): Promise<KanbanCard[]> => {
    if (typeof projectSlug !== 'string' || !projectSlug) return [];
    try {
      return await core.listCards(projectSlug);
    } catch (err) {
      fail('list cards', err);
      return [];
    }
  });
  // ── P7 "PARAR" — per-project stop. Read + toggle. ──
  secureHandle('alfred:getProjectPaused', async (_e, slug: unknown): Promise<boolean> => {
    if (typeof slug !== 'string' || !slug) return false;
    try {
      return await core.getProjectPaused(slug);
    } catch (err) {
      fail('get project paused', err);
      return false;
    }
  });
  secureHandle('alfred:setProjectPaused', async (_e, slug: unknown, on: unknown): Promise<boolean> => {
    if (typeof slug !== 'string' || !slug) return false;
    try {
      await core.setProjectPaused(slug, !!on);
      return true;
    } catch (err) {
      fail('set project paused', err);
      return false;
    }
  });
  // The user's direct board op. Trust boundary: op is a whitelisted string; args
  // is coerced to a plain object of primitive/array fields (core re-validates).
  secureHandle('alfred:kanban', async (_e, op: unknown, rawArgs: unknown): Promise<{ ok: boolean; error?: string }> => {
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
  secureOn('alfred:speakText', (_e, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return;
    try {
      core.speakText(text);
    } catch (err) {
      fail('speak text', err);
    }
  });
  secureHandle('alfred:listInbox', async (_e, rawFilter: unknown): Promise<InboxMessage[]> => {
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
  secureHandle('alfred:answerInbox', async (_e, id: unknown, action: unknown, text: unknown): Promise<InboxResult> => {
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
  secureHandle('alfred:markInboxRead', async (_e, id: unknown): Promise<InboxMessage | null> => {
    if (typeof id !== 'string' || !id) return null;
    try {
      return (await core.markInboxRead(id)) ?? null;
    } catch (err) {
      fail('mark inbox read', err);
      return null;
    }
  });

  // ── User↔agent threads (Phase 8 stage 8) — the direct conversation. ──
  // Trust boundary: agentId/text are checked here as SHAPES (non-empty strings) and
  // re-validated in core (validateUserMessage + the roster lookup own the rules);
  // messageId must match the id whitelist or it is ignored, never coerced.
  secureHandle(
    'alfred:messageAgent',
    async (_e, agentId: unknown, text: unknown, messageId: unknown): Promise<SendUserMessageResult> => {
      if (typeof agentId !== 'string' || !agentId.trim()) return { ok: false, error: 'agentId is required' };
      if (typeof text !== 'string') return { ok: false, error: 'message must be a string' };
      try {
        return await core.messageAgent(agentId, text, isValidMessageId(messageId) ? messageId : undefined);
      } catch (err) {
        fail('message agent', err);
        return { ok: false, error: 'message agent failed' };
      }
    },
  );
  secureHandle('alfred:cancelAgentThread', async (_e, threadId: unknown): Promise<boolean> => {
    if (typeof threadId !== 'string' || !threadId.trim()) return false;
    try {
      return await core.cancelAgentThread(threadId);
    } catch (err) {
      fail('cancel agent thread', err);
      return false;
    }
  });
  secureHandle('alfred:listThreads', guard('list threads', () => core.listThreads(), [] as ThreadInfo[]));
  secureHandle('alfred:listThreadMessages', async (_e, threadId: unknown): Promise<ThreadMessage[]> => {
    if (typeof threadId !== 'string' || !threadId.trim()) return [];
    try {
      return await core.listThreadMessages(threadId);
    } catch (err) {
      fail('list thread messages', err);
      return [];
    }
  });
  secureHandle('alfred:markThreadRead', async (_e, threadId: unknown): Promise<number> => {
    if (typeof threadId !== 'string' || !threadId.trim()) return 0;
    try {
      return await core.markThreadRead(threadId);
    } catch (err) {
      fail('mark thread read', err);
      return 0;
    }
  });

  // ── Notifications + heartbeat (Phase 7 stage 4). ──
  secureHandle('alfred:listNotifications', async (_e, rawFilter: unknown): Promise<AgentNotification[]> => {
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
  secureHandle('alfred:markNotificationSeen', async (_e, id: unknown): Promise<AgentNotification | null> => {
    if (typeof id !== 'string' || !id) return null;
    try {
      return (await core.markNotificationSeen(id)) ?? null;
    } catch (err) {
      fail('mark notification seen', err);
      return null;
    }
  });
  secureHandle('alfred:getHeartbeat', guard('get heartbeat', () => core.getHeartbeat(), { enabled: false, intervalMs: 60_000 }));
  secureHandle('alfred:setHeartbeat', async (_e, patch: unknown): Promise<{ enabled: boolean; intervalMs: number }> => {
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
  secureHandle('alfred:askReference', async (_e, payload: unknown) => {
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
  secureOn('window:hide', () => hideAllWindows());
  secureOn('window:quit', () => app.quit());
  secureOn('window:toggle', () => toggleAllWindows());
  secureOn('overlay:setInteractive', (e, interactive: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    // forward:true keeps move events flowing so the renderer can detect the
    // pointer re-entering a card and flip back to interactive.
    win?.setIgnoreMouseEvents(!interactive, { forward: true });
  });
}
