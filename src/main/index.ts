/**
 * Alfred main process: create the control window, boot the DB + orchestrator,
 * register IPC. Streaming to the renderer is a single `emit` sink wired to the
 * window's webContents.
 *
 * Window modes (ALFRED_WINDOW_MODE):
 *   overlay  (default) — frameless, transparent, always-on-top HUD covering the
 *                        virtual desktop (all displays). Drag/HIDE/QUIT live in
 *                        the UI top-bar; CommandOrControl+Shift+A or +Shift+H
 *                        toggles visibility.
 *   windowed           — classic bordered window (fallback if the overlay annoys).
 */
import { app, BrowserWindow, globalShortcut, screen } from 'electron';
import { join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { openDb } from './core/db.ts';
import { createOrchestrator } from './core/orchestrator.ts';
import { loadPricingOverrides } from './core/pricing.ts';
import { listBrains, resolveActiveBrainId } from './core/providers.ts';
import { registerIpc, registerWindowIpc, type Orchestrator } from './ipc.ts';
import type { AlfredConfig, StreamEvent } from './core/types.ts';

const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+A';
const TOGGLE_SHORTCUT_H = 'CommandOrControl+Shift+H';

/**
 * Load the `.env` into process.env BEFORE config is read — without this no API
 * key reaches the config and no brain is ever enabled. Node 22's
 * `process.loadEnvFile` is used when present; otherwise a minimal parser runs.
 * Looks in cwd (dev) then the app path (packaged); never throws if absent.
 */
function loadEnv(): void {
  const path = [join(process.cwd(), '.env'), join(app.getAppPath(), '.env')].find(existsSync);
  if (!path) {
    console.warn('[alfred] no .env found (cwd or app path); using the process environment only.');
    return;
  }
  const native = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (native) {
    try {
      native.call(process, path);
      return;
    } catch (err) {
      console.warn(`[alfred] process.loadEnvFile failed for ${path}; using fallback parser.`, err);
    }
  }
  parseEnvInto(readFileSync(path, 'utf8'), process.env);
}

/** Minimal .env parser: skips blanks/comments, splits on first '='; existing env wins. */
function parseEnvInto(text: string, env: NodeJS.ProcessEnv): void {
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    if (!key || key in env) continue; // env already set → it takes priority
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
}

/** One secret-free diagnostic line at boot so the terminal shows what's connected. */
function logBrainStatus(): void {
  const brains = listBrains();
  const enabled = brains.filter((b) => b.enabled).map((b) => b.id);
  // Boot diagnostic uses the env-derived active brain (the persisted choice lives
  // in the DB, which isn't open yet). claude-code counts as answerable.
  const activeId = resolveActiveBrainId(undefined, process.env, brains);
  if (!activeId) {
    console.warn(
      '\n  ================================================================\n' +
        '  ⚠  ALFRED: no brain is connected — Alfred cannot answer.\n' +
        '     Put an API key in .env (ANTHROPIC_API_KEY / OPENAI_API_KEY /\n' +
        '     DEEPSEEK_API_KEY) or install the Claude Code CLI, then restart.\n' +
        '  ================================================================\n',
    );
    return;
  }
  const active = brains.find((b) => b.id === activeId)!;
  console.log(
    `Alfred: brains enabled = [${enabled.join(', ') || 'none'}]; active = ${active.id} (${active.model})`,
  );
}

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

/**
 * The virtual-desktop rectangle: the UNION of every display's bounds. The
 * overlay spans all monitors so a card can be dragged from one to the other.
 * NOTE (macOS): for a single window to cover 2 monitors, "Displays have
 * separate Spaces" must be OFF (System Settings → Desktop & Dock → Mission
 * Control). If it's ON, macOS confines the window to one monitor.
 */
function virtualBounds(): { x: number; y: number; width: number; height: number } {
  const displays = screen.getAllDisplays();
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxR = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxB = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxR - minX, height: maxB - minY };
}

/** Frameless transparent HUD covering ALL displays (virtual desktop), floating on top. */
function createOverlayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...virtualBounds(),
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

  // Re-cover the virtual desktop whenever the display arrangement changes.
  const refit = () => {
    if (!win.isDestroyed()) win.setBounds(virtualBounds());
  };
  screen.on('display-added', refit);
  screen.on('display-removed', refit);
  screen.on('display-metrics-changed', refit);
  win.on('closed', () => {
    screen.removeListener('display-added', refit);
    screen.removeListener('display-removed', refit);
    screen.removeListener('display-metrics-changed', refit);
  });
  return win;
}

function boot(): BrowserWindow {
  loadEnv();
  const config = loadConfig();
  logBrainStatus();
  const data = dataDir();
  loadPricingOverrides(process.env, data);
  const db = openDb(join(data, 'alfred.db'));
  const win = createWindow();

  const emit = (event: StreamEvent): void => {
    if (!win.isDestroyed()) win.webContents.send('alfred:stream', event);
  };

  const core = createOrchestrator({ config, db, emit, dataDir: data }) as Orchestrator;
  registerIpc(core, emit);
  registerWindowIpc(win);

  // Crash-proofing: a stray throw / rejection anywhere must NOT close Alfred.
  // Log (secret-free) + surface to the UI + stay alive. Registered once.
  installProcessGuards(emit);
  return win;
}

let guardsInstalled = false;
function installProcessGuards(emit: (e: StreamEvent) => void): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  const report = (label: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[alfred] ${label}:`, message);
    try {
      emit({ kind: 'error', sessionId: '', message: `${label}: ${message}` });
    } catch {
      /* window gone — nothing we can do, but never rethrow */
    }
  };
  process.on('uncaughtException', (err) => report('uncaught exception (kept alive)', err));
  process.on('unhandledRejection', (reason) => report('unhandled rejection (kept alive)', reason));
}

app.whenReady().then(() => {
  const win = boot();

  // Global toggle so the overlay can always be summoned/dismissed.
  const toggle = () => {
    const w = BrowserWindow.getAllWindows()[0] ?? win;
    if (w.isVisible()) w.hide();
    else {
      w.show();
      w.focus();
    }
  };
  globalShortcut.register(TOGGLE_SHORTCUT, toggle);
  globalShortcut.register(TOGGLE_SHORTCUT_H, toggle);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
