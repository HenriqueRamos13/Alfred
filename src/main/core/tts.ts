/**
 * Text-to-speech — Alfred speaks his replies. Two interchangeable engines,
 * picked with ALFRED_TTS_ENGINE (both share the same queue, epoch and stop()):
 *
 * - 'say' (default, macOS built-in `say`): has pt-BR voices (Luciana, Felipe)
 *   and natural enhanced/premium voices. `say` plays the audio itself — no WAV,
 *   no afplay. Voice via ALFRED_TTS_VOICE (default 'Luciana', pt-BR ♀), rate
 *   (words/min) via ALFRED_TTS_RATE. If the named voice isn't installed and
 *   `say -v` exits non-zero, we retry once WITHOUT -v (system default voice) so
 *   Alfred never goes silent.
 * - 'kokoro': kokoro-js, an ONNX/JS port that runs in Node (no Python), ENGLISH
 *   voices only. Synthesises to a temp WAV and plays it on macOS with `afplay`.
 *   The model is lazy-loaded and cached; the weights download on the FIRST
 *   speak() (or an optional pre-warm — see setup.sh). Voice via ALFRED_TTS_VOICE
 *   (default 'af_heart'); quality/robotic-ness via ALFRED_TTS_DTYPE (default
 *   'fp32' — larger but less robotic than 'q8').
 *
 * - Calls are serialised (a queue) so replies never talk over each other.
 * - stop() kills the current player (afplay OR say) and skips anything still
 *   queued (kill-switch / toggle-off). Errors (download failure, missing
 *   binary) are logged, never thrown — TTS is best-effort and must never crash
 *   a turn.
 *
 * `say -v '?'` lists the voices installed on the Mac. Kokoro voices: see
 * kokoro-js docs (af_heart, af_bella, am_michael/am_puck, bm_george, …).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_KOKORO_VOICE = 'af_heart';
const DEFAULT_SAY_VOICE = 'Luciana'; // pt-BR female

type Dtype = 'q8' | 'q4' | 'fp16' | 'fp32';
const DEFAULT_DTYPE: Dtype = 'fp32';

/** Selected engine — 'say' (default) only works on macOS; 'kokoro' is
 * cross-platform. pt-BR is the default voice, so 'say' is the default engine. */
function getEngine(): 'kokoro' | 'say' {
  return process.env.ALFRED_TTS_ENGINE?.trim() === 'kokoro' ? 'kokoro' : 'say';
}

/** Kokoro precision. Unknown/unset → fp32 (least robotic). */
function getDtype(): Dtype {
  const v = process.env.ALFRED_TTS_DTYPE?.trim();
  return v === 'q8' || v === 'q4' || v === 'fp16' || v === 'fp32' ? v : DEFAULT_DTYPE;
}

// kokoro-js is heavy (pulls @huggingface/transformers + onnxruntime) and only
// loads on first use, so it's imported dynamically inside the lazy init — the
// module stays cheap to import on any platform (incl. the Linux build box).
type KokoroModel = { generate(text: string, opts: { voice: string }): Promise<{ save(path: string): Promise<void> }> };
let modelPromise: Promise<KokoroModel> | null = null;

function getModel(): Promise<KokoroModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { KokoroTTS } = await import('kokoro-js');
      return (await KokoroTTS.from_pretrained(MODEL_ID, { dtype: getDtype() })) as unknown as KokoroModel;
    })().catch((err) => {
      modelPromise = null; // let a later call retry the download
      throw err;
    });
  }
  return modelPromise;
}

// Serialise playback. `epoch` is the cancellation token: stop() bumps it, so any
// task enqueued before the stop bails out instead of playing stale audio.
let queue: Promise<void> = Promise.resolve();
let current: ChildProcess | null = null;
let epoch = 0;

// ── Half-duplex SPEAKING state ──────────────────────────────────────────────
// While Alfred speaks the mic hears his own voice, so the wake path is muted
// (see orchestrator). `speaking` is true from the moment a player starts until
// the queue drains AND a tail elapses — the tail keeps the mute on long enough
// that the final echo isn't captured as a self-command.
let speaking = false;
let currentText = ''; // the utterance currently audible (for wake barge-in detection)
let pending = 0; // enqueued utterances not yet finished
let tailTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let onChange: ((speaking: boolean) => void) | null = null;

