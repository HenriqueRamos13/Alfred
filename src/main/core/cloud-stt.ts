/**
 * Cloud STT runner — MAIN only. Glues the recorded command WAV → ffmpeg (trim the
 * silent tail + speed it up, fewer billed seconds) → OpenAI transcription. All the
 * decisions (atempo chain, argv, engine gate) are the pure functions in
 * audio-transform-pure.ts; this file is only the IO (spawn + probe + upload).
 *
 * Contract: throw on ANY failure (ffmpeg missing, ffmpeg error, upload error) so
 * the orchestrator falls back to the local on-device engine and NEVER crashes.
 * Never logs the audio or the API key.
 */
import { spawn, spawnSync } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildFfmpegArgs } from './audio-transform-pure.ts';
import { transcribeFile } from './openai-stt.ts';

export interface CloudSttConfig {
  apiKey: string;
  model: string;
  /** OpenAI language hint ("pt" | "en"). Optional. */
  language?: string;
  /** Playback speed-up (>1 = faster). */
  speed: number;
  /** Silent tail to cut, seconds. */
  trimTailSec: number;
  /** Full recording duration (from the recorder); probed via ffprobe when absent. */
  durationSec?: number;
  /** Kill-switch abort. */
  signal?: AbortSignal;
}

/** Is an `ffmpeg` binary on PATH? Cheap sync check (only called on the cloud path). */
export function hasFfmpeg(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Trim + speed-up `wavPath` with ffmpeg and transcribe the result via OpenAI.
 * Throws on any failure (caller falls back to local). The intermediate 16 kHz WAV
 * is written to a temp file and always cleaned up.
 */
export async function processAndTranscribe(wavPath: string, cfg: CloudSttConfig): Promise<string> {
  if (!hasFfmpeg()) throw new Error('ffmpeg not found — install it (brew install ffmpeg) or use the local STT engine');
  const durationSec = cfg.durationSec && cfg.durationSec > 0 ? cfg.durationSec : await probeDurationSec(wavPath);
  const out = join(tmpdir(), `alfred-stt-${randomUUID()}.wav`);
  try {
    await runFfmpeg(
      buildFfmpegArgs({ input: wavPath, output: out, durationSec, trimTailSec: cfg.trimTailSec, speed: cfg.speed }),
      cfg.signal,
    );
    return await transcribeFile(out, {
      apiKey: cfg.apiKey,
      model: cfg.model,
      language: cfg.language,
      signal: cfg.signal,
    });
  } finally {
    void unlink(out).catch(() => {});
  }
}

/** Spawn ffmpeg with `args`; resolve on exit 0, reject otherwise (or on abort/ENOENT). */
function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('ffmpeg aborted'));
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const onAbort = (): void => void child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString();
    });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`));
    });
  });
}

/** Best-effort duration via ffprobe; throws if unavailable (rare — the recorder supplies it). */
function probeDurationSec(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
    child.on('close', () => {
      const n = Number(out.trim());
      if (Number.isFinite(n) && n > 0) resolve(n);
      else reject(new Error('ffprobe could not determine duration'));
    });
  });
}
