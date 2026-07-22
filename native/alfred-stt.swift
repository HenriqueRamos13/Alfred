// alfred-stt — on-device speech-to-text helper for Alfred (macOS, Intel).
//
// A tiny CLI around AVAudioEngine + SFSpeechRecognizer. It starts listening on
// launch and speaks a line-delimited JSON protocol on stdout:
//
//   {"partial":"..."}   a live (interim) transcript, emitted as you speak
//   {"final":"..."}     the settled transcript when the session ends
//   {"wake":true}       (--wake only) the wake word was just heard
//   {"error":"..."}     an authorization / setup failure (also exits non-zero)
//
// Two modes:
//
//   PUSH-TO-TALK (default): one shot. The session ends — printing a {"final"}
//   and exiting 0 — on ANY of:
//     • SIGINT / SIGTERM        (push-to-talk: Node kills on key/button release)
//     • EOF on stdin            (parent closed the pipe)
//     • prolonged silence       (ALFRED_STT_SILENCE seconds, default 2.0)
//     • the recognizer reporting isFinal
//
//   WAKE (--wake): long-running. Listens INDEFINITELY for the wake word
//   (ALFRED_WAKEWORD, default "alfred"; case-insensitive; also matches ASR
//   variants like "alfredo"). On hearing it, prints {"wake":true}, then treats
//   the speech that follows (until a silence gap) as the command and prints
//   {"final":"<command without the wake prefix>"}, then goes back to listening.
//   SFSpeechRecognitionRequest caps a single request at ~1min of audio, so the
//   recognition task is recycled periodically (~50s / on isFinal) to never stop.
//   Stops on SIGINT/SIGTERM/EOF so the parent can reclaim the mic.
//
// Recognition is ON-DEVICE when the OS/locale supports it
// (requiresOnDeviceRecognition = true); otherwise it falls back to the normal
// (server) path and notes that on stderr. Locale comes from `--locale xx-YY`
// or ALFRED_STT_LOCALE (default pt-BR).
//
// Build (on the Mac — Swift does not compile on the Linux build box):
//   swiftc native/alfred-stt.swift -o native/alfred-stt

import Foundation
import Speech
import AVFoundation

// MARK: - JSON line protocol

func emit(_ obj: [String: String]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func note(_ message: String) {
    FileHandle.standardError.write(("alfred-stt: " + message + "\n").data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
    emit(["error": message])
    exit(2)
}

// MARK: - Config

func resolveLocaleId() -> String {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--locale"), i + 1 < args.count {
        return args[i + 1]
    }
    return ProcessInfo.processInfo.environment["ALFRED_STT_LOCALE"] ?? "pt-BR"
}

func resolveSilenceSeconds() -> TimeInterval {
    if let raw = ProcessInfo.processInfo.environment["ALFRED_STT_SILENCE"],
       let v = Double(raw), v > 0 {
        return v
    }
    return 2.0
}

/// Wake words to listen for in --wake mode. ALFRED_WAKEWORD (default "alfred"),
/// plus the common ASR mishearing "alfredo" when the default is in use.
func resolveWakeWords() -> [String] {
    let raw = ProcessInfo.processInfo.environment["ALFRED_WAKEWORD"] ?? "alfred"
    let word = raw.lowercased().trimmingCharacters(in: .whitespaces)
    let base = word.isEmpty ? "alfred" : word
    var words = [base]
    if base == "alfred" { words.append("alfredo") }
    return words
}

// MARK: - Recognizer

final class Recognizer {
    private let engine = AVAudioEngine()
    private let recognizer: SFSpeechRecognizer
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var lastText = ""
    private var silenceTimer: DispatchSourceTimer?
    private let silenceSeconds: TimeInterval
    private var finished = false

    init(localeId: String, silenceSeconds: TimeInterval) {
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
            fail("no speech recognizer for locale \(localeId)")
        }
        self.recognizer = r
        self.silenceSeconds = silenceSeconds
    }

    func start() {
        guard recognizer.isAvailable else { fail("speech recognizer is unavailable right now") }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        } else {
            note("on-device recognition unavailable for \(recognizer.locale.identifier); using server mode")
        }
        request = req

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            fail("audio engine failed to start: \(error.localizedDescription)")
        }

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                self.lastText = result.bestTranscription.formattedString
                if result.isFinal {
                    self.finish()
                    return
                }
                emit(["partial": self.lastText])
                self.resetSilence()
            }
            if error != nil {
                self.finish()
            }
        }
        resetSilence()
    }

    private func resetSilence() {
        silenceTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + silenceSeconds)
        t.setEventHandler { [weak self] in self?.finish() }
        t.resume()
        silenceTimer = t
    }

    /// Stop cleanly, print the final transcript, and exit. Idempotent.
    func finish() {
        if finished { return }
        finished = true
        silenceTimer?.cancel()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        request?.endAudio()
        task?.finish()
        emit(["final": lastText])
        exit(0)
    }
}

// MARK: - Wake-word recognizer (continuous, --wake)

/// Listens indefinitely for the wake word, then captures the following speech
/// (until a silence gap) as one command. The recognition task is recycled
/// before it hits SFSpeech's ~1min request limit so listening never stops.
final class WakeRecognizer {
    private let engine = AVAudioEngine()
    private let recognizer: SFSpeechRecognizer
    private let wakeWords: [String]
    private let silenceSeconds: TimeInterval
    private let segmentSeconds: TimeInterval = 50

    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: DispatchSourceTimer?
    private var segmentTimer: DispatchSourceTimer?

    private var awake = false          // true while capturing a command
    private var pendingCommand = ""    // command text heard after the wake word
    private var tapInstalled = false
    private var restarting = false
    private var stopped = false

