/**
 * OpenAI transcription client — MAIN only (node fetch + fs). Mirrors tts.ts's
 * ElevenLabs path: best-effort IO, degrade-and-log, and NEVER log the API key or
 * the audio bytes. On any failure it throws so the caller (cloud-stt.ts →
 * orchestrator) can fall back to the local on-device engine.
 *
 * Endpoint: POST https://api.openai.com/v1/audio/transcriptions (multipart), the
 * same API `whisper-1` / `gpt-4o(-mini)-transcribe` share. response_format=text
 * so the body IS the transcript (no JSON parse needed).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

export interface TranscribeOptions {
  apiKey: string;
  model: string;
  /** ISO-639-1 hint ("pt" | "en") — improves accuracy + latency. Optional. */
  language?: string;
  /** External abort (kill-switch). Combined with an internal timeout below. */
  signal?: AbortSignal;
  /** Request timeout in ms (default 30s). */
  timeoutMs?: number;
}

/**
 * Upload `path` to OpenAI and return the transcript text. Throws on a missing
 * key, network error, non-2xx, or timeout — the caller treats a throw as "cloud
 * unavailable" and falls back. The error message carries the HTTP status only;
 * never the key, never the audio.
 */
export async function transcribeFile(path: string, opts: TranscribeOptions): Promise<string> {
  if (!opts.apiKey?.trim()) throw new Error('OpenAI STT: no API key');
  const buf = await readFile(path);

  const form = new FormData();
  form.append('file', new Blob([buf]), basename(path));
  form.append('model', opts.model);
  form.append('response_format', 'text');
  if (opts.language) form.append('language', opts.language);

  // Internal timeout OR the caller's abort, whichever fires first.
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal,
    });
  } catch (err) {
    // Network / abort / timeout — surface WITHOUT the key or audio.
    throw new Error(`OpenAI STT request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI STT HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return (await res.text()).trim();
}
