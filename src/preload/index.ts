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
} from '../main/core/types.ts';
import type { BrainInfo } from '../main/core/providers.ts';

const api = {
  /** Auto-hide the top strip (command bar + toolbar). Default ON; ALFRED_AUTOHIDE_TOP=0 disables. */
  autoHideTop: process.env.ALFRED_AUTOHIDE_TOP !== '0',
  /** Send a user command / chat turn to the orchestrator. */
  send: (text: string): Promise<void> => ipcRenderer.invoke('alfred:send', text),
  /** Kill switch — abort the running task. */
  stop: (): void => ipcRenderer.send('alfred:stop'),
  /** Resolve a pending HITL approval. */
  resolveApproval: (id: string, decision: ApprovalDecision): void =>
    ipcRenderer.send('alfred:resolveApproval', id, decision),
  listProjects: (): Promise<ProjectRecord[]> => ipcRenderer.invoke('alfred:listProjects'),
  listAccounts: (): Promise<AccountRecord[]> => ipcRenderer.invoke('alfred:listAccounts'),
  /** Brain availability (enabled/disabled) for the UI. */
  listBrains: (): Promise<BrainInfo[]> => ipcRenderer.invoke('alfred:listBrains'),
  /** Effective active brain id (persisted → env → first enabled). */
  getActiveBrain: (): Promise<string | null> => ipcRenderer.invoke('alfred:getActiveBrain'),
  /** Select the active/main brain (enabled only); resolves with the new effective id. */
  setActiveBrain: (id: string): Promise<string | null> => ipcRenderer.invoke('alfred:setActiveBrain', id),
  /** Launch the Gmail OAuth flow; resolves with the connected account. */
  connectGmail: (): Promise<AccountRecord | null> => ipcRenderer.invoke('alfred:connectGmail'),
  /** Full floating-card layout (seeds defaults on first read). */
  getLayout: (): Promise<CardLayout[]> => ipcRenderer.invoke('alfred:getLayout'),
  /** Persist a card patch from a drag/resize; resolves with the new layout. */
  updateCard: (id: string, patch: CardPatch): Promise<CardLayout[]> =>
    ipcRenderer.invoke('alfred:updateCard', id, patch),
  /** Report the live canvas size so the AI's ui_layout tool knows the bounds. */
  setViewport: (w: number, h: number): void => ipcRenderer.send('alfred:setViewport', w, h),
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
