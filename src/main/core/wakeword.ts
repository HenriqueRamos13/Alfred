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
// A FATAL helper exit (missing locale assets, unsupported locale, auth denied,
// or a crash) puts wake into a "failed" state: startWakeword() becomes a no-op
// so we never respawn-loop and spam. stopWakeword() (user toggling WAKE off, or
// the manual mic path) clears it — that is the explicit re-arm.
let failed = false;
let fastFailCount = 0;

/** How quickly a clean exit counts as a "fast fail", and how many trip `failed`. */
export const WAKE_FAST_FAIL_MS = 3000;
export const WAKE_MAX_FAST_FAILS = 3;

/**
 * Decide, from how a helper process exited, whether wake should stop respawning.
 * Pure so it is unit-testable without spawning anything.
 *   - non-zero / signal exit → FATAL (assets/locale/auth/crash): never respawn.
 *   - clean exit but repeatedly too fast → also stop (something is wrong).
 *   - a clean, long-lived exit resets the fast-fail counter.
 */
export function classifyWakeExit(
  code: number | null,
  elapsedMs: number,
  count: number,
): { failed: boolean; fastFailCount: number } {
  if (code !== 0) return { failed: true, fastFailCount: count };
  if (elapsedMs < WAKE_FAST_FAIL_MS) {
    const n = count + 1;
    return { failed: n >= WAKE_MAX_FAST_FAILS, fastFailCount: n };
  }
  return { failed: false, fastFailCount: 0 };
}

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
  if (proc || failed) return;

  const bin = findSttBinary();
  if (!bin) {
    console.warn('[alfred] wakeword disabled — native STT helper not found (run ./setup.sh to compile it).');
    return;
  }

  const locale = process.env.ALFRED_STT_LOCALE?.trim() || 'pt-BR';
  // ALFRED_WAKEWORD is read from the environment by the helper itself.
  const child = spawn(bin, ['--wake', '--locale', locale], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc = child;
  const startedAt = Date.now();
  let sawError = false; // helper already surfaced a reason → don't double-emit on close

  readJsonLines(child.stdout, (msg) => {
    if (msg.wake === true) emit({ kind: 'wake.detected', sessionId });
    // Route the command through the mic path: fill the input, do not auto-send.
    else if (typeof msg.final === 'string' && msg.final.trim())
      emit({ kind: 'stt.final', sessionId, text: msg.final });
    else if (typeof msg.error === 'string') {
      sawError = true;
      emit({ kind: 'error', sessionId, message: `wake word: ${msg.error}` });
    }
  });

  child.stderr.on('data', (d: Buffer) => console.error('[alfred] wakeword:', d.toString().trim()));

  child.on('error', (err) => {
    console.error('[alfred] wakeword spawn failed:', err instanceof Error ? err.message : err);
    if (proc === child) proc = null;
    // Can't even launch the helper: fatal — don't respawn-loop.
    failed = true;
    if (!sawError)
      emit({ kind: 'error', sessionId, message: `wake word failed to start: ${err instanceof Error ? err.message : err}` });
  });

  child.on('close', (code) => {
    // stopWakeword() nulls/replaces `proc` first, so `proc !== child` marks an
    // intentional stop — never counted as a failure.
    if (proc !== child) return;
    proc = null;
    const next = classifyWakeExit(code, Date.now() - startedAt, fastFailCount);
    fastFailCount = next.fastFailCount;
    if (next.failed) {
      failed = true;
      if (!sawError)
        emit({
          kind: 'error',
          sessionId,
          message: `wake word disabled — voice helper exited (code ${code ?? 'signal'}). Re-enable WAKE in the top bar once fixed.`,
        });
    }
  });
}

/**
 * Stop the wake listener; the helper releases the mic and exits. Also clears the
 * "failed" state — an explicit stop is the re-arm point (toggle WAKE off/on, or
 * the manual-mic path), so a later startWakeword() may run again.
 */
export function stopWakeword(): void {
  proc?.kill('SIGINT');
  proc = null;
  failed = false;
  fastFailCount = 0;
}

/** True while the wake listener process is running. */
export function isWakeRunning(): boolean {
  return proc !== null;
}
