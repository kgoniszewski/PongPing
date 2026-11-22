import AVFoundation
import Combine
import PongPingKit

/// Hosts PongPingAudioUnit in-process for development.
///
/// The audio unit is created directly from the linked framework instead of
/// through the Audio Component registry: a sandboxed app cannot reliably
/// look up its own registered subclass (it fails with OSStatus -3000,
/// invalidComponentID). An AVAudioSourceNode pulls the unit's render block.
final class AudioHost: ObservableObject {
    @Published private(set) var status = "Not loaded"
    let probe = ProbeModel()

    private let engine = AVAudioEngine()
    private(set) var audioUnit: PongPingAudioUnit?
    private var sourceNode: AVAudioSourceNode?
    private let renderFlags = UnsafeMutablePointer<AudioUnitRenderActionFlags>.allocate(capacity: 1)

    static let maximumFrames: AUAudioFrameCount = 4096

    deinit {
        renderFlags.deallocate()
    }

    /// Creates the audio unit and connects it. With `offlineFrames` set the
    /// engine runs in manual (offline) rendering mode, used by the self-test.
    func load(offlineFormat: AVAudioFormat? = nil, offlineFrames: AVAudioFrameCount = 512) {
        guard audioUnit == nil else { return }
        do {
            if let offlineFormat {
                try engine.enableManualRenderingMode(.offline, format: offlineFormat,
                                                     maximumFrameCount: offlineFrames)
            }
            let sampleRate = offlineFormat?.sampleRate ?? engine.outputNode.outputFormat(forBus: 0).sampleRate
            guard sampleRate > 0,
                  let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2) else {
                status = "No audio output device"
                return
            }

            let unit = try PongPingAudioUnit(componentDescription: PongPingComponentDescription, options: [])
            try unit.outputBusses[0].setFormat(format)
            unit.maximumFramesToRender = Self.maximumFrames
            try unit.allocateRenderResources()

            let render = unit.renderBlock
            let flags = renderFlags
            let node = AVAudioSourceNode(format: format) { _, timestamp, frameCount, bufferList in
                flags.pointee = []
                return render(flags, timestamp, frameCount, 0, bufferList, nil)
            }
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: format)
            try engine.start()

            audioUnit = unit
            sourceNode = node
            probe.audioUnit = unit
            status = "Loaded in-process — \(Int(sampleRate)) Hz"
        } catch {
            status = "Load failed: \(error.localizedDescription)"
        }
    }

    func noteOn(_ note: UInt8, velocity: UInt8) { send([0x90, note, max(1, min(127, velocity))]) }
    func noteOff(_ note: UInt8) { send([0x80, note, 0]) }
    func sustain(_ down: Bool) { send([0xB0, 64, down ? 127 : 0]) }

    private func send(_ bytes: [UInt8]) {
        guard let schedule = audioUnit?.scheduleMIDIEventBlock else { return }
        bytes.withUnsafeBufferPointer { buffer in
            schedule(AUEventSampleTimeImmediate, 0, buffer.count, buffer.baseAddress!)
        }
    }

    /// Offline rendering, only valid after `load(offlineFormat:)`.
    func renderOffline(seconds: Double) throws -> [Float] {
        let format = engine.manualRenderingFormat
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                            frameCapacity: engine.manualRenderingMaximumFrameCount) else {
            return []
        }
        var samples: [Float] = []
        let total = Int(seconds * format.sampleRate)
        while samples.count < total {
            guard try engine.renderOffline(buffer.frameCapacity, to: buffer) == .success else { break }
            samples.append(contentsOf: UnsafeBufferPointer(start: buffer.floatChannelData![0],
                                                           count: Int(buffer.frameLength)))
        }
        return samples
    }
}
