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
import type { StreamEvent, WakeStatus } from './types.ts';
import { findSttBinary, readJsonLines } from './stt.ts';

let proc: ChildProcess | null = null;
// A crash no longer LATCHES the listener off. Any unintentional exit schedules a
// single self re-arm after a backoff (see wakeBackoffMs); a rapid, repeated
// crash loop (WAKE_MAX_FAST_FAILS fast exits in a row) just widens the backoff
// and raises an alert — it never needs a manual toggle to come back.
let fastFailCount = 0;
let rearmTimer: ReturnType<typeof setTimeout> | null = null;
// Last emit/session so the auto re-arm timer can respawn on its own.
let emitFn: ((e: StreamEvent) => void) | null = null;
let sessionRef = '';

/** How quickly an exit counts as a "fast fail", and how many in a row are a crash loop. */
export const WAKE_FAST_FAIL_MS = 3000;
export const WAKE_MAX_FAST_FAILS = 3;

/** Auto-re-arm backoff after a failure: 30s doubling to a 5min ceiling. */
export const WAKE_BACKOFF_BASE_MS = 30_000;
export const WAKE_BACKOFF_MAX_MS = 300_000;

/**
 * PURE — backoff before the failed listener auto-re-arms itself, from the number
 * of consecutive fast failures: 30s, 60s, 120s, 240s, capped at 5min. A transient
 * (single) exit resets the counter so it recovers at the base 30s; a genuine
 * crash loop keeps widening the gap instead of spinning.
 */
export function wakeBackoffMs(fastFails: number): number {
  const n = Math.max(1, fastFails);
  return Math.min(WAKE_BACKOFF_BASE_MS * 2 ** (n - 1), WAKE_BACKOFF_MAX_MS);
}

// ── Explicit, VISIBLE state ──────────────────────────────────────────────────
// The user can't hear why the mic is deaf, so the state is surfaced (wake.status).
let state: { status: WakeStatus; reason?: string } = { status: 'stopped' };

/** Current wake state (read on the UI's mount so the button isn't blind at boot). */
export function getWakeState(): { status: WakeStatus; reason?: string } {
  return state;
}

/** Set + emit the wake state, but only when it actually changed (no event spam). */
function setStatus(status: WakeStatus, reason?: string): void {
  if (state.status === status && state.reason === reason) return;
  state = reason === undefined ? { status } : { status, reason };
  emitFn?.({ kind: 'wake.status', sessionId: sessionRef, status, reason });
}

/**
 * PURE — the half-duplex mute reflected on the status machine. While Alfred
 * speaks the wake path is muted (see orchestrator), so listening⇄suppressed; any
 * other state (failed/stopped/disabled) is untouched by his own voice.
 */
export function applySpeaking(status: WakeStatus, speaking: boolean): WakeStatus {
  if (speaking && status === 'listening') return 'suppressed';
  if (!speaking && status === 'suppressed') return 'listening';
  return status;
}

/** Reflect the TTS half-duplex mute in the wake state (listening⇄suppressed). */
export function noteSpeaking(speaking: boolean): void {
  const next = applySpeaking(state.status, speaking);
  if (next !== state.status) setStatus(next);
}

/** Enter the failed state with a reason and schedule ONE backoff re-arm. */
function enterFailed(baseReason: string): void {
  const delay = wakeBackoffMs(fastFailCount);
  setStatus('failed', `${baseReason} — retrying in ${Math.round(delay / 1000)}s`);
  if (rearmTimer) return; // a re-arm is already pending
  rearmTimer = setTimeout(() => {
    rearmTimer = null;
    if (emitFn) startWakeword(emitFn, sessionRef);
  }, delay);
  rearmTimer.unref?.(); // a pending retry must never keep the process alive
}

/**
 * Decide, from how a helper process exited, whether this is a genuine crash loop
 * (which widens the re-arm backoff and raises an alert) vs a transient exit. Pure
 * so it is unit-testable without spawning anything. The exit CODE is intentionally
 * ignored: the helper no longer exits non-zero for benign/recoverable reasons
 * (asset errors, transients), so only crash CADENCE matters.
 *   - any exit after living long enough (>= WAKE_FAST_FAIL_MS) → reset the counter.
 *   - a fast exit repeated WAKE_MAX_FAST_FAILS times in a row → flagged a crash loop.
 * Either way the caller auto-re-arms; `failed` only tunes backoff + alerting.
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
 * PURE — half-duplex gate. While Alfred is speaking (incl. the TTS tail, which
 * `speaking` already encodes) the mic hears his own voice, so DROP the wake-path
 * events that carry that captured audio — wake.detected, stt.partial, stt.final —
 * so he never self-activates or transcribes himself. Everything else (errors)
 * passes through.
 */
export function suppressWhileSpeaking(ev: StreamEvent, speaking: boolean): boolean {
  if (!speaking) return false;
  return ev.kind === 'wake.detected' || ev.kind === 'stt.partial' || ev.kind === 'stt.final';
}

