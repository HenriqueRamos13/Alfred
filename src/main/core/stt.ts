/**
 * Speech-to-text — the user's voice → text. Spawns the native Swift helper
 * (native/alfred-stt) which does on-device recognition with Apple's
 * SFSpeechRecognizer, and relays its line-delimited JSON protocol to the UI as
 * StreamEvents:
 *
 *   {"partial"}  → { kind: 'stt.partial' }   live feedback in the input box
 *   {"final"}    → { kind: 'stt.final' }      settled transcript (fills the input)
 *   {"error"}    → { kind: 'error' }          authorization / setup failure
 *
 * Push-to-talk: startListening() spawns the helper; stopListening() sends SIGINT,
 * which makes the helper flush a {"final"} and exit. The helper also stops on
 * prolonged silence, so a session can end on its own.
 *
 * Mirrors tts.ts: best-effort, failures are logged/surfaced, never thrown.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StreamEvent } from './types.ts';

let proc: ChildProcess | null = null;

/** Locate the compiled helper: dev (cwd/native) or packaged (Resources/native). */
function findBinary(): string | null {
  const rel = join('native', 'alfred-stt');
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const candidates = [join(process.cwd(), rel), resources ? join(resources, rel) : ''];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

/**
 * Start a listening session. No-op if one is already running. Emits stt.partial
 * while speaking and exactly one stt.final when the session ends (so the UI can
 * always reset its mic state, even on a crash).
 */
export function startListening(emit: (e: StreamEvent) => void, sessionId: string): void {
  if (proc) return;

  const bin = findBinary();
  if (!bin) {
    emit({
      kind: 'error',
      sessionId,
      message: 'voice input helper not found — run ./setup.sh to compile it (native/alfred-stt).',
    });
    emit({ kind: 'stt.final', sessionId, text: '' });
    return;
  }

  const locale = process.env.ALFRED_STT_LOCALE?.trim();
  const args = locale ? ['--locale', locale] : [];
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  proc = child;

  let settled = false;
  const finalOnce = (text: string): void => {
    if (settled) return;
    settled = true;
    emit({ kind: 'stt.final', sessionId, text });
  };

  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: { partial?: unknown; final?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.partial === 'string') emit({ kind: 'stt.partial', sessionId, text: msg.partial });
      else if (typeof msg.final === 'string') finalOnce(msg.final);
      else if (typeof msg.error === 'string') emit({ kind: 'error', sessionId, message: `voice input: ${msg.error}` });
    }
  });

  child.stderr.on('data', (d: Buffer) => console.error('[alfred] stt:', d.toString().trim()));

  child.on('error', (err) => {
    console.error('[alfred] stt spawn failed:', err instanceof Error ? err.message : err);
    emit({ kind: 'error', sessionId, message: `voice input failed: ${err instanceof Error ? err.message : err}` });
    if (proc === child) proc = null;
    finalOnce('');
  });

  child.on('close', () => {
    if (proc === child) proc = null;
    finalOnce(''); // helper exited without a final (e.g. error/crash): reset the UI
  });
}

/** Stop the current session; the helper flushes its final transcript then exits. */
export function stopListening(): void {
  proc?.kill('SIGINT');
}
