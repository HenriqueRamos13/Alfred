/**
 * Text-to-speech — Alfred speaks his replies. Uses Kokoro (kokoro-js, an ONNX/JS
 * port that runs in Node, no Python), synthesises to a temp WAV and plays it on
 * macOS with `afplay`.
 *
 * - The model is lazy-loaded and cached; the ~300MB weights download on the
 *   FIRST speak() (or an optional pre-warm — see setup.sh).
 * - Calls are serialised (a queue) so replies never talk over each other.
 * - stop() kills the current afplay and skips anything still queued (kill-switch
 *   / toggle-off). Errors (download failure, afplay missing) are logged, never
 *   thrown — TTS is best-effort and must never crash a turn.
 *
 * Voice is configurable via ALFRED_TTS_VOICE (default 'af_heart'). Run
 * `node -e "import('kokoro-js').then(m=>m.KokoroTTS.prototype.list_voices())"`-style
 * to see the list, or check kokoro-js docs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = 'af_heart';

// kokoro-js is heavy (pulls @huggingface/transformers + onnxruntime) and only
// loads on first use, so it's imported dynamically inside the lazy init — the
// module stays cheap to import on any platform (incl. the Linux build box).
type KokoroModel = { generate(text: string, opts: { voice: string }): Promise<{ save(path: string): Promise<void> }> };
let modelPromise: Promise<KokoroModel> | null = null;

function getModel(): Promise<KokoroModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { KokoroTTS } = await import('kokoro-js');
      // q8 keeps the model small and CPU-friendly; fine for narration.
      return (await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8' })) as unknown as KokoroModel;
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

/** Optional: trigger the model download ahead of the first speak(). */
export function prewarm(): Promise<unknown> {
  return getModel();
}

async function synthAndPlay(text: string, live: () => boolean): Promise<void> {
  const model = await getModel();
  if (!live()) return;
  const voice = process.env.ALFRED_TTS_VOICE?.trim() || DEFAULT_VOICE;
  const audio = await model.generate(text, { voice });
  if (!live()) return;
  const wav = join(tmpdir(), `alfred-tts-${randomUUID()}.wav`);
  await audio.save(wav);
  try {
    await playWav(wav, live);
  } finally {
    await unlink(wav).catch(() => {});
  }
}

function playWav(path: string, live: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (!live()) return resolve();
    const proc = spawn('afplay', [path]);
    current = proc;
    const done = () => {
      if (current === proc) current = null;
      resolve();
    };
    // ENOENT (afplay absent — non-macOS / broken PATH) or spawn failure: log, don't throw.
    proc.on('error', (err) => {
      console.error('[alfred] afplay failed:', err instanceof Error ? err.message : err);
      done();
    });
    proc.on('close', done);
  });
}
