import AVFoundation
import PongPingKit
import XCTest

/// Loads PongPingAudioUnit in-process and renders it offline through
/// AVAudioEngine. Exercises the real Objective-C++ render path: event
/// splitting, MIDI, parameters and the probe.
final class PongPingAudioUnitTests: XCTestCase {
    private static let sampleRate = 44100.0
    private static let blockSize: AVAudioFrameCount = 512

    private var engine: AVAudioEngine!
    private var unit: AVAudioUnit!
    private var buffer: AVAudioPCMBuffer!

    override func setUp() async throws {
        AUAudioUnit.registerSubclass(PongPingAudioUnit.self,
                                     as: PongPingComponentDescription,
                                     name: "PongPing: Piano (test)",
                                     version: UInt32.max)
        unit = try await AVAudioUnit.instantiate(with: PongPingComponentDescription, options: .loadInProcess)
        engine = AVAudioEngine()
        let format = AVAudioFormat(standardFormatWithSampleRate: Self.sampleRate, channels: 2)!
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: Self.blockSize)
        engine.attach(unit)
        engine.connect(unit, to: engine.mainMixerNode, format: format)
        try engine.start()
        buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: Self.blockSize)!
    }

    override func tearDown() {
        engine?.stop()
    }

    private var audioUnit: PongPingAudioUnit { unit.auAudioUnit as! PongPingAudioUnit }

    private func send(_ bytes: [UInt8]) {
        let schedule = unit.auAudioUnit.scheduleMIDIEventBlock!
        bytes.withUnsafeBufferPointer { schedule(AUEventSampleTimeImmediate, 0, $0.count, $0.baseAddress!) }
    }

    /// Renders `seconds` of audio and returns the left channel.
    private func render(seconds: Double) throws -> [Float] {
        var samples: [Float] = []
        let total = Int(seconds * Self.sampleRate)
        while samples.count < total {
            let status = try engine.renderOffline(Self.blockSize, to: buffer)
            XCTAssertEqual(status, .success)
            let left = buffer.floatChannelData![0]
            samples.append(contentsOf: UnsafeBufferPointer(start: left, count: Int(buffer.frameLength)))
        }
        return samples
    }

    private func rms(_ x: ArraySlice<Float>) -> Double {
        guard !x.isEmpty else { return 0 }
        return sqrt(x.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(x.count))
    }

    private func frequency(_ x: [Float]) -> Double {
        var first = -1, last = -1, crossings = 0
        for i in 1..<x.count where x[i - 1] < 0 && x[i] >= 0 {
            if first < 0 { first = i } else { crossings += 1 }
            last = i
        }
        return crossings > 0 ? Double(crossings) * Self.sampleRate / Double(last - first) : 0
    }

    func testSilentWithoutNotes() throws {
        let out = try render(seconds: 0.2)
        XCTAssertEqual(rms(out[...]), 0, accuracy: 1e-9)
    }

    func testNotePlaysAtCorrectPitchAndStops() throws {
        send([0x90, 69, 110])                 // A4
        let held = try render(seconds: 0.5)
        XCTAssertGreaterThan(rms(held[4410...]), 0.01)
        XCTAssertEqual(frequency(Array(held[4410...])), 440, accuracy: 1.0)

        send([0x80, 69, 0])
        let released = try render(seconds: 0.3)   // release is 80 ms
        XCTAssertEqual(rms(released[8820...]), 0, accuracy: 1e-7)
    }

    func testSustainPedalHoldsNote() throws {
        send([0xB0, 64, 127])
        send([0x90, 60, 100])
        _ = try render(seconds: 0.1)
        send([0x80, 60, 0])
        let sustained = try render(seconds: 0.3)
        XCTAssertGreaterThan(rms(sustained[8820...]), 0.005)
        send([0xB0, 64, 0])
        let released = try render(seconds: 0.3)
        XCTAssertEqual(rms(released[8820...]), 0, accuracy: 1e-7)
    }

    func testGainParameterLowersLevel() throws {
        let gain = try XCTUnwrap(unit.auAudioUnit.parameterTree?.parameter(withAddress: 0))
        XCTAssertEqual(gain.identifier, "gain")
        gain.value = 0
        send([0x90, 69, 127])
        let loud = rms(try render(seconds: 0.3)[4410...])
        gain.value = -20
        XCTAssertEqual(gain.value, -20, accuracy: 1e-4)
        let quiet = rms(try render(seconds: 0.3)[4410...])
        XCTAssertEqual(quiet / loud, 0.1, accuracy: 0.02)
    }

    func testProbeRecordsRenderingAndMidi() throws {
        audioUnit.resetProbe()
        for velocity in [10, 50, 90, 127] as [UInt8] {
            send([0x90, 60, velocity])
            _ = try render(seconds: 0.05)
            send([0x80, 60, 0])
        }
        send([0xB0, 64, 64])
        _ = try render(seconds: 0.05)

        let json = audioUnit.probeReportJSON()
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let probe = try XCTUnwrap(root["probe"] as? [String: Any])
        let format = try XCTUnwrap(probe["format"] as? [String: Any])
        let render = try XCTUnwrap(probe["render"] as? [String: Any])
        let midi = try XCTUnwrap(probe["midi"] as? [String: Any])
        let sustain = try XCTUnwrap(midi["sustainCC64"] as? [String: Any])

        XCTAssertEqual(format["sampleRate"] as? Double, Self.sampleRate)
        XCTAssertGreaterThan(render["calls"] as? Int ?? 0, 0)
        XCTAssertEqual((render["frameSizes"] as? [String: Any])?.keys.sorted(), ["512"])
        XCTAssertEqual(midi["midi1NoteOns"] as? Int, 4)
        XCTAssertEqual(midi["midi1DistinctVelocities"] as? Int, 4)
        XCTAssertEqual(sustain["intermediateValues"] as? Int, 1)
        XCTAssertNotNil(root["host"] as? [String: Any])
    }
}
