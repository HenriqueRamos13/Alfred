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
import { ipcMain } from 'electron';
import type {
  ApprovalDecision,
  ProjectRecord,
  AccountRecord,
} from './core/types.ts';

export interface Orchestrator {
  /** Run one command / chat turn; streams StreamEvents via the injected emit. */
  send(text: string): Promise<void>;
  /** Kill switch — abort the running task. */
  stop(): void;
  /** Resolve a pending HITL approval (unblocks governance.requestApproval). */
  resolveApproval(resolution: { id: string; decision: ApprovalDecision }): void;
  listProjects(): ProjectRecord[] | Promise<ProjectRecord[]>;
  listAccounts(): AccountRecord[] | Promise<AccountRecord[]>;
  connectGmail(): Promise<AccountRecord | null>;
}

export function registerIpc(core: Orchestrator): void {
  ipcMain.handle('alfred:send', (_e, text: unknown) => core.send(String(text ?? '')));
  ipcMain.handle('alfred:listProjects', () => core.listProjects());
  ipcMain.handle('alfred:listAccounts', () => core.listAccounts());
  ipcMain.handle('alfred:connectGmail', () => core.connectGmail());

  ipcMain.on('alfred:stop', () => core.stop());
  ipcMain.on('alfred:resolveApproval', (_e, id: unknown, decision: unknown) => {
    // Trust boundary: only forward well-formed decisions.
    if (typeof id !== 'string') return;
    if (decision !== 'approve' && decision !== 'deny') return;
    core.resolveApproval({ id, decision });
  });
}
