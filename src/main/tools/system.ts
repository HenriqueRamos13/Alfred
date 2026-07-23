import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from './types.ts';
import { grillMeEnabled } from '../core/settings-pure.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsers (no spawn, strip-types safe → tested in test/logic.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface Battery {
  percent: number | null;
  charging: boolean;
  /** "3:42" hours:minutes, or null when unknown / "(no estimate)" / 0:00. */
  timeRemaining: string | null;
}

/** Parse `pmset -g batt`. Falls back gracefully when fields are missing. */
export function parseBattery(out: string): Battery {
  const pct = out.match(/(\d+)%/);
  // status word after the "NN%; " — discharging | charging | charged | finishing charge | AC attached
  const status = out.match(/\d+%\s*;\s*([^;]+?)\s*;/);
  const s = status ? status[1].trim().toLowerCase() : '';
  const time = out.match(/(\d+:\d{2})\s+remaining/);
  const t = time ? time[1] : null;
  return {
    percent: pct ? Number(pct[1]) : null,
    // discharging is the only "not charging" state; everything else is on power.
    charging: s !== '' && s !== 'discharging',
    timeRemaining: t && t !== '0:00' ? t : null,
  };
}

export interface Volume {
  volume: number | null;
  muted: boolean;
}

/** Parse `osascript -e "get volume settings"` → "output volume:42, ... , output muted:false". */
export function parseVolume(out: string): Volume {
  const v = out.match(/output volume:(\d+)/);
  const m = out.match(/output muted:(true|false)/);
  return { volume: v ? Number(v[1]) : null, muted: m ? m[1] === 'true' : false };
}

/** Parse `brightness -l` → the first "brightness 0.85" float (0..1), or null. */
export function parseBrightness(out: string): number | null {
  const m = out.match(/brightness\s+([0-9]*\.?[0-9]+)/i);
  return m ? Number(m[1]) : null;
}

/** Parse `networksetup -getairportnetwork en0` → SSID, or null when not associated. */
export function parseWifiSsid(out: string): string | null {
  const m = out.match(/Current Wi-Fi Network:\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

/** Parse `networksetup -getairportpower en0` → Wi-Fi radio on/off. */
export function parseWifiPower(out: string): boolean {
  return /:\s*On\b/i.test(out);
}

/** Parse `lsappinfo list` (no TCC) → visible application names, de-duplicated. */
export function parseAppsRunning(out: string): string[] {
  const names = new Set<string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*\d+\)\s+"([^"]+)"/);
    if (m) names.add(m[1]);
  }
  return [...names];
}

