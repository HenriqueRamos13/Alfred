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
import { resolveSttLocale } from './language-pure.ts';

let proc: ChildProcess | null = null;

/**
 * Relay a child's line-delimited JSON stdout to `onMessage`, one object per line.
 * Partial lines are buffered across chunks; blank/unparseable lines are skipped.
 * Shared by the STT and wake-word helpers (identical protocol).
 */
export function readJsonLines(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: Record<string, unknown>) => void,
): void {
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* not JSON — skip this line */
      }
    }
  });
}

/** Locate the compiled helper: dev (cwd/native) or packaged (Resources/native). */
export function findSttBinary(): string | null {
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
export function startListening(
  emit: (e: StreamEvent) => void,
  sessionId: string,
  preferredLocale?: string,
): void {
  if (proc) return;

  const bin = findSttBinary();
  if (!bin) {
    emit({
      kind: 'error',
      sessionId,
      message: 'voice input helper not found — run ./setup.sh to compile it (native/alfred-stt).',
    });
    emit({ kind: 'stt.final', sessionId, text: '' });
    return;
  }

  // An explicit language pick (preferredLocale) wins; else ALFRED_STT_LOCALE; else
  // pt-BR. So switching to English in Settings actually transcribes English even
  // when the .env still pins ALFRED_STT_LOCALE=pt-BR.
  const locale = resolveSttLocale(preferredLocale, process.env.ALFRED_STT_LOCALE);
  const args = ['--locale', locale];
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  proc = child;

  let settled = false;
  const finalOnce = (text: string): void => {
    if (settled) return;
    settled = true;
    emit({ kind: 'stt.final', sessionId, text });
  };

  readJsonLines(child.stdout, (msg) => {
    if (typeof msg.partial === 'string') emit({ kind: 'stt.partial', sessionId, text: msg.partial });
    else if (typeof msg.final === 'string') finalOnce(msg.final);
    else if (typeof msg.error === 'string') emit({ kind: 'error', sessionId, message: `voice input: ${msg.error}` });
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

/**
 * Cloud STT: record ONE command to `wavPath` via the helper's `--record` mode
 * (same mic tap as --wake/normal), resolving with the file + its duration when the
 * helper stops on silence (VAD) or SIGINT. The child is tracked as `proc` so a
 * push-to-talk stopListening() / kill switch reaches it too (single mic owner).
 *
 * Rejects when the binary is missing, no audio was captured, or the caller aborts
 * — the orchestrator turns a reject into the local-engine fallback (never crash).
 */
export function recordCommand(
  wavPath: string,
  preferredLocale?: string,
  signal?: AbortSignal,
): Promise<{ path: string; seconds: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('recording aborted'));
    const bin = findSttBinary();
    if (!bin) return reject(new Error('voice input helper not found — run ./setup.sh to compile it (native/alfred-stt).'));

    const locale = resolveSttLocale(preferredLocale, process.env.ALFRED_STT_LOCALE);
    const child = spawn(bin, ['--record', wavPath, '--locale', locale], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc = child;

    const onAbort = (): void => void child.kill('SIGINT');
    signal?.addEventListener('abort', onAbort, { once: true });
    let recorded: { path: string; seconds: number } | null = null;

    readJsonLines(child.stdout, (msg) => {
      if (typeof msg.recorded === 'string') {
        recorded = { path: msg.recorded, seconds: typeof msg.seconds === 'number' ? msg.seconds : 0 };
      }
    });
    child.stderr.on('data', (d: Buffer) => console.error('[alfred] stt record:', d.toString().trim()));

    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    child.on('error', (err) => {
      if (proc === child) proc = null;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    child.on('close', () => {
      if (proc === child) proc = null;
      cleanup();
      if (signal?.aborted) return reject(new Error('recording aborted'));
      if (recorded && recorded.seconds > 0) resolve(recorded);
      else reject(new Error('recording produced no audio'));
    });
  });
}
