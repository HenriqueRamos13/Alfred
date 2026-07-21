/**
 * Alfred main process: create the control window, boot the DB + orchestrator,
 * register IPC. Streaming to the renderer is a single `emit` sink wired to the
 * window's webContents.
 *
 * Window modes (ALFRED_WINDOW_MODE):
 *   overlay  (default) — frameless, transparent, always-on-top HUD covering the
 *                        primary display. Drag/HIDE/QUIT live in the UI top-bar;
 *                        CommandOrControl+Shift+A toggles visibility.
 *   windowed           — classic bordered window (fallback if the overlay annoys).
 */
import { app, BrowserWindow, globalShortcut, screen } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { openDb } from './core/db.ts';
import { createOrchestrator } from './core/orchestrator.ts';
import { loadPricingOverrides } from './core/pricing.ts';
import { registerIpc, registerWindowIpc, type Orchestrator } from './ipc.ts';
import type { AlfredConfig, StreamEvent } from './core/types.ts';

const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+A';

function windowMode(): 'overlay' | 'windowed' {
  return (process.env.ALFRED_WINDOW_MODE || 'overlay').trim().toLowerCase() === 'windowed'
    ? 'windowed'
    : 'overlay';
}

function loadConfig(): AlfredConfig {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    provider: process.env.ALFRED_PROVIDER || 'anthropic',
    model: process.env.ANTHROPIC_MODEL || process.env.ALFRED_MODEL || 'claude-sonnet-5',
    workspace: process.env.ALFRED_WORKSPACE || join(homedir(), 'AlfredWorkspace'),
    dailyTokenBudget: Number(process.env.ALFRED_DAILY_TOKEN_BUDGET) || 2_000_000,
    dailyUsdBudget: process.env.ALFRED_DAILY_USD_BUDGET
      ? Number(process.env.ALFRED_DAILY_USD_BUDGET) || undefined
      : undefined,
    stepCap: Number(process.env.ALFRED_STEP_CAP) || 40,
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  };
}

// ponytail: dev keeps the DB in ./data (per spec, gitignored); packaged builds
// can't write inside the asar, so fall back to userData there.
function dataDir(): string {
  const dir = app.isPackaged ? join(app.getPath('userData'), 'data') : join(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const webPreferences = {
  preload: join(import.meta.dirname, '../preload/index.mjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
} as const;

function createWindow(): BrowserWindow {
  const overlay = windowMode() === 'overlay';

  const win = overlay ? createOverlayWindow() : createWindowedWindow();

  win.once('ready-to-show', () => win.show());

  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) win.loadURL(url);
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'));

  return win;
}

/** Classic bordered window (fallback). */
function createWindowedWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#04060c',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences,
  });
}

/** Frameless transparent HUD covering the primary display, floating on top. */
function createOverlayWindow(): BrowserWindow {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    hasShadow: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    resizable: false,
    show: false,
    webPreferences,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return win;
}

function boot(): BrowserWindow {
  const config = loadConfig();
  const data = dataDir();
  loadPricingOverrides(process.env, data);
  const db = openDb(join(data, 'alfred.db'));
  const win = createWindow();

  const emit = (event: StreamEvent): void => {
    if (!win.isDestroyed()) win.webContents.send('alfred:stream', event);
  };

  const core = createOrchestrator({ config, db, emit, dataDir: data }) as Orchestrator;
  registerIpc(core);
  registerWindowIpc(win);
  return win;
}

app.whenReady().then(() => {
  const win = boot();

  // Global toggle so the overlay can always be summoned/dismissed.
  globalShortcut.register(TOGGLE_SHORTCUT, () => {
    const w = BrowserWindow.getAllWindows()[0] ?? win;
    if (w.isVisible()) w.hide();
    else {
      w.show();
      w.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