/** Parse an osascript comma-separated process list → trimmed names. */
export function parseProcessList(out: string): string[] {
  return out
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface DisplayInfo {
  name: string;
  resolution: string | null;
  main: boolean;
}

/** Parse `system_profiler SPDisplaysDataType -json` → per-monitor info. Defensive: never throws. */
export function parseDisplays(json: string): DisplayInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const gpus = (data as Record<string, unknown>)?.SPDisplaysDataType;
  if (!Array.isArray(gpus)) return [];
  const out: DisplayInfo[] = [];
  for (const gpu of gpus) {
    const screens = (gpu as Record<string, unknown>)?.spdisplays_ndrvs;
    if (!Array.isArray(screens)) continue;
    for (const scr of screens) {
      const s = scr as Record<string, unknown>;
      const resolution =
        (s._spdisplays_resolution as string) ??
        (s.spdisplays_resolution as string) ??
        (s._spdisplays_pixels as string) ??
        null;
      out.push({
        name: String(s._name ?? 'Display'),
        resolution: resolution ? String(resolution) : null,
        main: s.spdisplays_main === 'spdisplays_yes',
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────────────

type Op =
  | 'battery'
  | 'volume_get'
  | 'volume_set'
  | 'brightness_get'
  | 'brightness_set'
  | 'displays'
  | 'wifi'
  | 'apps_running'
  | 'app_frontmost'
  | 'app_open'
  | 'app_quit'
  | 'notify'
  | 'clipboard_read'
  | 'clipboard_write'
  | 'caffeinate'
  | 'lock'
  | 'sleep'
  | 'screenshot'
  | 'window_hide'
  | 'window_show'
  | 'window_toggle'
  | 'grill_me_on'
  | 'grill_me_off'
  | 'grill_me_toggle';

interface Args {
  op: Op;
  /** volume_set (0-100) | brightness_set (0-1). */
  value?: number;
  /** volume_set: mute the output instead of setting a level. */
  mute?: boolean;
  /** app_open/app_quit: application name. app_open also accepts a URL. */
  name?: string;
  /** app_open: a URL/file to open (via `open`). */
  url?: string;
  /** notify: title + body. */
  title?: string;
  body?: string;
  /** clipboard_write: text to place on the clipboard. */
  text?: string;
  /** caffeinate: stop the current keep-awake instead of starting one. */
  stop?: boolean;
  /** caffeinate: auto-expire after N seconds (default: until stopped). */
  seconds?: number;
  /** screenshot: output path (defaults to a timestamped PNG in the workspace). */
  path?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Set when the binary could not be spawned at all (e.g. ENOENT). */
  spawnError?: string;
}

function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string }) | null;
      // Spawn failures surface a string code (ENOENT); process exits surface a number.
      const spawnError = e && typeof e.code === 'string' ? `${e.code}: ${e.message}` : undefined;
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: e && typeof e.code === 'number' ? e.code : e ? 1 : 0,
        spawnError,
      });
    });
  });
}

const osa = (script: string) => run('osascript', ['-e', script]);

/** A TCC (privacy permission) hint if the stderr looks like a denied Apple-events / automation call. */
function tccHint(r: RunResult): string | null {
  const s = `${r.stderr}`.toLowerCase();
  if (/-1743|not authorized|not allowed|assistive access|osascript is not allowed/.test(s)) {
    return 'macOS blocked this: grant Automation (System Settings → Privacy & Security → Automation) to the app running Alfred, then retry.';
  }
  return null;
}

/** Single caffeinate child kept alive across calls (module-scoped, one keep-awake at a time). */
// ponytail: single global caffeinate; a Map keyed by reason only if we ever need concurrent holds.
let caffeinateProc: ChildProcess | null = null;