    init(localeId: String, wakeWords: [String], silenceSeconds: TimeInterval) {
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
            fail("no speech recognizer for locale \(localeId)")
        }
        self.recognizer = r
        self.wakeWords = wakeWords
        self.silenceSeconds = silenceSeconds
    }

    func start() {
        guard recognizer.isAvailable else { fail("speech recognizer is unavailable right now") }
        if !recognizer.supportsOnDeviceRecognition {
            note("on-device recognition unavailable for \(recognizer.locale.identifier); wake word will use server mode (needs network, may be rate-limited)")
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        tapInstalled = true
        engine.prepare()
        do {
            try engine.start()
        } catch {
            fail("audio engine failed to start: \(error.localizedDescription)")
        }
        startSegment()
    }

    /// Begin one recognition task on the (already running) audio engine.
    private func startSegment() {
        restarting = false
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self, !self.stopped else { return }
            if let result = result {
                self.handle(text: result.bestTranscription.formattedString)
                if result.isFinal { self.segmentEnded() }
            }
            if error != nil { self.segmentEnded() }
        }
        scheduleSegmentTimer()
    }

    // ponytail: recycle before the ~1min SFSpeechRecognitionRequest cap; if we're
    // mid-command, defer the recycle rather than cut the user off.
    private func scheduleSegmentTimer() {
        segmentTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + segmentSeconds)
        t.setEventHandler { [weak self] in
            guard let self = self else { return }
            if self.awake { self.scheduleSegmentTimer() } else { self.restartSegment() }
        }
        t.resume()
        segmentTimer = t
    }

    private func segmentEnded() {
        if awake { finalizeCommand() } else { restartSegment() }
    }

    /// Tear the current task down and start a fresh one (clears the transcript).
    private func restartSegment() {
        if restarting { return }
        restarting = true
        silenceTimer?.cancel(); silenceTimer = nil
        segmentTimer?.cancel(); segmentTimer = nil
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        awake = false
        pendingCommand = ""
        DispatchQueue.main.async { [weak self] in
            guard let self = self, !self.stopped else { return }
            self.startSegment()
        }
    }

    private func handle(text: String) {
        if awake {
            if let cmd = commandAfterWake(text) { pendingCommand = cmd }
            resetSilence()
        } else if let cmd = commandAfterWake(text) {
            awake = true
            pendingCommand = cmd
            print("{\"wake\":true}")
            fflush(stdout)
            resetSilence()
        }
    }

    private func finalizeCommand() {
        let cmd = pendingCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cmd.isEmpty { emit(["final": cmd]) }
        restartSegment()
    }

    private func resetSilence() {
        silenceTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + silenceSeconds)
        t.setEventHandler { [weak self] in self?.finalizeCommand() }
        t.resume()
        silenceTimer = t
    }

    /// First word matching a wake word → the (possibly empty) command after it.
    /// Returns nil when no wake word is present in the transcript.
    private func commandAfterWake(_ text: String) -> String? {
        let words = text.split(separator: " ").map(String.init)
        for (i, w) in words.enumerated() {
            let token = w.lowercased().trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
            if wakeWords.contains(where: { !$0.isEmpty && token.hasPrefix($0) }) {
                let rest = i + 1 < words.count ? words[(i + 1)...].joined(separator: " ") : ""
                return rest.trimmingCharacters(in: CharacterSet(charactersIn: " ,.;:!?"))
            }
        }
        return nil
    }

    func stop() {
        if stopped { return }
        stopped = true
        silenceTimer?.cancel()
        segmentTimer?.cancel()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
        engine.stop()
        request?.endAudio()
        task?.cancel()
        exit(0)
    }
}

// MARK: - Lifecycle

var recognizer: Recognizer?
var wakeRecognizer: WakeRecognizer?
let localeId = resolveLocaleId()
let silenceSeconds = resolveSilenceSeconds()
let wakeMode = CommandLine.arguments.contains("--wake")
let wakeWords = resolveWakeWords()

func beginListening() {
    DispatchQueue.main.async {
        if wakeMode {
            let w = WakeRecognizer(localeId: localeId, wakeWords: wakeWords, silenceSeconds: silenceSeconds)
            wakeRecognizer = w
            w.start()
        } else {
            let r = Recognizer(localeId: localeId, silenceSeconds: silenceSeconds)
            recognizer = r
            r.start()
        }
    }
}

func stopListening() {
    if let w = wakeRecognizer { w.stop() }
    else if let r = recognizer { r.finish() }
    else { exit(0) }
}

// Stop on SIGINT / SIGTERM (push-to-talk release). Ignore the default handler so
// our DispatchSource can flush a final transcript before exit.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigintSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigintSrc.setEventHandler { stopListening() }
sigintSrc.resume()
let sigtermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSrc.setEventHandler { stopListening() }
sigtermSrc.resume()

// Stop on EOF of stdin (parent closed the pipe). availableData blocks until data
// or EOF, so this is not a busy loop.
DispatchQueue.global(qos: .utility).async {
    let stdin = FileHandle.standardInput
    while !stdin.availableData.isEmpty { /* drain; parent sends nothing meaningful */ }
    DispatchQueue.main.async { stopListening() }
}

// Ask for Speech Recognition, then Microphone, then start. Both are required;
// a denial prints {"error"} and exits non-zero.
SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        fail("speech recognition not authorized (status \(status.rawValue)) — enable it in System Settings › Privacy & Security › Speech Recognition")
    }
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        beginListening()
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            if granted { beginListening() }
            else { fail("microphone access denied — enable it in System Settings › Privacy & Security › Microphone") }
        }
    default:
        fail("microphone access denied — enable it in System Settings › Privacy & Security › Microphone")
    }
}

dispatchMain()
