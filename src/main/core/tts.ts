/**
 * Text-to-speech — Alfred speaks his replies. Two interchangeable engines,
 * picked with ALFRED_TTS_ENGINE (both share the same queue, epoch and stop()):
 *
 * - 'kokoro' (default): kokoro-js, an ONNX/JS port that runs in Node (no
 *   Python), ENGLISH voices only. Synthesises to a temp WAV and plays it on
 *   macOS with `afplay`. The model is lazy-loaded and cached; the weights
 *   download on the FIRST speak() (or an optional pre-warm — see setup.sh).
 *   Voice via ALFRED_TTS_VOICE (default 'af_heart'); quality/robotic-ness via
 *   ALFRED_TTS_DTYPE (default 'fp32' — larger but less robotic than 'q8').
 * - 'say' (macOS built-in `say`): has pt-BR voices (Luciana, Felipe) and
 *   natural enhanced/premium voices. `say` plays the audio itself — no WAV, no
 *   afplay. Voice via ALFRED_TTS_VOICE, rate (words/min) via ALFRED_TTS_RATE;
 *   an unknown voice silently falls back to the system default.
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
const DEFAULT_VOICE = 'af_heart';

type Dtype = 'q8' | 'q4' | 'fp16' | 'fp32';
const DEFAULT_DTYPE: Dtype = 'fp32';

/** Selected engine — 'say' only works on macOS; 'kokoro' is cross-platform. */
function getEngine(): 'kokoro' | 'say' {
  return process.env.ALFRED_TTS_ENGINE?.trim() === 'say' ? 'say' : 'kokoro';
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

/** Queue one utterance. Fire-and-forget; failures are logged, never thrown. */
export function speak(text: string): void {
  const clean = text.trim();
  if (!clean) return;
  const myEpoch = epoch;
  queue = queue.then(async () => {
    const live = () => myEpoch === epoch;
    if (!live()) return;
    try {
      await synthAndPlay(clean, live);
    } catch (err) {
      console.error('[alfred] tts speak failed:', err instanceof Error ? err.message : err);
    }
  });
}

/** Cancel current + pending playback (kill-switch / voice toggled off). */
export function stop(): void {
  epoch++;
  current?.kill();
  current = null;
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
  const voice = process.env.ALFRED_TTS_VOICE?.trim() || DEFAULT_VOICE;
  const audio = await model.generate(text, { voice });
  if (!live()) return;
  const wav = join(tmpdir(), `alfred-tts-${randomUUID()}.wav`);
  await audio.save(wav);
  try {
    await runPlayer('afplay', [wav], live);
  } finally {
    await unlink(wav).catch(() => {});
  }
}

/** macOS `say` synthesises AND plays in one process — no WAV, no afplay. An
 * unknown ALFRED_TTS_VOICE makes `say` fall back to the system default, never
 * error, so we pass -v as-is. */
function sayPlay(text: string, live: () => boolean): Promise<void> {
  const voice = process.env.ALFRED_TTS_VOICE?.trim();
  const rate = process.env.ALFRED_TTS_RATE?.trim();
  const args: string[] = [];
  if (voice) args.push('-v', voice);
  if (rate) args.push('-r', rate);
  args.push(text);
  return runPlayer('say', args, live);
}

/** Spawn a player process, track it as `current` (so stop() can kill it) and
 * resolve when it closes. Shared by afplay (kokoro) and say. Spawn/ENOENT
 * failures (missing binary on non-macOS / broken PATH) are logged, not thrown. */
function runPlayer(cmd: string, args: string[], live: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (!live()) return resolve();
    const proc = spawn(cmd, args);
    current = proc;
    const done = () => {
      if (current === proc) current = null;
      resolve();
    };
    proc.on('error', (err) => {
      console.error(`[alfred] ${cmd} failed:`, err instanceof Error ? err.message : err);
      done();
    });
    proc.on('close', done);
  });
}
