/**
 * DisplayManager — one frameless, transparent, click-through overlay window PER
 * physical display (Übersicht-style). The LayoutStore in the main process stays
 * the single source of truth; each window is a filtered *view* of it (the
 * renderer keeps only the cards whose displayId matches its own display, passed
 * in via `--display-id`).
 *
 * Windows are click-through by default (setIgnoreMouseEvents(true, {forward})),
 * so clicks on empty desktop pass through to whatever is behind. The renderer
 * flips a window interactive (overlay:setInteractive) while the pointer is over
 * a card, and back to click-through when it leaves — see ipc.ts + App.tsx.
 *
 * Electron-dependent glue only; the pure card↔display logic lives in
 * core/layout.ts (cardOnDisplay / resolveCardDisplay) and is unit-tested.
 */
import { BrowserWindow, screen, type Display } from 'electron';
import { join } from 'node:path';
import type { DisplayInfo } from './core/types.ts';

const RENDERER_HTML = join(import.meta.dirname, '../renderer/index.html');
const PRELOAD = join(import.meta.dirname, '../preload/index.mjs');

export interface DisplayHooks {
  /** Dev server URL (ELECTRON_RENDERER_URL) when running under electron-vite. */
  rendererUrl?: string;
  /** A display was unplugged: its window is already destroyed; reassign its cards + rebroadcast. */
  onDisplayRemoved(removedDisplayId: string): void;
}

export class DisplayManager {
  private windows = new Map<number, BrowserWindow>();
  private disposers: Array<() => void> = [];

  constructor(private readonly hooks: DisplayHooks) {}

  /** Create one overlay per current display and wire the screen listeners. Throws if nothing gets created. */
  start(): void {
    for (const d of screen.getAllDisplays()) this.createOverlay(d);
    if (this.windows.size === 0) throw new Error('no overlay windows could be created');

    const onAdded = (_e: unknown, d: Display) => this.createOverlay(d);
    const onRemoved = (_e: unknown, d: Display) => this.destroyOverlay(d);
    const onMetrics = (_e: unknown, d: Display) => {
      const win = this.windows.get(d.id);
      if (win && !win.isDestroyed()) win.setBounds(d.bounds);
    };
    screen.on('display-added', onAdded);
    screen.on('display-removed', onRemoved);
    screen.on('display-metrics-changed', onMetrics);
    this.disposers.push(
      () => screen.removeListener('display-added', onAdded),
      () => screen.removeListener('display-removed', onRemoved),
      () => screen.removeListener('display-metrics-changed', onMetrics),
    );
  }

  /** Live overlay windows (skips any already destroyed). */
  all(): BrowserWindow[] {
    return [...this.windows.values()].filter((w) => !w.isDestroyed());
  }

  /** Displays for the renderer's "move to next monitor" control. */
  list(): DisplayInfo[] {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      label: d.label || `Display ${d.id}`,
      primary: d.id === primaryId,
    }));
  }

  /** Tear down listeners + windows on quit. */
  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.destroy();
    this.windows.clear();
  }

  private createOverlay(d: Display): void {
    if (this.windows.has(d.id)) return;
    const isPrimary = d.id === screen.getPrimaryDisplay().id;
    const win = new BrowserWindow({
      ...d.bounds,
      frame: false,
      transparent: true,
      hasShadow: false,
      roundedCorners: false,
      backgroundColor: '#00000000',
      skipTaskbar: true,
      fullscreenable: false,
      resizable: false,
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        additionalArguments: [`--display-id=${d.id}`, `--primary=${isPrimary ? '1' : '0'}`, '--overlay=1'],
      },
    });

    win.once('ready-to-show', () => win.show());
    // Overlay flags only stick after the page has loaded.
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.setAlwaysOnTop(true, 'floating');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setIgnoreMouseEvents(true, { forward: true }); // click-through until a card is hovered
    });
    win.on('closed', () => this.windows.delete(d.id));

    if (this.hooks.rendererUrl) win.loadURL(this.hooks.rendererUrl);
    else win.loadFile(RENDERER_HTML);

    this.windows.set(d.id, win);
  }

  private destroyOverlay(d: Display): void {
    const win = this.windows.get(d.id);
    if (win && !win.isDestroyed()) win.destroy();
    this.windows.delete(d.id);
    this.hooks.onDisplayRemoved(String(d.id));
  }
}
