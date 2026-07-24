/**
 * Default-language selector — pure + renderer-safe (NO `node:*` / better-sqlite3
 * import), so it is shared by the renderer dropdown, the orchestrator setter, the
 * STT locale resolution and the system-prompt directive. Mirrors accent-pure.ts.
 *
 * Scope: this is Alfred's *default reply language* + the *STT locale* it listens
 * in. It does NOT localise the UI chrome (Portuguese by design) and is orthogonal
 * to the TTS voice_config (a separate concern, owned elsewhere).
 */

export const LANGUAGES = ['pt-BR', 'en-US'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Default language — the historic pt-BR default, so a fresh DB behaves as before. */
export const DEFAULT_LANGUAGE: Language = 'pt-BR';

/** Narrow an arbitrary value to a known language. */
export function isLanguage(x: unknown): x is Language {
  return x === 'pt-BR' || x === 'en-US';
}

/**
 * Resolve the effective language with precedence: a valid persisted setting wins,
 * else a valid env default, else the built-in default. Fail-safe: any junk (blank,
 * malformed, unknown tag) at every level falls through to pt-BR. Pure.
 */
export function resolveLanguage(raw: unknown, envDefault?: unknown): Language {
  if (isLanguage(raw)) return raw;
  if (isLanguage(envDefault)) return envDefault;
  return DEFAULT_LANGUAGE;
}

/**
 * STT / wake-word locale for a language. pt-BR and en-US map 1:1 to their
 * SFSpeechRecognizer locale identifiers, so the tag IS the locale.
 */
export function localeForLanguage(lang: Language): string {
  return lang;
}

/** System-prompt directive steering the agent's default reply language. */
export function languageDirective(lang: Language): string {
  return lang === 'en-US'
    ? 'Always respond to the user in English (en-US) unless they write in another language.'
    : 'Responde sempre ao utilizador em Português do Brasil (pt-BR), a menos que ele escreva noutra língua.';
}