/**
 * The wake words the helper listens for — mirrors native/alfred-stt.swift's
 * resolveWakeWords so main can decide barge-in without duplicating the list:
 * ALFRED_WAKEWORD (default "alfred"), plus the common ASR mishearing "alfredo"
 * when the default is in use. Single source in TS; pass `env` to keep it pure.
 */
export function resolveWakeWords(env: Record<string, string | undefined> = process.env): string[] {
  const base = (env.ALFRED_WAKEWORD ?? 'alfred').toLowerCase().trim() || 'alfred';
  return base === 'alfred' ? [base, 'alfredo'] : [base];
}

/**
 * PURE — does `text` contain any wake word? Normalised the same way as the STT
 * (lowercase, diacritics stripped) so "Álfred"/"ALFRED" match. Empty text (nothing
 * playing) or empty wake words → false.
 */
export function speechContainsWake(text: string, wakeWords: string[]): boolean {
  const hay = norm(text);
  return wakeWords.some((w) => w !== '' && hay.includes(norm(w)));
}

/**
 * PURE — barge-in decision. While Alfred speaks, a wake detection is EITHER the
 * user cutting in OR the echo of Alfred saying his own name. If the line he is
 * speaking NOW does not itself contain the wake word (`currentSpeechHasWake`
 * false), the detection is the user → barge-in (stop him). If it does, it is his
 * own voice → not a barge-in (never self-interrupt his greeting). Only the
 * `wake.detected` event triggers this; partials/finals stay under the anti-echo
 * suppression (suppressWhileSpeaking).
 */
export function shouldBargeIn(ev: StreamEvent, isSpeaking: boolean, currentSpeechHasWake: boolean): boolean {
  return isSpeaking && ev.kind === 'wake.detected' && !currentSpeechHasWake;
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
 * Start the always-on wake listener. No-op if already running; if the native
 * helper isn't compiled it goes to the 'disabled' state (graceful). Long-running:
 * it only exits when stopWakeword() (SIGINT) is called or the process crashes —
 * and a crash now auto-re-arms after a backoff instead of latching off.
 */
export function startWakeword(emit: (e: StreamEvent) => void, sessionId: string): void {
  // Remember the sink so the auto re-arm timer (and status emits) can reach the UI.
  emitFn = emit;
  sessionRef = sessionId;
  // A manual/auto start supersedes any pending backoff re-arm.
  if (rearmTimer) {
    clearTimeout(rearmTimer);
    rearmTimer = null;
  }
  if (proc) return;

  const bin = findSttBinary();
  if (!bin) {
    console.warn('[alfred] wakeword disabled — native STT helper not found (run ./setup.sh to compile it).');
    setStatus('disabled', 'native STT helper not found — run ./setup.sh to compile it');
    return;
  }

  const locale = process.env.ALFRED_STT_LOCALE?.trim() || 'pt-BR';
  // ALFRED_WAKEWORD is read from the environment by the helper itself.
  const child = spawn(bin, ['--wake', '--locale', locale], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc = child;
  setStatus('listening');
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[alfred] wakeword spawn failed:', msg);
    if (proc === child) proc = null; // makes the close handler treat this as handled
    fastFailCount += 1; // a launch failure counts toward the backoff escalation
    enterFailed(`failed to start: ${msg}`);
    if (!sawError) emit({ kind: 'error', sessionId, message: `wake word failed to start: ${msg}` });
  });

  child.on('close', (code) => {
    // stopWakeword() nulls/replaces `proc` first (and the error handler nulls it
    // on a spawn failure), so `proc !== child` marks an already-handled exit —
    // never counted twice.
    if (proc !== child) return;
    proc = null;
    const next = classifyWakeExit(code, Date.now() - startedAt, fastFailCount);
    fastFailCount = next.fastFailCount;
    // Auto-re-arm on ANY unintentional exit (transient → base backoff; a repeated
    // fast-crash loop → widening backoff), so the listener heals without a toggle.
    enterFailed(`voice helper exited (code ${code ?? 'signal'})`);
    // Only alert on a genuine crash loop; a one-off transient recovers quietly.
    if (next.failed && !sawError)
      emit({
        kind: 'error',
        sessionId,
        message: `wake word crashing repeatedly (code ${code ?? 'signal'}) — still auto-retrying with backoff.`,
      });
  });
}

/**
 * Stop the wake listener; the helper releases the mic and exits. Cancels any
 * pending auto re-arm and resets the backoff — an explicit stop (WAKE toggle off,
 * manual-mic path, kill switch) is a clean re-arm point, so a later
 * startWakeword() runs immediately.
 */
export function stopWakeword(): void {
  proc?.kill('SIGINT');
  proc = null;
  fastFailCount = 0;
  if (rearmTimer) {
    clearTimeout(rearmTimer);
    rearmTimer = null;
  }
  setStatus('stopped');
}

/** True while the wake listener process is running. */
export function isWakeRunning(): boolean {
  return proc !== null;
}
