/**
 * Wake word — always-on "Alfred" listener, no account, reusing the same Apple
 * SFSpeechRecognizer helper (native/alfred-stt) in its --wake mode.
 *
 * The helper runs long-lived and speaks the line-delimited JSON protocol:
 *   {"wake":true}   → StreamEvent { kind: 'wake.detected' } (UI: "heard you")
 *   {"final":"..."} → StreamEvent { kind: 'stt.final' }     — routed through the
 *                     SAME path as the mic button: it fills the input, it is NOT
 *                     auto-sent (the user still confirms with Enter).
 *   {"error":"..."} → StreamEvent { kind: 'error' }
 *
 * If the native binary isn't compiled yet, this disables gracefully (a log line,
 * no crash) — the user runs ./setup.sh to enable it.
 *
 * Mic ownership: in wake mode the helper holds the mic continuously. Manual
 * push-to-talk must stopWakeword() first (freeing the mic) and startWakeword()
 * again afterwards — the orchestrator coordinates this so there is never two
 * owners of the microphone.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { StreamEvent } from './types.ts';
import { findSttBinary, readJsonLines } from './stt.ts';

let proc: ChildProcess | null = null;

/** Whether the native STT helper exists (wake needs it — no binary → no wake). */
export function isWakeAvailable(): boolean {
  return findSttBinary() !== null;
}

/**
 * Start the always-on wake listener. No-op if already running or if the native
 * helper isn't compiled (graceful disable). Long-running: it only exits when
 * stopWakeword() (SIGINT) is called or the process crashes.
 */
export function startWakeword(emit: (e: StreamEvent) => void, sessionId: string): void {
  if (proc) return;

  const bin = findSttBinary();
  if (!bin) {
    console.warn('[alfred] wakeword disabled — native STT helper not found (run ./setup.sh to compile it).');
    return;
  }

  const locale = process.env.ALFRED_STT_LOCALE?.trim() || 'pt-BR';
  // ALFRED_WAKEWORD is read from the environment by the helper itself.
  const child = spawn(bin, ['--wake', '--locale', locale], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc = child;

  readJsonLines(child.stdout, (msg) => {
    if (msg.wake === true) emit({ kind: 'wake.detected', sessionId });
    // Route the command through the mic path: fill the input, do not auto-send.
    else if (typeof msg.final === 'string' && msg.final.trim())
      emit({ kind: 'stt.final', sessionId, text: msg.final });
    else if (typeof msg.error === 'string') emit({ kind: 'error', sessionId, message: `wake word: ${msg.error}` });
  });

  child.stderr.on('data', (d: Buffer) => console.error('[alfred] wakeword:', d.toString().trim()));

  child.on('error', (err) => {
    console.error('[alfred] wakeword spawn failed:', err instanceof Error ? err.message : err);
    if (proc === child) proc = null;
  });

  child.on('close', () => {
    if (proc === child) proc = null;
  });
}

/** Stop the wake listener; the helper releases the mic and exits. */
export function stopWakeword(): void {
  proc?.kill('SIGINT');
  proc = null;
}

/** True while the wake listener process is running. */
export function isWakeRunning(): boolean {
  return proc !== null;
}
