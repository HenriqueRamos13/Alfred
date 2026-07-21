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
  StreamEvent,
} from './core/types.ts';
import type { BrainInfo } from './core/providers.ts';

export interface Orchestrator {
  /** Run one command / chat turn; streams StreamEvents via the injected emit. */
  send(text: string): Promise<void>;
  /** Kill switch — abort the running task. */
  stop(): void;
  /** Resolve a pending HITL approval (unblocks governance.requestApproval). */
  resolveApproval(resolution: { id: string; decision: ApprovalDecision }): void;
  listProjects(): ProjectRecord[] | Promise<ProjectRecord[]>;
  listAccounts(): AccountRecord[] | Promise<AccountRecord[]>;
  /** Brain availability for the UI. */
  listBrains(): BrainInfo[] | Promise<BrainInfo[]>;
  connectGmail(): Promise<AccountRecord | null>;
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
  ipcMain.handle('alfred:listProjects', guard('list projects', () => core.listProjects(), [] as ProjectRecord[]));
  ipcMain.handle('alfred:listAccounts', guard('list accounts', () => core.listAccounts(), [] as AccountRecord[]));
  ipcMain.handle('alfred:listBrains', guard('list brains', () => core.listBrains(), [] as BrainInfo[]));
  ipcMain.handle('alfred:connectGmail', guard('connect Gmail', () => core.connectGmail(), null as AccountRecord | null));

  ipcMain.on('alfred:stop', () => core.stop());
  ipcMain.on('alfred:resolveApproval', (_e, id: unknown, decision: unknown) => {
    // Trust boundary: only forward well-formed decisions.
    if (typeof id !== 'string') return;
    if (decision !== 'approve' && decision !== 'deny') return;
    core.resolveApproval({ id, decision });
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
