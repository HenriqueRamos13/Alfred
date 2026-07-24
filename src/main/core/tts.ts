/**
 * Text-to-speech — Alfred speaks his replies. Three interchangeable engines,
 * picked with ALFRED_TTS_ENGINE / the 11LABS runtime override (all share the same
 * queue, epoch, stop() and half-duplex speaking state):
 *
 * - 'elevenlabs' (runtime toggle, cloud): POST to the ElevenLabs API, play the
 *   returned mp3 with afplay. Needs ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID;
 *   missing/failing → falls back to 'say' (never silent). See elevenPlay.
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
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfigValue } from './settings-pure.ts';
import type { VoiceConfig } from './types.ts';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_KOKORO_VOICE = 'af_heart';
const DEFAULT_SAY_VOICE = 'Luciana'; // pt-BR female
const DEFAULT_ELEVEN_VOICE = 'JTMaHm6sHVI3NZgPaWDz'; // default ElevenLabs voice (voice library)

type Dtype = 'q8' | 'q4' | 'fp16' | 'fp32';
const DEFAULT_DTYPE: Dtype = 'fp32';

type Engine = 'elevenlabs' | 'kokoro' | 'say';

/** Runtime override for the engine, set by the orchestrator from the persisted
 * `elevenlabs_enabled` toggle (tts.ts itself has no DB). When set it wins over
 * ALFRED_TTS_ENGINE; null → the env-configured engine. */
let engineOverride: 'elevenlabs' | null = null;

/** Orchestrator syncs this on boot (from the setting) and on the 11LABS toggle. */
export function setEngineOverride(v: 'elevenlabs' | null): void {
  engineOverride = v;
}

/** Runtime TTS knobs from the settings card (engine/voice/rate/eleven voice id).
 * The orchestrator syncs this on boot and on every card edit (tts.ts has no DB).
 * Each field, when set, overrides the matching ALFRED_TTS_ / ELEVENLABS_VOICE_ID
 * env var; blank/unset → the env value, then the built-in default. */
let voiceCfg: VoiceConfig = {};
export function setVoiceConfig(c: VoiceConfig | undefined): void {
  voiceCfg = c ?? {};
}

/**
 * PURE — decide the engine from the runtime override + ALFRED_TTS_ENGINE.
 * The override ('elevenlabs' when the 11LABS toggle is ON) always wins; else
 * the env picks 'kokoro' or falls back to 'say' (default, pt-BR). Unit-tested.
 */
export function resolveEngine(override: 'elevenlabs' | null, envEngine: string | undefined): Engine {
  if (override === 'elevenlabs') return 'elevenlabs';
  return envEngine?.trim() === 'kokoro' ? 'kokoro' : 'say';
}

/** PURE — the fallback gate: ElevenLabs needs BOTH a key and a voice id (non-blank),
 * otherwise synthAndPlay falls back to `say` so Alfred never goes silent. */
export function elevenlabsConfigured(apiKey: string | undefined, voiceId: string | undefined): boolean {
  return !!apiKey?.trim() && !!voiceId?.trim();
}

/** Selected engine — 'say' (default) only works on macOS; 'kokoro' is
 * cross-platform; 'elevenlabs' is cloud (needs a key+voice_id, else falls back). */
function getEngine(): Engine {
  return resolveEngine(engineOverride, resolveConfigValue(voiceCfg.engine, process.env.ALFRED_TTS_ENGINE, ''));
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

/** Optional: trigger the model download ahead of the first speak(). Only kokoro
 * downloads weights; 'say' and 'elevenlabs' have nothing to pre-warm. */
export function prewarm(): Promise<unknown> {
  return getEngine() === 'kokoro' ? getModel() : Promise.resolve();
}

async function synthAndPlay(text: string, live: () => boolean): Promise<void> {
  const engine = getEngine();
  if (engine === 'say') return sayPlay(text, live);
  if (engine === 'elevenlabs') return elevenPlay(text, live);

  const model = await getModel();
  if (!live()) return;
  // The `voice` field is shared with `say`, so under kokoro it may hold a macOS
  // voice name kokoro doesn't know (e.g. after switching engines). Mirror the say
  // path: retry once with the default kokoro voice so a stale voice never silences
  // Alfred. (kokoro voices are EN-only ids like af_heart — unlike say's names.)
  const voice = resolveConfigValue(voiceCfg.voice, process.env.ALFRED_TTS_VOICE, DEFAULT_KOKORO_VOICE);
  let audio;
  try {
    audio = await model.generate(text, { voice });
  } catch (err) {
    if (voice === DEFAULT_KOKORO_VOICE) throw err; // already the default — nothing to fall back to
    console.warn(
      `[alfred] tts: kokoro voice "${voice}" unavailable — retrying with ${DEFAULT_KOKORO_VOICE}:`,
      err instanceof Error ? err.message : err,
    );
    if (!live()) return;
    audio = await model.generate(text, { voice: DEFAULT_KOKORO_VOICE });
  }
  if (!live()) return;
  const wav = join(tmpdir(), `alfred-tts-${randomUUID()}.wav`);
  await audio.save(wav);
  try {
    await runPlayer('afplay', [wav], live, text);
  } finally {
    await unlink(wav).catch(() => {});
  }
}

/** ElevenLabs cloud TTS: POST the text, get back audio/mpeg, save a temp mp3 and
 * play it with afplay (macOS plays mp3), then delete it — mirrors the kokoro WAV
 * path. FALLBACK: if the key/voice_id is missing OR the request fails (network /
 * HTTP error) we log a warning (never the key) and fall back to `say` so Alfred
 * never goes silent. Uses Node's global fetch. */
async function elevenPlay(text: string, live: () => boolean): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = resolveConfigValue(voiceCfg.elevenVoiceId, process.env.ELEVENLABS_VOICE_ID, DEFAULT_ELEVEN_VOICE);
  if (!elevenlabsConfigured(apiKey, voiceId)) {
    console.warn('[alfred] tts: ElevenLabs on but ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID missing — using `say`');
    return sayPlay(text, live);
  }
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey as string, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!live()) return;
    const mp3 = join(tmpdir(), `alfred-tts-${randomUUID()}.mp3`);
    await writeFile(mp3, buf);
    try {
      await runPlayer('afplay', [mp3], live, text);
    } finally {
      await unlink(mp3).catch(() => {});
    }
  } catch (err) {
    // Never print the key; message only. Fall back to `say` unless we were stopped.
    console.warn('[alfred] tts: ElevenLabs failed — falling back to `say`:', err instanceof Error ? err.message : err);
    if (live()) return sayPlay(text, live);
  }
}

/** macOS `say` synthesises AND plays in one process — no WAV, no afplay.
 * Defaults to the pt-BR voice Luciana. If that voice isn't installed on the Mac
 * `say -v` exits non-zero — we retry ONCE without -v (system default voice) so
 * Alfred never goes silent. A deliberate stop() shows up as a null exit code
 * (killed), so it doesn't trigger the retry. */
async function sayPlay(text: string, live: () => boolean): Promise<void> {
  const voice = resolveConfigValue(voiceCfg.voice, process.env.ALFRED_TTS_VOICE, DEFAULT_SAY_VOICE);
  const rate = resolveConfigValue(voiceCfg.rate, process.env.ALFRED_TTS_RATE, '');
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
