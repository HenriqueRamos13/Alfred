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
// The "failed" state is RECOVERABLE: only a rapid, repeated crash loop (the
// helper dying within WAKE_FAST_FAIL_MS, WAKE_MAX_FAST_FAILS times in a row)
// latches it, making startWakeword() a no-op so we don't respawn-spam. A single
// exit — even non-zero, e.g. a benign asset error is no longer fatal in the
// helper — is not fatal on its own. stopWakeword() (WAKE toggle off, manual mic
// path) and an app restart clear it — the explicit re-arm points.
let failed = false;
let fastFailCount = 0;

/** How quickly an exit counts as a "fast fail", and how many in a row trip `failed`. */
export const WAKE_FAST_FAIL_MS = 3000;
export const WAKE_MAX_FAST_FAILS = 3;

/**
 * Decide, from how a helper process exited, whether wake should stop respawning.
 * Pure so it is unit-testable without spawning anything. The exit CODE is
 * intentionally ignored: the helper no longer exits non-zero for benign/recover-
 * able reasons (asset errors, transients), so only crash CADENCE matters.
 *   - any exit after living long enough (>= WAKE_FAST_FAIL_MS) → reset, stay armed.
 *   - a fast exit repeated WAKE_MAX_FAST_FAILS times in a row → stop (real crash loop).
 */
export function classifyWakeExit(
  _code: number | null,
  elapsedMs: number,
  count: number,
): { failed: boolean; fastFailCount: number } {
  if (elapsedMs >= WAKE_FAST_FAIL_MS) return { failed: false, fastFailCount: 0 };
  const n = count + 1;
  return { failed: n >= WAKE_MAX_FAST_FAILS, fastFailCount: n };
}

/** Whether the native STT helper exists (wake needs it — no binary → no wake). */
export function isWakeAvailable(): boolean {
  return findSttBinary() !== null;
}

/**
 * Map one line of the helper's JSON protocol to the StreamEvent it should emit,
 * or null to ignore it. Pure so the wake→command routing is unit-testable.
 *   {"wake":true}    → wake.detected  (UI: enter the "listening" state)
 *   {"partial":"…"}  → stt.partial    (live command-forming feedback)
 *   {"final":"…"}    → stt.final      — the SAME path as the mic button: it fills
 *                      the input, not auto-sent. Emitted even when empty (a wake
 *                      with no command) so the UI always leaves "listening".
 *   {"error":"…"}    → error
 */
export function wakeStreamEvent(msg: Record<string, unknown>, sessionId: string): StreamEvent | null {
  if (msg.wake === true) return { kind: 'wake.detected', sessionId };
  if (typeof msg.partial === 'string') return { kind: 'stt.partial', sessionId, text: msg.partial };
  if (typeof msg.final === 'string') return { kind: 'stt.final', sessionId, text: msg.final };
  if (typeof msg.error === 'string') return { kind: 'error', sessionId, message: `wake word: ${msg.error}` };
  return null;
}

/**
 * A voice command's intent, parsed from a wake command transcript. `hide`/`show`
 * act on Alfred's windows; `send` submits (with the trailing text, or the current
 * input when empty); `dictate` is the default — fill the input, user confirms.
 */
export type VoiceIntent = { kind: 'hide' | 'show' | 'send' | 'dictate'; text?: string };

// Leading keyword → action (pt + en). hide/show discard any trailing text;
// send/dictate keep it.
const HIDE_WORDS = ['esconder', 'esconde', 'ocultar', 'oculta', 'hide'];
const SHOW_WORDS = ['aparecer', 'aparece', 'mostrar', 'mostra', 'voltar', 'volta', 'show'];
const SEND_WORDS = ['enviar', 'envia', 'mandar', 'manda', 'send', 'submit'];

/** Lowercase + strip diacritics so "Envia"/"envía"/"ENVIAR" all match. */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * PURE — classify a wake command transcript by its FIRST word (case- and
 * accent-insensitive, pt + en). `send`/`dictate` carry the remaining text:
 *   "esconde" → hide · "mostra de novo" → show
 *   "enviar olá joão" → send "olá joão" · "enviar" → send "" (submit current input)
 *   "abre o safari" → dictate "abre o safari" (fill the input, user confirms)
 */
export function parseVoiceIntent(command: string): VoiceIntent {
  const raw = command.trim();
  if (!raw) return { kind: 'dictate', text: '' };
  const m = raw.match(/^(\S+)(?:\s+([\s\S]*))?$/)!;
  const first = norm(m[1]).replace(/[.,!?;:]+$/, ''); // drop trailing punctuation on the keyword
  const rest = (m[2] ?? '').trim();
  if (HIDE_WORDS.includes(first)) return { kind: 'hide' };
  if (SHOW_WORDS.includes(first)) return { kind: 'show' };
  if (SEND_WORDS.includes(first)) return { kind: 'send', text: rest };
  return { kind: 'dictate', text: raw };
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
    const ev = wakeStreamEvent(msg, sessionId);
    if (!ev) return;
    // Helper already surfaced a reason → don't double-emit on close.
    if (ev.kind === 'error') sawError = true;
    emit(ev);
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
