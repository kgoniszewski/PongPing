import AppKit
import Combine
import SwiftUI

/// Polls the audio unit's probe report for display. Main thread only.
public final class ProbeModel: ObservableObject {
    @Published public private(set) var reportJSON = "{}"
    @Published public private(set) var summary: [(label: String, value: String)] = []

    public weak var audioUnit: PongPingAudioUnit? {
        didSet { refresh() }
    }

    private var timer: Timer?

    public init() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    deinit {
        timer?.invalidate()
    }

    public var reportPath: String {
        audioUnit?.probeReportURL?.path ?? "—"
    }

    public func reset() {
        audioUnit?.resetProbe()
        refresh()
    }

    public func copyReport() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(reportJSON, forType: .string)
    }

    func refresh() {
        guard let audioUnit else {
            reportJSON = "{}"
            summary = [("Status", "No audio unit loaded")]
            return
        }
        let json = audioUnit.probeReportJSON()
        reportJSON = json
        summary = Self.summarize(json)
    }

    /// The answers to the milestone 1 host questions, picked out of the report.
    static func summarize(_ json: String) -> [(label: String, value: String)] {
        guard let data = json.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let host = root["host"] as? [String: Any],
              let probe = root["probe"] as? [String: Any] else {
            return [("Status", "Report unreadable")]
        }
        let format = probe["format"] as? [String: Any] ?? [:]
        let render = probe["render"] as? [String: Any] ?? [:]
        let workgroup = probe["workgroup"] as? [String: Any] ?? [:]
        let events = probe["events"] as? [String: Any] ?? [:]
        let midi = probe["midi"] as? [String: Any] ?? [:]
        let sustain = midi["sustainCC64"] as? [String: Any] ?? [:]

        func s(_ value: Any?) -> String { value.map { "\($0)" } ?? "—" }
        func percent(_ value: Any?) -> String {
            guard let v = value as? Double else { return "—" }
            return String(format: "%.2f %%", v * 100)
        }
        let sizes = (render["frameSizes"] as? [String: Any] ?? [:])
            .sorted { (Int($0.key) ?? 0) < (Int($1.key) ?? 0) }
            .map { "\($0.key)×\($0.value)" }
            .joined(separator: "  ")

        return [
            ("Process", s(host["process"])),
            ("Sample rate", s(format["sampleRate"])),
            ("Channels", s(format["channels"])),
            ("Max frames", s(format["maximumFramesToRender"])),
            ("Buffer sizes", sizes.isEmpty ? "—" : sizes),
            ("Render calls", "\(s(render["calls"])) (offline \(s(render["offlineCalls"])))"),
            ("Render threads changed", s(render["threadChanges"])),
            ("Load avg / peak", "\(percent(render["averageLoad"])) / \(percent(render["peakLoad"]))"),
            ("Workgroup", "\(s(workgroup["present"])), max threads \(s(workgroup["maxParallelThreads"])), observer calls \(s(workgroup["observerCalls"]))"),
            ("Host MIDI protocol", s(host["hostMIDIProtocol"])),
            ("Note-ons MIDI 1 / 2", "\(s(midi["midi1NoteOns"])) / \(s(midi["midi2NoteOns"]))"),
            ("Distinct velocities", "\(s(midi["midi1DistinctVelocities"])) (MIDI 1), hi-res \(s(midi["midi2HighResolutionVelocities"])) (MIDI 2)"),
            ("Sustain CC64", "\(s(sustain["messages"])) msgs, \(s(sustain["intermediateValues"])) intermediate, \(s(sustain["highResolutionValues"])) hi-res"),
            ("Events imm / in / late / beyond", "\(s(events["immediate"])) / \(s(events["inBuffer"])) / \(s(events["late"])) / \(s(events["beyondBuffer"]))"),
            ("Parameter events / ramps", "\(s(events["parameter"])) / \(s(events["parameterRamp"]))"),
            ("Tempo", s(probe["tempo"])),
        ]
    }
}

/// Live view of the host probe. Used as the plugin's UI and inside the
/// container app.
public struct ProbeView: View {
    @ObservedObject var model: ProbeModel
    @State private var showRaw = false

    public init(model: ProbeModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("PongPing — Host Probe").font(.headline)
                Spacer()
                Button("Reset") { model.reset() }
                Button("Copy report") { model.copyReport() }
            }
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 4) {
                ForEach(model.summary, id: \.label) { row in
                    GridRow {
                        Text(row.label).foregroundStyle(.secondary)
                        Text(row.value).textSelection(.enabled)
                    }
                }
            }
            .font(.system(.body, design: .monospaced))
            Text("Report file: \(model.reportPath)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            DisclosureGroup("Raw report", isExpanded: $showRaw) {
                ScrollView {
                    Text(model.reportJSON)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(minHeight: 160)
            }
        }
        .padding(16)
        .frame(minWidth: 520, minHeight: 420, alignment: .topLeading)
    }
}