export const system: Tool<Args> = {
  name: 'system',
  description:
    'See and control the Mac: battery, volume, brightness, displays, Wi-Fi, running apps, ' +
    'notifications, clipboard, keep-awake, screen lock/sleep and screenshots. The `screenshot` op ' +
    'actually SHOWS you the screen — it captures a JPEG and feeds the pixels to you when your ' +
    'active brain has vision (Claude / GPT); use it to see the real screen content. For card/window ' +
    'positions and coordinates use the ui_layout tool op get_layout instead — no screenshot needed. ' +
    'Also hide/show/toggle ' +
    "Alfred's own overlay windows (window_hide/window_show/window_toggle), and toggle the " +
    'GRILL-ME plan-clarity interview when the user asks ("ativa/desativa o grill me": ' +
    'grill_me_on/grill_me_off/grill_me_toggle). One `op` per call. ' +
    'macOS privacy (TCC) permissions some ops may prompt for: ' +
    'app_quit/app_frontmost/apps_running(fallback)/sleep use AppleScript → Automation permission; ' +
    'screenshot uses screencapture → Screen Recording permission. ' +
    'brightness_get/brightness_set need the `brightness` CLI (brew install brightness). ' +
    'When a permission or tool is missing the op returns a clear error, never a crash.',
  inputSchema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: [
          'battery',
          'volume_get',
          'volume_set',
          'brightness_get',
          'brightness_set',
          'displays',
          'wifi',
          'apps_running',
          'app_frontmost',
          'app_open',
          'app_quit',
          'notify',
          'clipboard_read',
          'clipboard_write',
          'caffeinate',
          'lock',
          'sleep',
          'screenshot',
          'window_hide',
          'window_show',
          'window_toggle',
          'grill_me_on',
          'grill_me_off',
          'grill_me_toggle',
        ],
        description: 'Which capability to invoke.',
      },
      value: { type: 'number', description: 'volume_set: 0-100. brightness_set: 0.0-1.0.' },
      mute: { type: 'boolean', description: 'volume_set: mute (true) / unmute (false) instead of setting a level.' },
      name: { type: 'string', description: 'app_open / app_quit: application name (e.g. "Safari").' },
      url: { type: 'string', description: 'app_open: a URL or file path to open instead of an app.' },
      title: { type: 'string', description: 'notify: notification title.' },
      body: { type: 'string', description: 'notify: notification body.' },
      text: { type: 'string', description: 'clipboard_write: text to copy.' },
      stop: { type: 'boolean', description: 'caffeinate: stop the current keep-awake.' },
      seconds: { type: 'number', description: 'caffeinate: auto-expire after N seconds.' },
      path: { type: 'string', description: 'screenshot: output JPEG path (default: timestamped file in the workspace).' },
    },
    required: ['op'],
  },

  risk: (a) => {
    switch (a.op) {
      case 'app_quit':
      case 'lock':
      case 'sleep':
        return 'T2';
      case 'volume_set':
      case 'brightness_set':
      case 'app_open':
      case 'notify':
      case 'clipboard_write':
      case 'caffeinate':
      case 'screenshot':
      case 'window_hide':
      case 'window_show':
      case 'window_toggle':
      case 'grill_me_on':
      case 'grill_me_off':
      case 'grill_me_toggle':
        return 'T1';
      default:
        return 'T0';
    }
  },

  async execute(a, ctx) {
    try {
      switch (a.op) {
        case 'battery': {
          const r = await run('pmset', ['-g', 'batt']);
          if (r.code === 0 && /\d+%/.test(r.stdout)) return { ok: true, result: parseBattery(r.stdout) };
          // fallback: raw IOKit dump (percent only, best-effort)
          const io = await run('ioreg', ['-rn', 'AppleSmartBattery']);
          const cur = io.stdout.match(/"CurrentCapacity"\s*=\s*(\d+)/);
          const max = io.stdout.match(/"MaxCapacity"\s*=\s*(\d+)/);
          const ext = io.stdout.match(/"ExternalConnected"\s*=\s*(Yes|No)/i);
          if (cur && max && Number(max[1]) > 0) {
            return {
              ok: true,
              result: {
                percent: Math.round((Number(cur[1]) / Number(max[1])) * 100),
                charging: !!ext && /yes/i.test(ext[1]),
                timeRemaining: null,
              },
            };
          }
          return { ok: false, error: 'Could not read battery (no battery? desktop Mac?).' };
        }

        case 'volume_get': {
          const r = await osa('get volume settings');
          if (r.code !== 0) return { ok: false, error: tccHint(r) ?? (r.stderr.trim() || 'volume read failed') };
          return { ok: true, result: parseVolume(r.stdout) };
        }

        case 'volume_set': {
          if (typeof a.mute === 'boolean') {
            const r = await osa(`set volume ${a.mute ? 'with' : 'without'} output muted`);
            if (r.code !== 0) return { ok: false, error: tccHint(r) ?? (r.stderr.trim() || 'mute failed') };
            return { ok: true, result: { muted: a.mute } };
          }
          if (typeof a.value !== 'number') return { ok: false, error: 'volume_set needs `value` (0-100) or `mute`.' };
          const v = Math.max(0, Math.min(100, Math.round(a.value)));
          const r = await osa(`set volume output volume ${v}`);
          if (r.code !== 0) return { ok: false, error: tccHint(r) ?? (r.stderr.trim() || 'volume set failed') };
          return { ok: true, result: { volume: v } };
        }

        case 'brightness_get': {
          const r = await run('brightness', ['-l']);
          if (r.spawnError)
            return { ok: false, error: 'The `brightness` CLI is not installed. Run: brew install brightness' };
          const b = parseBrightness(r.stdout);
          if (b === null) return { ok: false, error: r.stderr.trim() || 'could not read brightness' };
          return { ok: true, result: { brightness: b, percent: Math.round(b * 100) } };
        }

        case 'brightness_set': {
          if (typeof a.value !== 'number') return { ok: false, error: 'brightness_set needs `value` (0.0-1.0).' };
          const v = Math.max(0, Math.min(1, a.value));
          const r = await run('brightness', [String(v)]);
          if (r.spawnError)
            return { ok: false, error: 'The `brightness` CLI is not installed. Run: brew install brightness' };
          if (r.code !== 0) return { ok: false, error: r.stderr.trim() || 'brightness set failed' };
          return { ok: true, result: { brightness: v } };
        }

        case 'displays': {
          const r = await run('system_profiler', ['SPDisplaysDataType', '-json']);
          if (r.code !== 0 && !r.stdout) return { ok: false, error: r.stderr.trim() || 'displays read failed' };
          return { ok: true, result: { displays: parseDisplays(r.stdout) } };
        }

        case 'wifi': {
          const ssid = await run('networksetup', ['-getairportnetwork', 'en0']);
          const power = await run('networksetup', ['-getairportpower', 'en0']);
          return {
            ok: true,
            result: {
              ssid: parseWifiSsid(ssid.stdout),
              on: parseWifiPower(power.stdout),
            },
          };
        }

        case 'apps_running': {
          const r = await run('lsappinfo', ['list']);
          const apps = r.code === 0 ? parseAppsRunning(r.stdout) : [];
          if (apps.length > 0) return { ok: true, result: { apps } };
          // fallback via System Events (needs Automation TCC)
          const osaRes = await osa('tell application "System Events" to get name of every process whose background only is false');
          if (osaRes.code !== 0) return { ok: false, error: tccHint(osaRes) ?? (osaRes.stderr.trim() || 'could not list apps') };
          return { ok: true, result: { apps: parseProcessList(osaRes.stdout) } };
        }

        case 'app_frontmost': {
          const r = await osa('tell application "System Events" to get name of first process whose frontmost is true');
          if (r.code !== 0) return { ok: false, error: tccHint(r) ?? (r.stderr.trim() || 'could not read frontmost app') };
          return { ok: true, result: { app: r.stdout.trim() } };
        }

        case 'app_open': {
          const target = a.url ?? a.name;
          if (!target) return { ok: false, error: 'app_open needs `name` or `url`.' };
          const r = a.url ? await run('open', [a.url]) : await run('open', ['-a', a.name as string]);
          if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `could not open ${target}` };
          return { ok: true, result: { opened: target } };
        }

        case 'app_quit': {
          if (!a.name) return { ok: false, error: 'app_quit needs `name`.' };
          const r = await osa(`tell application ${JSON.stringify(a.name)} to quit`);
          if (r.code !== 0) return { ok: false, error: tccHint(r) ?? (r.stderr.trim() || `could not quit ${a.name}`) };
          return { ok: true, result: { quit: a.name } };
        }

        case 'notify': {
          const { Notification } = await import('electron');
          if (!Notification.isSupported()) return { ok: false, error: 'Notifications are not supported on this system.' };
          new Notification({ title: a.title ?? 'Alfred', body: a.body ?? '' }).show();
          return { ok: true, result: { title: a.title ?? 'Alfred', body: a.body ?? '' } };
        }

        case 'clipboard_read': {
          const { clipboard } = await import('electron');
          return { ok: true, result: { text: clipboard.readText() } };
        }

        case 'clipboard_write': {
          if (typeof a.text !== 'string') return { ok: false, error: 'clipboard_write needs `text`.' };
          const { clipboard } = await import('electron');
          clipboard.writeText(a.text);
          return { ok: true, result: { bytes: Buffer.byteLength(a.text) } };
        }

        case 'caffeinate': {
          if (a.stop) {
            if (!caffeinateProc) return { ok: true, result: { caffeinating: false, note: 'nothing to stop' } };
            caffeinateProc.kill();
            caffeinateProc = null;
            return { ok: true, result: { caffeinating: false } };
          }
          if (caffeinateProc) return { ok: true, result: { caffeinating: true, note: 'already awake' } };
          const args = typeof a.seconds === 'number' && a.seconds > 0 ? ['-t', String(Math.round(a.seconds))] : [];
          const child = spawn('caffeinate', args, { detached: false, stdio: 'ignore' });
          child.on('error', () => {
            caffeinateProc = null;
          });
          child.on('exit', () => {
            if (caffeinateProc === child) caffeinateProc = null;
          });
          caffeinateProc = child;
          return { ok: true, result: { caffeinating: true, seconds: a.seconds ?? null } };
        }

        case 'lock': {
          // No TCC: puts the display to sleep (locks when "require password" is set).
          const r = await run('pmset', ['displaysleepnow']);
          if (r.code !== 0) return { ok: false, error: r.stderr.trim() || 'lock failed' };
          return { ok: true, result: { locked: true } };
        }

        case 'sleep': {
          const r = await osa('tell application "System Events" to sleep');
          if (r.code !== 0) return { ok: false, error: tccHint(r) ?? (r.stderr.trim() || 'sleep failed') };
          return { ok: true, result: { sleeping: true } };
        }

        case 'screenshot': {
          const out = a.path
            ? path.isAbsolute(a.path)
              ? a.path
              : path.resolve(ctx.workspace, a.path)
            : path.resolve(ctx.workspace, `screenshot-${Date.now()}.jpg`);
          // JPEG (-t jpg): a Retina PNG is multi-MB and can blow the API's ~5MB
          // per-image limit; JPEG keeps a full-screen grab comfortably under it.
          const r = await run('screencapture', ['-x', '-t', 'jpg', out]);
          if (r.code !== 0)
            return {
              ok: false,
              error:
                r.stderr.trim() ||
                'screencapture failed — grant Screen Recording (System Settings → Privacy & Security → Screen Recording) to the app running Alfred.',
            };
          // Read the pixels back so the orchestrator wrapper can feed them to a
          // vision-capable brain. The textual result stays tiny ({path}); the
          // image rides in a separate `image` field. Degrade to path-only if the
          // read fails or the file is implausibly large (guard against the limit).
          try {
            const bytes = await readFile(out);
            // ponytail: 3.7MB raw cap → base64 (~+33%) stays under the API's ~5MB
            // per-image limit; a full-screen JPEG is normally well under this.
            if (bytes.byteLength <= 3.7 * 1024 * 1024) {
              return {
                ok: true,
                result: { path: out, image: { mediaType: 'image/jpeg', base64: bytes.toString('base64') } },
              };
            }
          } catch {
            // fall through to path-only
          }
          return { ok: true, result: { path: out } };
        }

        case 'window_hide': {
          const { hideAllWindows } = await import('../windows.ts');
          hideAllWindows();
          return { ok: true, result: { visible: false } };
        }

        case 'window_show': {
          const { showAllWindows } = await import('../windows.ts');
          showAllWindows();
          return { ok: true, result: { visible: true } };
        }

        case 'window_toggle': {
          const { toggleAllWindows } = await import('../windows.ts');
          return { ok: true, result: { visible: toggleAllWindows() } };
        }

        // GRILL-ME toggle — let the user turn the plan-clarity interview on/off by
        // voice/chat ("ativa/desativa o grill me"). Persists grill_me_enabled; the
        // topbar reflects it on the next idle. Dynamic db import keeps this module
        // free of a top-level better-sqlite3 dep (it's loaded by the logic tests).
        case 'grill_me_on':
        case 'grill_me_off':
        case 'grill_me_toggle': {
          const { getSetting, setSetting } = await import('../core/db.ts');
          const current = grillMeEnabled(getSetting(ctx.db, 'grill_me_enabled'));
          const next = a.op === 'grill_me_on' ? true : a.op === 'grill_me_off' ? false : !current;
          setSetting(ctx.db, 'grill_me_enabled', next ? '1' : '0');
          return { ok: true, result: { grillMe: next } };
        }

        default:
          return { ok: false, error: `Unknown op: ${(a as Args).op}` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
