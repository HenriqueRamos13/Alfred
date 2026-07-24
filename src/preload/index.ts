/**
 * Preload bridge. contextIsolation ON, nodeIntegration OFF — the renderer only
 * ever sees the frozen `window.alfred` surface below, never Node or ipcRenderer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  StreamEvent,
  ProjectRecord,
  AccountRecord,
  ApprovalDecision,
  CardLayout,
  CardPatch,
  ChatMessage,
  CostSnapshot,
  DisplayInfo,
  Job,
  JobApproval,
  TeamAgentInfo,
  VoiceConfig,
  WakeStatus,
} from '../main/core/types.ts';
import type { BrainInfo } from '../main/core/providers.ts';
import type { FactoryResetInfo } from '../main/core/orchestrator.ts';
import type { ProjectDetail } from '../main/core/projects.ts';
import type { KanbanCard } from '../main/core/kanban-pure.ts';
import type { InboxMessage } from '../main/core/inbox-pure.ts';
import type { InboxFilter, InboxResult } from '../main/core/inbox.ts';
import type { AgentNotification } from '../main/core/notify-pure.ts';
import type { NotificationFilter } from '../main/core/notify.ts';
import type { Graph } from '../main/core/graph.ts';
import type { ReferenceRequest } from '../main/core/reference.ts';
import type { AgentFormSpec, AugmentFlags } from '../main/core/agent-augment-pure.ts';
import type { TeamAgent } from '../main/core/team-pure.ts';
import type {
  AgentId,
  AgentConfig,
  AgentConfigMap,
  CatalogModel,
  ProviderId,
} from '../main/core/modelCatalog.ts';
import { gmailConfigured } from '../main/tools/gmail-config.ts';

/** Read a `--key=value` flag from additionalArguments (per-window: --display-id/--primary/--overlay). */
function arg(key: string): string {
  const prefix = `--${key}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

const api = {
  /** Auto-hide the top strip (command bar + toolbar). Default ON; ALFRED_AUTOHIDE_TOP=0 disables. */
  autoHideTop: process.env.ALFRED_AUTOHIDE_TOP !== '0',
  /** This window's display.id (empty in windowed/single-window mode → renderer shows every card). */
  displayId: arg('display-id'),
  /** True when this window covers the primary display (drives the 'main' sentinel filter). */
  isPrimary: arg('primary') === '1',
  /** True for click-through overlay windows (enables the interactive-on-hover pivot). */
  overlay: arg('overlay') !== '0',
  /** Flip this window interactive (pointer over a card) vs click-through (empty desktop). */
  setInteractive: (on: boolean): void => ipcRenderer.send('overlay:setInteractive', on === true),
  /** Physical displays (for the "move card to next monitor" control). */
  listDisplays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke('alfred:listDisplays'),
  /** Whether Google OAuth is validly configured (not empty/placeholder) — drives the "connect Gmail" hint. */
  gmailConfigured: gmailConfigured(process.env),
  /** Send a user command / chat turn to the orchestrator. */
  send: (text: string): Promise<void> => ipcRenderer.invoke('alfred:send', text),
  /** Load recent persisted chat history to repopulate the conversation on open. */
  getHistory: (limit?: number): Promise<ChatMessage[]> => ipcRenderer.invoke('alfred:getHistory', limit),
  /** Kill switch — abort the running task (latches: suppresses mic/wake). */
  stop: (): void => ipcRenderer.send('alfred:stop'),
  /** Soft cancel — abort the current turn without latching; input stays usable. */
  cancel: (): void => ipcRenderer.send('alfred:cancel'),
  /** Resolve a pending HITL approval. `remember` persists an auto-approve rule for this tool:op. */
  resolveApproval: (id: string, decision: ApprovalDecision, remember?: boolean): void =>
    ipcRenderer.send('alfred:resolveApproval', id, decision, remember === true),
  /** DANGEROUS mode (bypass all approvals) — persisted; read on mount. */
  getDangerousMode: (): Promise<boolean> => ipcRenderer.invoke('alfred:getDangerousMode'),
  setDangerousMode: (on: boolean): Promise<boolean> => ipcRenderer.invoke('alfred:setDangerousMode', on),
  /** SPAWN kill-switch (freeze new fan-out) — persisted; read on mount. Default OFF. */
  getSpawnPaused: (): Promise<boolean> => ipcRenderer.invoke('alfred:getSpawnPaused'),
  setSpawnPaused: (on: boolean): Promise<boolean> => ipcRenderer.invoke('alfred:setSpawnPaused', on),
  /** GRILL-ME (interview to lock the plan before acting) — persisted; read on mount. Default ON. */
  getGrillMe: (): Promise<boolean> => ipcRenderer.invoke('alfred:getGrillMe'),
  setGrillMe: (on: boolean): Promise<boolean> => ipcRenderer.invoke('alfred:setGrillMe', on),
  /** Clear all persisted auto-approve rules. */
  resetApprovals: (): void => ipcRenderer.send('alfred:resetApprovals'),
  /** Reset ONLY the main conversation (chat + claude-code session); keeps memory/projects. */
  resetConversation: (): void => ipcRenderer.send('alfred:resetConversation'),
  /** What a factory reset will erase (paths + counts) — drives the confirmation modal. */
  factoryResetInfo: (): Promise<FactoryResetInfo | null> => ipcRenderer.invoke('alfred:factoryResetInfo'),
  /** Nuke everything Alfred knows; the UI reloads on the factory.reset.done event. */
  factoryReset: (): Promise<void> => ipcRenderer.invoke('alfred:factoryReset'),
  /** Manually run the memory curator (drain inbox → notes, rebuild MOCs/backlinks). */
  runCurator: (): Promise<unknown> => ipcRenderer.invoke('alfred:runCurator'),
  /** Knowledge-graph data (notes + projects + wikilink edges) for the graph card. */
  getGraph: (): Promise<Graph> => ipcRenderer.invoke('alfred:getGraph'),
  /** Read-only markdown of one note (graph card node preview). */
  getNote: (ref: string): Promise<{ title: string; markdown: string } | null> =>
    ipcRenderer.invoke('alfred:getNote', ref),
  /** Reference agent: ask one isolated, read-only question about a note/node. Streams reference.* events. */
  askReference: (payload: ReferenceRequest): Promise<void> => ipcRenderer.invoke('alfred:askReference', payload),
  listProjects: (): Promise<ProjectRecord[]> => ipcRenderer.invoke('alfred:listProjects'),
  /** One project's manifest + file tree by slug (Overview tab). */
  getProject: (slug: string): Promise<ProjectDetail | null> => ipcRenderer.invoke('alfred:getProject', slug),
  /** Every kanban card on a project's board (Board tab; re-fetched on kanban.changed). */
  listCards: (projectSlug: string): Promise<KanbanCard[]> => ipcRenderer.invoke('alfred:listCards', projectSlug),
  /** The user's direct board op (drag/edit/delete) — resolves {ok, error?} (+ card on success). */
  kanban: (op: string, args: Record<string, unknown>): Promise<{ ok: boolean; error?: string; card?: KanbanCard; reasons?: string[] }> =>
    ipcRenderer.invoke('alfred:kanban', op, args),
  // ── Human inbox (Phase 7 stage 3) — async HITL. ──
  /** Speak arbitrary text (the Inbox "▶ Ouvir" button) — fire-and-forget. */
  speakText: (text: string): void => ipcRenderer.send('alfred:speakText', text),
  /** Inbox messages, optionally filtered (newest first); re-fetched on inbox.changed. */
  listInbox: (filter?: InboxFilter): Promise<InboxMessage[]> => ipcRenderer.invoke('alfred:listInbox', filter),
  /** Apply the user's typed answer (accept/edit/respond/reject; reject needs a reason). */
  answerInbox: (id: string, action: string, text?: string): Promise<InboxResult> =>
    ipcRenderer.invoke('alfred:answerInbox', id, action, text),
  /** Mark a message read (drops the unread badge). */
  markInboxRead: (id: string): Promise<InboxMessage | null> => ipcRenderer.invoke('alfred:markInboxRead', id),
  // ── Notifications + heartbeat (Phase 7 stage 4) — self-orchestration wakes. ──
  /** Notifications for the Activity feed, optionally filtered (newest first); re-fetched on notification.changed. */
  listNotifications: (filter?: NotificationFilter): Promise<AgentNotification[]> =>
    ipcRenderer.invoke('alfred:listNotifications', filter),
  /** Mark one notification seen (drops it from the unseen wake queue). */
  markNotificationSeen: (id: string): Promise<AgentNotification | null> =>
    ipcRenderer.invoke('alfred:markNotificationSeen', id),
  /** Heartbeat toggle + sweep interval — persisted; read on mount. Default OFF. */
  getHeartbeat: (): Promise<{ enabled: boolean; intervalMs: number }> => ipcRenderer.invoke('alfred:getHeartbeat'),
  setHeartbeat: (patch: { enabled?: boolean; intervalMs?: number }): Promise<{ enabled: boolean; intervalMs: number }> =>
    ipcRenderer.invoke('alfred:setHeartbeat', patch),
  listAccounts: (): Promise<AccountRecord[]> => ipcRenderer.invoke('alfred:listAccounts'),
  /** Brain availability (enabled/disabled) for the UI. */
  listBrains: (): Promise<BrainInfo[]> => ipcRenderer.invoke('alfred:listBrains'),
  /** Effective active brain id (persisted → env → first enabled). */
  getActiveBrain: (): Promise<string | null> => ipcRenderer.invoke('alfred:getActiveBrain'),
  /** Select the active/main brain (enabled only); resolves with the new effective id. */
  setActiveBrain: (id: string): Promise<string | null> => ipcRenderer.invoke('alfred:setActiveBrain', id),
  /** Per-agent config (main / reference / curator): name + provider + model. */
  getAgentConfig: (): Promise<AgentConfigMap | null> => ipcRenderer.invoke('alfred:getAgentConfig'),
  /** Patch one agent's config; resolves with the full config. */
  setAgentConfig: (id: AgentId, patch: Partial<AgentConfig>): Promise<AgentConfigMap | null> =>
    ipcRenderer.invoke('alfred:setAgentConfig', id, patch),
  /** The hardcoded model catalog per provider (settings-card dropdowns). */
  getModelCatalog: (): Promise<Record<ProviderId, CatalogModel[]>> => ipcRenderer.invoke('alfred:getModelCatalog'),
  /** Launch the Gmail OAuth flow; resolves with the connected account. */
  connectGmail: (): Promise<AccountRecord | null> => ipcRenderer.invoke('alfred:connectGmail'),
  /** Full floating-card layout (seeds defaults on first read). */
  getLayout: (): Promise<CardLayout[]> => ipcRenderer.invoke('alfred:getLayout'),
  /** Persist a card patch from a drag/resize; resolves with the new layout. */
  updateCard: (id: string, patch: CardPatch): Promise<CardLayout[]> =>
    ipcRenderer.invoke('alfred:updateCard', id, patch),
  /** Report the live canvas size so the AI's ui_layout tool knows the bounds. */
  setViewport: (w: number, h: number): void => ipcRenderer.send('alfred:setViewport', w, h),
  /** Today's persisted cost snapshot, read on mount so COST isn't empty at open. */
  getCost: (): Promise<CostSnapshot | null> => ipcRenderer.invoke('alfred:getCost'),
  /** Voice output toggle (Alfred speaks replies) — persisted; read on mount. */
  getTts: (): Promise<boolean> => ipcRenderer.invoke('alfred:getTts'),
  setTts: (on: boolean): Promise<boolean> => ipcRenderer.invoke('alfred:setTts', on),
  /** UI accent (recolours only --acc) — persisted; read on mount. Returns the effective name. */
  getAccent: (): Promise<string> => ipcRenderer.invoke('alfred:getAccent'),
  setAccent: (name: string): Promise<string> => ipcRenderer.invoke('alfred:setAccent', name),
  /** ElevenLabs cloud voice toggle (which voice, orthogonal to VOICE on/off) — persisted; read on mount. */
  getElevenlabs: (): Promise<boolean> => ipcRenderer.invoke('alfred:getElevenlabs'),
  setElevenlabs: (on: boolean): Promise<boolean> => ipcRenderer.invoke('alfred:setElevenlabs', on),
  /** TTS voice knobs (engine/voice/rate/eleven voice id) — persisted; .env is the default. Read on mount. */
  getVoiceConfig: (): Promise<VoiceConfig> => ipcRenderer.invoke('alfred:getVoiceConfig'),
  setVoiceConfig: (patch: VoiceConfig): Promise<VoiceConfig> => ipcRenderer.invoke('alfred:setVoiceConfig', patch),
  /** Auto-send (submit dictation on stt.final) toggle — persisted; read on mount. */
  getAutosend: (): Promise<boolean> => ipcRenderer.invoke('alfred:getAutosend'),
  setAutosend: (on: boolean): Promise<boolean> => ipcRenderer.invoke('alfred:setAutosend', on),
  /** Send-delay / edit window in ms (hold before a message reaches the AI) — persisted; read on mount. Default 2000, 0 = off. */
  getSendDelay: (): Promise<number> => ipcRenderer.invoke('alfred:getSendDelay'),
  setSendDelay: (ms: number): Promise<number> => ipcRenderer.invoke('alfred:setSendDelay', ms),
  /** Widget JS toggle (run tier-2 widget scripts via the sandboxed alfred-widget:// protocol) — persisted; read on mount. Default OFF. */
  getWidgetScripts: (): Promise<boolean> => ipcRenderer.invoke('alfred:getWidgetScripts'),
  setWidgetScripts: (on: boolean): Promise<boolean> => ipcRenderer.invoke('alfred:setWidgetScripts', on),
  /** Voice input (push-to-talk): start/stop the STT helper; transcript arrives via stt.partial/stt.final stream events. */
  startListening: (): void => ipcRenderer.send('alfred:startListening'),
  stopListening: (): void => ipcRenderer.send('alfred:stopListening'),
  /** Wake word ("Alfred", always-on) toggle — persisted; read on mount. */
  getWakeword: (): Promise<boolean> => ipcRenderer.invoke('alfred:getWakeword'),
  setWakeword: (on: boolean): Promise<boolean> => ipcRenderer.invoke('alfred:setWakeword', on),
  /** Live wake-listener state — read on mount so the WAKE button shows why it is (not) hearing you. */
  getWakeStatus: (): Promise<{ status: WakeStatus; reason?: string }> => ipcRenderer.invoke('alfred:getWakeStatus'),
  /** Every persisted scheduled job (management card — stage 3). */
  listJobs: (): Promise<Job[]> => ipcRenderer.invoke('alfred:listJobs'),
  /** Pending sensitive-action approvals for unattended agent jobs (all, or one job). */
  listPendingApprovals: (jobId?: string): Promise<JobApproval[]> =>
    ipcRenderer.invoke('alfred:listPendingApprovals', jobId),
  /** Resolve a queued job approval; approve executes the stored action through normal governance. */
  resolveJobApproval: (id: string, approved: boolean): Promise<JobApproval | null> =>
    ipcRenderer.invoke('alfred:resolveJobApproval', id, approved),
  /** One job by id — refresh a single card after a mutation. */
  getJob: (id: string): Promise<Job | null> => ipcRenderer.invoke('alfred:getJob', id),
  /** Pause a job (disable + disarm) from the "Scheduled Tasks" card. Resolves with the fresh job. */
  pauseJob: (id: string): Promise<Job | null> => ipcRenderer.invoke('alfred:pauseJob', id),
  /** Resume a paused job (re-enable + re-arm). Resolves with the fresh job. */
  resumeJob: (id: string): Promise<Job | null> => ipcRenderer.invoke('alfred:resumeJob', id),
  /** Delete a job (+ its runs/approvals). Resolves true on success. */
  deleteJob: (id: string): Promise<boolean> => ipcRenderer.invoke('alfred:deleteJob', id),
  /** Team roster projection for the TEAM card (role/model, tokens today, studied topics). */
  listTeamAgents: (): Promise<TeamAgentInfo[]> => ipcRenderer.invoke('alfred:listTeamAgents'),
  /** Delete a roster agent (row + index entry). Resolves true when a row was removed. */
  deleteTeamAgent: (id: string): Promise<boolean> => ipcRenderer.invoke('alfred:deleteTeamAgent', id),
  /** Reparent an agent in the org hierarchy (parentId null = top). Refuses cycles / over-depth. */
  setManager: (agentId: string, parentId: string | null): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('alfred:setManager', agentId, parentId),
  /** AI-augment a draft agent form spec (fills flagged/blank fields via a cheap read-only turn; no side effects). */
  augmentAgentSpec: (spec: AgentFormSpec, flags: AugmentFlags): Promise<AgentFormSpec | null> =>
    ipcRenderer.invoke('alfred:augmentAgentSpec', spec, flags),
  /** Create a roster agent from a completed form spec (UI "Criar"); emits team.changed. */
  createTeamAgent: (spec: AgentFormSpec): Promise<{ ok: boolean; error?: string; agent?: TeamAgent }> =>
    ipcRenderer.invoke('alfred:createTeamAgent', spec),
  /** Overlay window controls (frameless HUD). */
  hideWindow: (): void => ipcRenderer.send('window:hide'),
  quitWindow: (): void => ipcRenderer.send('window:quit'),
  toggleWindow: (): void => ipcRenderer.send('window:toggle'),
  /** Subscribe to the main→renderer event stream. Returns an unsubscribe fn. */
  onStream: (cb: (event: StreamEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: StreamEvent) => cb(event);
    ipcRenderer.on('alfred:stream', listener);
    return () => ipcRenderer.removeListener('alfred:stream', listener);
  },
};

contextBridge.exposeInMainWorld('alfred', api);

export type AlfredApi = typeof api;
