/**
 * Main-only voice catalog: the one place that spawns macOS `say -v '?'`. Kept
 * OUT of tts.ts (owned separately) and out of the renderer (node:child_process
 * is main-only). Parsing + static catalogs live in the pure sibling
 * `voice-list-pure.ts`. Degrades cleanly: any failure (off-Mac / no `say` /
 * timeout) yields [] so the Settings selector just shows no system voices.
 */
import { spawn } from 'node:child_process';
import { KOKORO_VOICES, OPENAI_VOICES, parseSayVoices, type VoiceOption } from './voice-list-pure.ts';

/** How long to wait for `say -v '?'` before giving up (ms). */
const SAY_TIMEOUT_MS = 4000;

/** Run `say -v '?'` and return its raw stdout. Rejects off-Mac (ENOENT), on a
 * non-zero exit, or on timeout — the caller maps any rejection to []. */
function saySample(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('say', ['-v', '?']);
    let out = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('say -v timeout'));
    }, SAY_TIMEOUT_MS);
    timer.unref?.();
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) resolve(out);
      else reject(new Error(`say -v exit ${code}`));
    });
  });
}

/**
 * The voices selectable for an engine. 'say' queries the Mac live (empty off-Mac
 * or on any failure — never throws); 'kokoro' is the static English catalog;
 * 'elevenlabs' is [] (the UI uses a free-text voice-id field).
 */
export async function listVoices(engine: string): Promise<VoiceOption[]> {
  if (engine === 'kokoro') return KOKORO_VOICES;
  if (engine === 'openai') return OPENAI_VOICES;
  if (engine === 'elevenlabs') return [];
  const raw = await saySample().catch(() => '');
  return parseSayVoices(raw);
}
