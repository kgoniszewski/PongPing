import AVFoundation
import Combine
import PongPingKit

/// Loads PongPingAudioUnit in-process with AVAudioEngine and plays it.
final class AudioHost: ObservableObject {
    @Published private(set) var status = "Not loaded"
    let probe = ProbeModel()

    private let engine = AVAudioEngine()
    private var unit: AVAudioUnit?

    func load() {
        guard unit == nil else { return }
        // Register the class directly so in-process loading works even before
        // macOS has picked up the embedded extension.
        AUAudioUnit.registerSubclass(PongPingAudioUnit.self,
                                     as: PongPingComponentDescription,
                                     name: "PongPing: Piano (in-process)",
                                     version: UInt32.max)
        status = "Loading…"
        AVAudioUnit.instantiate(with: PongPingComponentDescription, options: .loadInProcess) { unit, error in
            DispatchQueue.main.async { self.finishLoading(unit, error) }
        }
    }

    private func finishLoading(_ unit: AVAudioUnit?, _ error: Error?) {
        guard let unit else {
            status = "Load failed: \(error?.localizedDescription ?? "unknown error")"
            return
        }
        engine.attach(unit)
        engine.connect(unit, to: engine.mainMixerNode, format: nil)
        do {
            try engine.start()
        } catch {
            status = "Audio engine failed: \(error.localizedDescription)"
            return
        }
        self.unit = unit
        probe.audioUnit = unit.auAudioUnit as? PongPingAudioUnit
        status = probe.audioUnit != nil ? "Loaded in-process" : "Loaded (not PongPingAudioUnit?)"
    }

    func noteOn(_ note: UInt8, velocity: UInt8) { send([0x90, note, max(1, min(127, velocity))]) }
    func noteOff(_ note: UInt8) { send([0x80, note, 0]) }
    func sustain(_ down: Bool) { send([0xB0, 64, down ? 127 : 0]) }

    private func send(_ bytes: [UInt8]) {
        guard let schedule = unit?.auAudioUnit.scheduleMIDIEventBlock else { return }
        bytes.withUnsafeBufferPointer { buffer in
            schedule(AUEventSampleTimeImmediate, 0, buffer.count, buffer.baseAddress!)
        }
    }
}
