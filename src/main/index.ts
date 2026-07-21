/**
 * Alfred main process: create the control window, boot the DB + orchestrator,
 * register IPC. Streaming to the renderer is a single `emit` sink wired to the
 * window's webContents.
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { openDb } from './core/db.ts';
import { createOrchestrator } from './core/orchestrator.ts';
import { registerIpc, type Orchestrator } from './ipc.ts';
import type { AlfredConfig, StreamEvent } from './core/types.ts';

function loadConfig(): AlfredConfig {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ALFRED_MODEL || 'claude-sonnet-5',
    workspace: process.env.ALFRED_WORKSPACE || join(homedir(), 'AlfredWorkspace'),
    dailyTokenBudget: Number(process.env.ALFRED_DAILY_TOKEN_BUDGET) || 2_000_000,
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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#04060c',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) win.loadURL(url);
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'));

  return win;
}

function boot(): void {
  const config = loadConfig();
  const data = dataDir();
  const db = openDb(join(data, 'alfred.db'));
  const win = createWindow();

  const emit = (event: StreamEvent): void => {
    if (!win.isDestroyed()) win.webContents.send('alfred:stream', event);
  };

  const core = createOrchestrator({ config, db, emit, dataDir: data }) as Orchestrator;
  registerIpc(core);
}

app.whenReady().then(() => {
  boot();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
