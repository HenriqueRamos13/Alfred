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
} from '../main/core/types.ts';

const api = {
  /** Send a user command / chat turn to the orchestrator. */
  send: (text: string): Promise<void> => ipcRenderer.invoke('alfred:send', text),
  /** Kill switch — abort the running task. */
  stop: (): void => ipcRenderer.send('alfred:stop'),
  /** Resolve a pending HITL approval. */
  resolveApproval: (id: string, decision: ApprovalDecision): void =>
    ipcRenderer.send('alfred:resolveApproval', id, decision),
  listProjects: (): Promise<ProjectRecord[]> => ipcRenderer.invoke('alfred:listProjects'),
  listAccounts: (): Promise<AccountRecord[]> => ipcRenderer.invoke('alfred:listAccounts'),
  /** Launch the Gmail OAuth flow; resolves with the connected account. */
  connectGmail: (): Promise<AccountRecord | null> => ipcRenderer.invoke('alfred:connectGmail'),
  /** Subscribe to the main→renderer event stream. Returns an unsubscribe fn. */
  onStream: (cb: (event: StreamEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: StreamEvent) => cb(event);
    ipcRenderer.on('alfred:stream', listener);
    return () => ipcRenderer.removeListener('alfred:stream', listener);
  },
};

contextBridge.exposeInMainWorld('alfred', api);

export type AlfredApi = typeof api;
