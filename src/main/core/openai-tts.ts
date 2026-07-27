/**
 * OpenAI TTS (main-only IO) — the network client for the 'openai' voice engine,
 * kept OUT of tts.ts (owned separately). Mirrors elevenPlay in tts.ts: POST the
 * text to /v1/audio/speech, get back mp3, play it with `afplay` (macOS-only — the
 * afplay step degrades cleanly off a Mac, like the rest of TTS), then delete the
 * temp file.
 *
 * SECURITY: the OPENAI_API_KEY and the audio bytes are NEVER logged — errors carry
 * the HTTP status only. FALLBACK: no key, a network/HTTP error, or a timeout all
 * fall back to `say` (via the injected `fallback`) so Alfred never goes silent.
 *
 * The playback + fallback are injected by tts.ts (`play` = its runPlayer so the
 * afplay process still registers with stop()/half-duplex state; `fallback` = its
 * sayPlay) — this module stays free of tts.ts internals.
 */
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENDPOINT = 'https://api.openai.com/v1/audio/speech';
/** Cap the synth request so a hung connection can't wedge the TTS queue. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface OpenAiSynthOpts {
  apiKey: string;
  model: string;
  voice: string;
  signal?: AbortSignal;
}

/** POST text → mp3 audio Buffer. Throws on non-2xx (status only, never the key or
 * body) or on a network/abort error. Uses Node's global fetch. */
export async function synthesize(text: string, opts: OpenAiSynthOpts): Promise<Buffer> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: opts.model, voice: opts.voice, input: text, response_format: 'mp3' }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface OpenAiPlayCfg {
  apiKey: string | undefined;
  model: string;
  voice: string;
  /** Play a local audio file, resolving with the exit code. Injected by tts.ts as
   * its runPlayer so afplay still tracks under stop()/half-duplex. */
  play: (file: string) => Promise<number | null>;
  /** `say` fallback, injected by tts.ts — used on no-key or any failure. */
  fallback: () => Promise<void>;
}

/** Synthesize with OpenAI and play the mp3 with afplay (Mac-only). No key or ANY
 * failure → fall back to `say`. `live` gates against a stop() mid-flight. */
export async function openaiPlay(text: string, live: () => boolean, cfg: OpenAiPlayCfg): Promise<void> {
  const apiKey = cfg.apiKey?.trim();
  if (!apiKey) {
    console.warn('[alfred] tts: OpenAI engine on but OPENAI_API_KEY missing — using `say`');
    return cfg.fallback();
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let buf: Buffer;
  try {
    buf = await synthesize(text, { apiKey, model: cfg.model, voice: cfg.voice, signal: ctrl.signal });
  } catch (err) {
    // Never print the key/audio; message (status) only. Fall back unless stopped.
    console.warn('[alfred] tts: OpenAI failed — falling back to `say`:', err instanceof Error ? err.message : err);
    return live() ? cfg.fallback() : undefined;
  } finally {
    clearTimeout(timer);
  }
  if (!live()) return;
  const mp3 = join(tmpdir(), `alfred-tts-${randomUUID()}.mp3`);
  await writeFile(mp3, buf);
  try {
    await cfg.play(mp3); // afplay — Mac-only, resolves null (killed / ENOENT) off-Mac
  } finally {
    await unlink(mp3).catch(() => {});
  }
}
