// alfred-stt — on-device speech-to-text helper for Alfred (macOS, Intel).
//
// A tiny CLI around AVAudioEngine + SFSpeechRecognizer. It starts listening on
// launch and speaks a line-delimited JSON protocol on stdout:
//
//   {"partial":"..."}   a live (interim) transcript, emitted as you speak
//   {"final":"..."}     the settled transcript when the session ends
//   {"error":"..."}     an authorization / setup failure (also exits non-zero)
//
// The session ends — printing a {"final"} and exiting 0 — on ANY of:
//   • SIGINT / SIGTERM        (push-to-talk: Node kills on key/button release)
//   • EOF on stdin            (parent closed the pipe)
//   • prolonged silence       (ALFRED_STT_SILENCE seconds, default 2.0)
//   • the recognizer reporting isFinal
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

// MARK: - Lifecycle

var recognizer: Recognizer?
let localeId = resolveLocaleId()
let silenceSeconds = resolveSilenceSeconds()

func beginListening() {
    DispatchQueue.main.async {
        let r = Recognizer(localeId: localeId, silenceSeconds: silenceSeconds)
        recognizer = r
        r.start()
    }
}

func stopListening() {
    if let r = recognizer { r.finish() } else { exit(0) }
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
