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
import { app, ipcMain, type BrowserWindow } from 'electron';
import type {
  ApprovalDecision,
  ProjectRecord,
  AccountRecord,
  CardLayout,
  CardPatch,
  ChatMessage,
  CostSnapshot,
  StreamEvent,
} from './core/types.ts';
import type { BrainInfo } from './core/providers.ts';

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
  /** Clear all persisted auto-approve rules. */
  resetApprovals(): void;
  listProjects(): ProjectRecord[] | Promise<ProjectRecord[]>;
  listAccounts(): AccountRecord[] | Promise<AccountRecord[]>;
  /** Brain availability for the UI. */
  listBrains(): BrainInfo[] | Promise<BrainInfo[]>;
  /** Effective active brain id. */
  getActiveBrain(): string | null | Promise<string | null>;
  /** Persist the active brain (enabled only); returns the new effective id. */
  setActiveBrain(id: string): string | null | Promise<string | null>;
  connectGmail(): Promise<AccountRecord | null>;
  /** Full floating-card layout. */
  getLayout(): CardLayout[] | Promise<CardLayout[]>;
  /** Persist a card patch from a user drag/resize; returns the new layout. */
  updateCard(id: string, patch: CardPatch): CardLayout[] | Promise<CardLayout[]>;
  /** Record the live canvas size (renderer) so the AI's ui_layout stays in-bounds. */
  setViewport(w: number, h: number): void;
  /** Today's persisted cost snapshot (read at startup). */
  getCost(): CostSnapshot | Promise<CostSnapshot>;
}

/** Trust boundary: keep only well-formed numeric/boolean fields from the renderer. */
function sanitizeCardPatch(patch: unknown): CardPatch {
  const p = (patch ?? {}) as Record<string, unknown>;
  const out: CardPatch = {};
  for (const k of ['x', 'y', 'w', 'h', 'z'] as const) {
    if (typeof p[k] === 'number' && Number.isFinite(p[k])) out[k] = p[k] as number;
  }
  if (typeof p.visible === 'boolean') out.visible = p.visible;
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

  ipcMain.on('alfred:setViewport', (_e, w: unknown, h: unknown) => {
    if (typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h)) {
      core.setViewport(w, h);
    }
  });

  ipcMain.on('alfred:stop', () => core.stop());
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
  ipcMain.on('alfred:resetApprovals', () => {
    try {
      core.resetApprovals();
    } catch (err) {
      fail('reset approvals', err);
    }
  });
}

/**
 * Window controls for the frameless overlay — without these (and the draggable
 * top-bar in the UI) a frameless always-on-top window would trap the user.
 */
export function registerWindowIpc(win: BrowserWindow): void {
  ipcMain.on('window:hide', () => win.hide());
  ipcMain.on('window:quit', () => app.quit());
  ipcMain.on('window:toggle', () => (win.isVisible() ? win.hide() : win.show()));
}
