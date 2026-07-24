/**
 * Renderer-safe settings helpers. MUST stay free of any `node:*` /
 * better-sqlite3 import so it can be shared and unit-tested via strip-types.
 */
import type { VoiceConfig } from './types.ts';

/**
 * GRILL-ME toggle: defaults to ON. The setting is absent on a fresh DB, so only
 * an explicit "0" disables it — anything else (including undefined) is ON.
 */
export function grillMeEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * Resolve a string config with precedence: a persisted setting wins, else the env
 * value, else the fallback. Blank/whitespace at any level falls through. Lets the
 * settings card override TTS voice/engine/rate/eleven-voice-id at runtime while
 * the .env value stays the default. Pure.
 */
export function resolveConfigValue(
  setting: string | undefined,
  env: string | undefined,
  fallback: string,
): string {
  return setting?.trim() || env?.trim() || fallback;
}

/** The TTS fields the settings card can override (all optional strings). */
const VOICE_KEYS = ['engine', 'voice', 'rate', 'elevenVoiceId'] as const;

/**
 * Per-field validity for a voice_config value (already trimmed, non-blank). A
 * field that fails is dropped → reverts to the .env value / built-in default.
 *   - rate feeds `say -r <n>`; a non-integer makes say exit non-zero on BOTH the
 *     primary and the voice-less retry, so TTS would go permanently silent —
 *     only a positive integer is allowed through.
 *   - elevenVoiceId is interpolated into the ElevenLabs URL path, so restrict it
 *     to alphanumerics: a value with `.`/`/` could retarget the authenticated
 *     request to a different same-host endpoint.
 *   - engine / voice are free-form (engine is re-validated by resolveEngine at use;
 *     voice names carry spaces/parens like "Felipe (Enhanced)").
 */
function isValidVoiceField(key: string, v: string): boolean {
  if (key === 'rate') return /^\d+$/.test(v) && Number(v) > 0;
  if (key === 'elevenVoiceId') return /^[A-Za-z0-9]+$/.test(v);
  return true;
}

/**
 * Parse the persisted `voice_config` JSON into a VoiceConfig. Fail-safe: blank,
 * undefined, malformed JSON, or a non-object all yield {} (env/defaults win).
 * Only the known non-blank string fields survive — junk keys and non-string
 * values (corruption / a hostile blob) are dropped, and each value is trimmed.
 * Also the trust-boundary sanitiser for an untrusted patch from the renderer
 * (round-trip an object through JSON.stringify → parseVoiceConfig). Pure.
 */
export function parseVoiceConfig(raw: string | undefined): VoiceConfig {
  if (!raw?.trim()) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: VoiceConfig = {};
  for (const k of VOICE_KEYS) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim() && isValidVoiceField(k, v.trim())) out[k] = v.trim();
  }
  return out;
}