/** Tail (ms) the mute lingers after the last player closes. ALFRED_TTS_TAIL_MS, default 700. */
function tailMs(): number {
  const n = Number(process.env.ALFRED_TTS_TAIL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 700;
}

/** Failsafe cap on how long the half-duplex mute may stay on with no audible
 * player. ALFRED_TTS_MAX_SPEAK_MS, default 20s. If `pending` ever desyncs (an
 * unforeseen path that skips the finally), this floor guarantees `speaking`
 * un-sticks so a stuck mute can't deafen the wake listener forever. */
function maxSpeakMs(): number {
  const n = Number(process.env.ALFRED_TTS_MAX_SPEAK_MS);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/** True while Alfred is speaking (incl. the trailing tail). */
export function isSpeaking(): boolean {
  return speaking;
}

/** The text of the utterance currently being spoken, or '' when nothing plays.
 * The orchestrator matches this against the wake words to tell his own-name echo
 * apart from a real user barge-in. */
export function currentSpeechText(): string {
  return speaking ? currentText : '';
}

/** Register the (single) listener notified whenever the speaking state flips. */
export function onSpeaking(cb: (speaking: boolean) => void): void {
  onChange = cb;
}

function setSpeaking(v: boolean): void {
  if (v === speaking) return;
  speaking = v;
  if (!v) currentText = ''; // mute dropped → no utterance is audible anymore
  if (v) armWatchdog();
  else if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  onChange?.(v);
}

/**
 * PURE — the watchdog's decision when its cap elapses:
 *   - not speaking → 'idle' (mute already cleared; nothing to do)
 *   - speaking with a live player → 're-arm' (a genuinely long utterance, legit)
 *   - speaking with NO player → 'unstick' (mute orphaned by a `pending` desync)
 * Split out so the un-stick rule is unit-testable without timers/processes.
 */
export function watchdogAction(isSpeakingNow: boolean, hasPlayer: boolean): 'idle' | 're-arm' | 'unstick' {
  if (!isSpeakingNow) return 'idle';
  return hasPlayer ? 're-arm' : 'unstick';
}

/** Half-duplex watchdog: while the mute is on, periodically check it isn't stuck.
 * If the cap elapses with NO audible player (`current` null) the mute is orphaned
 * (pending desynced) → force it off so the wake listener isn't deafened forever.
 * A genuinely long single utterance keeps `current` set, so we just re-arm. */
function armWatchdog(): void {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    const action = watchdogAction(speaking, current !== null);
    if (action === 'idle') return;
    if (action === 're-arm') return void armWatchdog(); // a player is still audible — legit
    console.error('[alfred] tts watchdog: mute stuck with no active player — forcing unmute (pending reset).');
    pending = 0;
    if (tailTimer) {
      clearTimeout(tailTimer);
      tailTimer = null;
    }
    setSpeaking(false);
  }, maxSpeakMs());
  watchdogTimer.unref?.();
}

/** A player just started → speaking, and cancel any pending end-of-speech tail. */
function beginPlayback(): void {
  if (tailTimer) {
    clearTimeout(tailTimer);
    tailTimer = null;
  }
  setSpeaking(true);
}

/** An utterance finished → if nothing is left queued, drop speaking after the tail. */
function maybeEndPlayback(): void {
  if (pending > 0 || tailTimer) return;
  tailTimer = setTimeout(() => {
    tailTimer = null;
    setSpeaking(false);
  }, tailMs());
}

/** Queue one utterance. Fire-and-forget; failures are logged, never thrown. */
export function speak(text: string): void {
  const clean = text.trim();
  if (!clean) return;
  const myEpoch = epoch;
  pending++;
  queue = queue.then(async () => {
    const live = () => myEpoch === epoch;
    try {
      if (!live()) return;
      await synthAndPlay(clean, live);
    } catch (err) {
      console.error('[alfred] tts speak failed:', err instanceof Error ? err.message : err);
    } finally {
      pending--;
      maybeEndPlayback();
    }
  });
}

/** Cancel current + pending playback (kill-switch / voice toggled off / barge-in). */
export function stop(): void {
  epoch++;
  current?.kill();
  current = null;
  // Deliberate stop → unmute immediately, no tail (draining tasks settle harmlessly).
  if (tailTimer) {
    clearTimeout(tailTimer);
    tailTimer = null;
  }
  setSpeaking(false);
}

/** Optional: trigger the model download ahead of the first speak(). No-op for
 * the 'say' engine (nothing to download). */
export function prewarm(): Promise<unknown> {
  return getEngine() === 'say' ? Promise.resolve() : getModel();
}

async function synthAndPlay(text: string, live: () => boolean): Promise<void> {
  if (getEngine() === 'say') return sayPlay(text, live);

  const model = await getModel();
  if (!live()) return;
  const voice = process.env.ALFRED_TTS_VOICE?.trim() || DEFAULT_KOKORO_VOICE;
  const audio = await model.generate(text, { voice });
  if (!live()) return;
  const wav = join(tmpdir(), `alfred-tts-${randomUUID()}.wav`);
  await audio.save(wav);
  try {
    await runPlayer('afplay', [wav], live, text);
  } finally {
    await unlink(wav).catch(() => {});
  }
}

/** macOS `say` synthesises AND plays in one process — no WAV, no afplay.
 * Defaults to the pt-BR voice Luciana. If that voice isn't installed on the Mac
 * `say -v` exits non-zero — we retry ONCE without -v (system default voice) so
 * Alfred never goes silent. A deliberate stop() shows up as a null exit code
 * (killed), so it doesn't trigger the retry. */
async function sayPlay(text: string, live: () => boolean): Promise<void> {
  const voice = process.env.ALFRED_TTS_VOICE?.trim() || DEFAULT_SAY_VOICE;
  const rate = process.env.ALFRED_TTS_RATE?.trim();
  const rateArgs = rate ? ['-r', rate] : [];
  const code = await runPlayer('say', ['-v', voice, ...rateArgs, text], live, text);
  if (live() && code !== 0 && code !== null) {
    console.warn(`[alfred] tts: voice "${voice}" unavailable (say exit ${code}); retrying with the system default voice`);
    await runPlayer('say', [...rateArgs, text], live, text);
  }
}

/** Spawn a player process, track it as `current` (so stop() can kill it) and
 * resolve with the exit code when it closes. Shared by afplay (kokoro) and say.
 * A null code means killed (stop()) or a spawn/ENOENT failure (missing binary on
 * non-macOS / broken PATH) — logged, not thrown. */
function runPlayer(cmd: string, args: string[], live: () => boolean, text: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!live()) return resolve(null);
    const proc = spawn(cmd, args);
    current = proc;
    currentText = text; // this utterance is now audible (for wake barge-in detection)
    beginPlayback(); // a player is now audible → mute the mic (half-duplex)
    const done = (code: number | null) => {
      if (current === proc) current = null;
      resolve(code);
    };
    proc.on('error', (err) => {
      console.error(`[alfred] ${cmd} failed:`, err instanceof Error ? err.message : err);
      done(null);
    });
    proc.on('close', (code) => done(code));
  });
}
