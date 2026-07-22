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
