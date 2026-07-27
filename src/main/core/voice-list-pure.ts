/**
 * Renderer-safe voice-catalog helpers for the Settings VOICE selector. MUST stay
 * free of any `node:*` / electron / better-sqlite3 import — it is bundled into the
 * renderer (via the settings card) and unit-tested under strip-types. The macOS
 * `say -v '?'` spawn lives in the main-only sibling `voice-list.ts`; here we only
 * parse its text and hold the static catalogs.
 */

/** One selectable voice. `id` is what the engine takes (say voice name / kokoro id). */
export interface VoiceOption {
  id: string;
  name: string;
  locale: string;
  sample?: string;
  gender?: 'male' | 'female';
}

/** A locale token from `say -v '?'`: `en`, `en_US`, `pt_BR`. */
const LOCALE_RE = /^[a-z]{2}(_[A-Z]{2})?$/;

/**
 * Parse the raw `say -v '?'` output into VoiceOptions. Each line is
 * `<Name>  <locale>  # <sample>` where the name may carry spaces and parentheses
 * ("Felipe (Enhanced)", "Eddy (English (UK))"). Robust: split on the FIRST `#`
 * for the sample; on the left the LAST token matching a locale is the locale and
 * everything before it (trimmed) is the name. Blank/malformed lines (no locale,
 * or nothing before it) are skipped. Pure.
 */
export function parseSayVoices(raw: string): VoiceOption[] {
  const out: VoiceOption[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const hash = trimmed.indexOf('#');
    const left = (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim();
    const sample = hash === -1 ? undefined : trimmed.slice(hash + 1).trim() || undefined;
    if (!left) continue;
    const tokens = left.split(/\s+/);
    let localeIdx = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (LOCALE_RE.test(tokens[i])) {
        localeIdx = i;
        break;
      }
    }
    if (localeIdx <= 0) continue; // no locale, or nothing before it → malformed
    const name = tokens.slice(0, localeIdx).join(' ');
    if (!name) continue;
    out.push({ id: name, name, locale: tokens[localeIdx], sample });
  }
  return out;
}

/**
 * Static kokoro-js catalog (English only). Ids follow kokoro's convention:
 * first letter a=American/b=British, second f=female/m=male. Voice names are the
 * capitalised suffix. These are fixed by the model — no spawn needed.
 */
export const KOKORO_VOICES: VoiceOption[] = [
  { id: 'af_heart', name: 'Heart', locale: 'en_US', gender: 'female' },
  { id: 'af_bella', name: 'Bella', locale: 'en_US', gender: 'female' },
  { id: 'af_nicole', name: 'Nicole', locale: 'en_US', gender: 'female' },
  { id: 'af_sarah', name: 'Sarah', locale: 'en_US', gender: 'female' },
  { id: 'af_sky', name: 'Sky', locale: 'en_US', gender: 'female' },
  { id: 'am_adam', name: 'Adam', locale: 'en_US', gender: 'male' },
  { id: 'am_michael', name: 'Michael', locale: 'en_US', gender: 'male' },
  { id: 'am_puck', name: 'Puck', locale: 'en_US', gender: 'male' },
  { id: 'bf_emma', name: 'Emma', locale: 'en_GB', gender: 'female' },
  { id: 'bf_isabella', name: 'Isabella', locale: 'en_GB', gender: 'female' },
  { id: 'bm_george', name: 'George', locale: 'en_GB', gender: 'male' },
  { id: 'bm_lewis', name: 'Lewis', locale: 'en_GB', gender: 'male' },
];

/** The right catalog for an engine: say → the live system voices, kokoro → the
 * static list, elevenlabs → [] (the UI uses a free-text voice-id field). Pure. */
export function voicesForEngine(engine: string, sayVoices: VoiceOption[]): VoiceOption[] {
  if (engine === 'kokoro') return KOKORO_VOICES;
  if (engine === 'elevenlabs') return [];
  return sayVoices; // 'say' and the empty/default engine
}

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  pt: 'Português',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  nl: 'Nederlands',
  ja: '日本語',
  zh: '中文',
  ko: '한국어',
  ru: 'Русский',
};

/** "en_US" → "English (US)", "pt_BR" → "Português (BR)", "en" → "English",
 * unknown language code → the code itself. */
function describeLocale(locale: string): string {
  const [lang, region] = locale.split('_');
  const l = LANG_NAMES[lang] ?? lang;
  return region ? `${l} (${region})` : l;
}

/** Descriptive dropdown label, e.g. "Samantha — English (US)". Pure. */
export function labelForVoice(v: VoiceOption): string {
  const loc = describeLocale(v.locale);
  return loc ? `${v.name} — ${loc}` : v.name;
}
