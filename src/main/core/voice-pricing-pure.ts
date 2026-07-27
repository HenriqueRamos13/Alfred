/**
 * Voice (TTS + STT) cloud cost estimation — PURE + renderer-safe (NO `node:*` /
 * better-sqlite3 import), so the settings/cost card and test/logic.test.ts import
 * it directly. Mirrors pricing.ts for LLMs, but for the voice engines the
 * orchestrator drives (see hooks in orchestrator.ts). Local engines (`say`,
 * `kokoro`) run on-device and always cost $0.
 *
 * ALL RATES BELOW ARE ESTIMATES (mid-2026) — visibility only, confirm before you
 * rely on them; providers change these and plans/tiers vary:
 *   - STT (per audio-minute):
 *       gpt-4o-mini-transcribe  $0.003/min
 *       whisper-1               $0.006/min
 *       gpt-4o-transcribe       $0.006/min
 *   - OpenAI TTS (per 1,000,000 characters; gpt-4o-mini-tts is token-based, this
 *     is an approximation):
 *       gpt-4o-mini-tts  $15 / 1M
 *       tts-1            $15 / 1M
 *       tts-1-hd         $30 / 1M
 *   - ElevenLabs TTS: ~$0.10 / 1K chars ≈ $100 / 1M chars (varies a lot by plan).
 *   - say / kokoro (local): $0.
 */

/** STT rates, USD per audio-minute (ESTIMATE, mid-2026). Unknown model → no rate. */
export const STT_RATES_PER_MIN: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003,
  'whisper-1': 0.006,
  'gpt-4o-transcribe': 0.006,
};

/** OpenAI TTS rates, USD per 1,000,000 characters (ESTIMATE, mid-2026). */
export const TTS_RATES_PER_M_CHARS: Record<string, number> = {
  'gpt-4o-mini-tts': 15,
  'tts-1': 15,
  'tts-1-hd': 30,
};

/** ElevenLabs TTS, USD per 1,000,000 characters (ESTIMATE — plan-dependent). */
export const ELEVENLABS_RATE_PER_M_CHARS = 100;

/**
 * Billed STT seconds: the silent tail is trimmed AND the audio is sped up before
 * upload, so both cut the seconds OpenAI charges for (a 2.3x speed-up bills ~2.3x
 * fewer seconds). Pure. Guards: negative kept length floors at 0; a non-positive
 * speed is treated as 1x (no divide-by-zero / negative).
 */
export function billedSttSeconds(recordedSeconds: number, trimMs: number, speed: number): number {
  const kept = Math.max(0, (Number.isFinite(recordedSeconds) ? recordedSeconds : 0) - Math.max(0, trimMs) / 1000);
  const s = speed > 0 ? speed : 1;
  return kept / s;
}

/** Estimated USD for one STT transcription. Unknown model → 0 (no fabricated cost). */
export function sttCostUsd(billedSeconds: number, model: string): number {
  const rate = STT_RATES_PER_MIN[model];
  if (!rate || !(billedSeconds > 0)) return 0;
  return (billedSeconds / 60) * rate;
}

/**
 * Estimated USD for one TTS utterance. Local engines (`say`, `kokoro`) → 0. OpenAI
 * uses the per-model char rate (unknown model → 0). ElevenLabs uses its flat rate.
 * Pure.
 */
export function ttsCostUsd(engine: string, model: string, chars: number): number {
  if (!(chars > 0)) return 0;
  if (engine === 'elevenlabs') return (chars / 1_000_000) * ELEVENLABS_RATE_PER_M_CHARS;
  if (engine === 'openai') {
    const rate = TTS_RATES_PER_M_CHARS[model];
    return rate ? (chars / 1_000_000) * rate : 0;
  }
  return 0; // say / kokoro (local) and anything unknown → free
}
