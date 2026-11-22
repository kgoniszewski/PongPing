import AVFoundation
import Foundation
import PongPingKit

/// Headless checks of the app's real hosting path, run from Terminal or CI:
///
///     PongPing.app/Contents/MacOS/PongPing --selftest
///
/// Runs inside the app's sandbox with its real signature, which the unit
/// tests (run by xctest, unsandboxed) cannot cover. Exits 0 on success.
enum SelfTest {
    static func runIfRequested() {
        let arguments = CommandLine.arguments
        if arguments.contains("--selftest") { exit(hostingTest()) }
        if arguments.contains("--selftest-registry") { exit(registryTest()) }
    }

    private static func say(_ text: String) {
        FileHandle.standardOutput.write(Data((text + "\n").utf8))
    }

    /// The path the app window uses: direct creation + AVAudioSourceNode.
    private static func hostingTest() -> Int32 {
        let host = AudioHost()
        let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
        host.load(offlineFormat: format)
        say("status: \(host.status)")
        guard let unit = host.audioUnit else { return 1 }

        do {
            host.noteOn(69, velocity: 110)
            let held = try host.renderOffline(seconds: 0.5)
            host.noteOff(69)
            let released = try host.renderOffline(seconds: 0.3)
            let heldLevel = rms(held.dropFirst(4410))
            let releasedLevel = rms(released.dropFirst(8820))
            say(String(format: "held rms %.4f, released rms %.6f", heldLevel, releasedLevel))
            say(unit.probeReportJSON())
            let ok = heldLevel > 0.01 && releasedLevel < 1e-6
            say(ok ? "SELFTEST PASSED" : "SELFTEST FAILED")
            return ok ? 0 : 1
        } catch {
            say("render failed: \(error)")
            return 1
        }
    }

    /// Diagnostic only: the Audio Component registry path that failed with
    /// -3000 in the sandboxed app. Reports what the registry returns.
    private static func registryTest() -> Int32 {
        let components = AVAudioUnitComponentManager.shared().components(matching: PongPingComponentDescription)
        say("registry components matching PongPing: \(components.count)")
        for c in components {
            say("  \(c.name) version \(c.version) sandboxSafe \(c.isSandboxSafe)")
        }
        AUAudioUnit.registerSubclass(PongPingAudioUnit.self, as: PongPingComponentDescription,
                                     name: "PongPing: Piano (in-process)", version: UInt32.max)
        var result: Int32 = 1
        for (label, options) in [("loadInProcess", AudioComponentInstantiationOptions.loadInProcess),
                                 ("default", AudioComponentInstantiationOptions())] {
            let done = DispatchSemaphore(value: 0)
            AVAudioUnit.instantiate(with: PongPingComponentDescription, options: options) { unit, error in
                if let unit {
                    say("\(label): OK (\(type(of: unit.auAudioUnit)))")
                    result = 0
                } else {
                    say("\(label): failed \(error.map { "\($0)" } ?? "nil")")
                }
                done.signal()
            }
            if done.wait(timeout: .now() + 10) == .timedOut { say("\(label): timed out") }
        }
        return result
    }

    private static func rms<C: Collection>(_ x: C) -> Double where C.Element == Float {
        guard !x.isEmpty else { return 0 }
        return (x.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(x.count)).squareRoot()
    }
}
