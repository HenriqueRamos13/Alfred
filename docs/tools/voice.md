# voice (TTS · STT · wake word)

Speech I/O is **host-driven, not a tool you call** — the user toggles it in the
top bar and the orchestrator wires it to the turn. macOS only. Sources:
`src/main/core/{tts,stt,wakeword}.ts`. Documented here so you know it exists.

## Text-to-speech (Alfred speaks replies)
- **OFF by default.** When on, every assistant `chat.message` is spoken (both the
  API and claude-code brain paths flow through one point).
- Engines via `ALFRED_TTS_ENGINE`:
  - `say` (default, macOS built-in) — has **pt-BR** voices; plays audio itself.
    `ALFRED_TTS_VOICE` default `Luciana` (pt-BR ♀; also `Felipe` ♂),
    `ALFRED_TTS_RATE` in words/min. If the named voice isn't installed it retries
    once with the system default voice (never goes silent).
  - `kokoro` — kokoro-js, runs in Node, **English voices only**; ~300 MB weights
    download lazily on first speak. `ALFRED_TTS_VOICE` e.g. `af_heart`;
    `ALFRED_TTS_DTYPE` `q8|q4|fp16|fp32` (default `fp32`, least robotic).
- Utterances are serialised (a queue); `stop()` (kill-switch / toggle-off) kills
  the current player and skips the queue. Failures are logged, never thrown.

## Speech-to-text (push-to-talk)
- Native Swift helper `native/alfred-stt` (on-device `SFSpeechRecognizer`).
  Emits `stt.partial` (live) and exactly one `stt.final` per session.
- Language `ALFRED_STT_LOCALE` (default `pt-BR`); silence timeout
  `ALFRED_STT_SILENCE` seconds ends a session. Missing binary → a clear error
  (run `./setup.sh` to compile it).

## Cloud transcription engine (OpenAI, opt-in)
- **OFF by default — the default STT is local (Apple, on-device, private).** In
  SETTINGS → TRANSCRIÇÃO switch the engine to **OpenAI** to transcribe the command
  in the cloud instead. Fail-closed: picking OpenAI **without** `OPENAI_API_KEY`
  stays local (`resolveSttEngine`).
- **Wake detection stays local** — only the command *after* "Alfred" changes. The
  flow: helper hears "Alfred" (local) → the command audio is recorded to a WAV
  (`native/alfred-stt --record`), its silent tail cut and the audio sped up with
  ffmpeg's `atempo` (default **2.3x** — fewer billed seconds; gpt-4o transcribes
  fine sped up), then POSTed to OpenAI. Same for the manual mic button.
- Knobs (persisted, live): engine, model (default `gpt-4o-mini-transcribe`), speed
  (2.3x), tail trim (2000 ms). Pure logic in `audio-transform-pure.ts`; IO in
  `openai-stt.ts` (upload) + `cloud-stt.ts` (ffmpeg runner). Needs **ffmpeg** on
  PATH (`brew install ffmpeg`, done by `setup.sh`).
- **Privacy + cost.** OpenAI mode uploads your recorded command audio to OpenAI —
  local mode never leaves the Mac. Cost is per audio-second: `gpt-4o-mini-transcribe`
  is ~\$0.003/min, and the 2.3x speed-up divides the billed length by ~2.3.
- **Never crashes.** No key / no ffmpeg / network error / no audio → it logs (never
  the key, never the audio) and FALLS BACK to the local on-device session. The
  emergency kill-switch aborts any in-flight recording/upload.

## Wake word ("Alfred", always-on)
- Reuses the STT helper in `--wake` mode; local, no account. Default trigger
  `alfred` (also matches `alfredo`); override with `ALFRED_WAKEWORD`.
- Default **on** when the STT binary exists. The kill-switch suppresses it until
  the user re-arms (manual mic or toggle) — no audio capture after an emergency
  stop.

## Wake commands (action intents)
A wake transcript is classified by its **first word** (case/accent-insensitive,
pt + en) before it reaches the input — `parseVoiceIntent` in `wakeword.ts`:
- **hide** — `esconder/esconde/ocultar/oculta/hide` → hide all windows.
- **show** — `aparecer/aparece/mostrar/mostra/voltar/volta/show` → show them.
- **send** — `enviar/envia/mandar/manda/send/submit` → submit: trailing text
  starts a new turn; bare (no text) submits whatever is in the input.
- anything else → **dictate**: fills the input, the user confirms with Enter.
Hide/show run in the main process, so they work even while the window is hidden.

## Prefer English
`ALFRED_STT_LOCALE=en-US`, `ALFRED_TTS_ENGINE=kokoro`, `ALFRED_TTS_VOICE=af_heart`.
