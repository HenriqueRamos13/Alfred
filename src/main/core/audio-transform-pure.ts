/**
 * Audio-transform + cloud-STT pure logic — renderer-safe (NO `node:*` /
 * better-sqlite3 import), so the settings card and test/logic.test.ts import it
 * directly. Everything here is total functions + data; the IO that USES it lives
 * in cloud-stt.ts / openai-stt.ts (main only).
 *
 * The cloud STT flow (opt-in, default local): record the post-wake command to a
 * WAV, cut the silent tail, speed the audio up with ffmpeg's `atempo` (fewer
 * billed seconds — gpt-4o transcribes fine at ~2.3x), then POST it to OpenAI.
 */

/** Speech engine for the post-wake / mic command. Default is always 'local'. */
export type SttEngine = 'local' | 'openai';

/** Default playback speed-up sent to ffmpeg (fewer billed seconds at OpenAI). */
export const DEFAULT_STT_SPEED = 2.3;
/** Default silent-tail trim (ms) cut off the end of the recording before upload. */
export const DEFAULT_STT_TRIM_TAIL_MS = 2000;
/** Default OpenAI transcription model (cheap, good even sped up). */
export const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe';

/** ffmpeg's `atempo` filter only accepts a single factor in [0.5, 2.0]. */
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 2.0;

/** Format an atempo factor: integers keep one decimal ("2.0"), else trim noise ("1.15"). */
function fmtFactor(f: number): string {
  return Number.isInteger(f) ? f.toFixed(1) : String(Number(f.toFixed(4)));
}

/**
 * PURE — decompose a speed factor into a chain of `atempo=<f>` filters, each factor
 * in ffmpeg's allowed [0.5, 2.0] range, whose product is `speed`. 1.0 (or an
 * invalid speed) → [] (no filter). 2.3 → ["atempo=2.0","atempo=1.15"]; 0.25 →
 * ["atempo=0.5","atempo=0.5"]. Used to build the `-af` argument.
 */
export function buildAtempoChain(speed: number): string[] {
  if (!(speed > 0) || speed === 1) return [];
  const factors: number[] = [];
  let remaining = speed;
  if (remaining > 1) {
    while (remaining > ATEMPO_MAX + 1e-9) {
      factors.push(ATEMPO_MAX);
      remaining /= ATEMPO_MAX;
    }
  } else {
    while (remaining < ATEMPO_MIN - 1e-9) {
      factors.push(ATEMPO_MIN);
      remaining /= ATEMPO_MIN;
    }
  }
  factors.push(remaining);
  return factors.map((f) => `atempo=${fmtFactor(f)}`);
}

export interface FfmpegArgsInput {
  input: string;
  output: string;
  /** Full duration of the recording, seconds. */
  durationSec: number;
  /** Silent tail to cut off, seconds. */
  trimTailSec: number;
  /** Playback speed-up (>1 = faster, fewer billed seconds). */
  speed: number;
}

/**
 * PURE — ffmpeg argv to trim the silent tail and speed the audio up, writing a
 * mono 16 kHz WAV (ideal for STT). The kept length is `max(0.1, duration - trim)`
 * so a short clip never goes to zero/negative. The atempo chain is omitted at 1x.
 */
export function buildFfmpegArgs({ input, output, durationSec, trimTailSec, speed }: FfmpegArgsInput): string[] {
  const keep = Math.max(0.1, (Number.isFinite(durationSec) ? durationSec : 0) - Math.max(0, trimTailSec));
  const args = ['-y', '-i', input, '-t', keep.toFixed(3)];
  const chain = buildAtempoChain(speed);
  if (chain.length) args.push('-af', chain.join(','));
  args.push('-ac', '1', '-ar', '16000', output);
  return args;
}

/**
 * PURE, fail-closed — the effective STT engine. 'openai' is honoured ONLY when the
 * user picked it AND an OpenAI key is present; anything else (unset, 'local',
 * garbage, or 'openai' with no key) → 'local'. So cloud is never used by accident.
 */
export function resolveSttEngine(setting: string | undefined, hasOpenAIKey: boolean): SttEngine {
  return setting === 'openai' && hasOpenAIKey ? 'openai' : 'local';
}

/**
 * PURE — the OpenAI `language` hint from Alfred's language tag: en-US → "en",
 * everything else (pt-BR default) → "pt". Mirrors language-pure's two languages.
 */
export function openaiLangHint(language: string | undefined): 'pt' | 'en' {
  return language === 'en-US' ? 'en' : 'pt';
}

/** PURE — parse a persisted stt_speed into a sane factor (0.5–4.0), else the default. */
export function parseSttSpeed(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.5 || n > 4) return DEFAULT_STT_SPEED;
  return n;
}

/** PURE — parse a persisted stt_trim_tail_ms into a non-negative int (ms), else the default. */
export function parseSttTrimTailMs(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STT_TRIM_TAIL_MS;
  return Math.floor(n);
}
