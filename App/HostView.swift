import PongPingKit
import SwiftUI

struct HostView: View {
    @ObservedObject var host: AudioHost
    @State private var velocity = 90.0
    @State private var sustain = false

    private static let names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B", "C"]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(host.status).foregroundStyle(.secondary)
            HStack(spacing: 4) {
                ForEach(0..<13, id: \.self) { i in
                    KeyButton(name: Self.names[i]) {
                        host.noteOn(UInt8(60 + i), velocity: UInt8(velocity))
                    } onRelease: {
                        host.noteOff(UInt8(60 + i))
                    }
                }
            }
            HStack {
                Text("Velocity \(Int(velocity))").monospacedDigit().frame(width: 100, alignment: .leading)
                Slider(value: $velocity, in: 1...127, step: 1)
                Toggle("Sustain", isOn: $sustain)
                    .onChange(of: sustain) { _, down in host.sustain(down) }
            }
            Divider()
            ProbeView(model: host.probe)
        }
        .padding(16)
        .frame(width: 600)
    }
}

private struct KeyButton: View {
    let name: String
    let onPress: () -> Void
    let onRelease: () -> Void
    @State private var isDown = false

    var body: some View {
        Text(name)
            .frame(width: 38, height: 80, alignment: .bottom)
            .padding(.bottom, 6)
            .background(isDown ? Color.accentColor.opacity(0.6) : Color.secondary.opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        if !isDown {
                            isDown = true
                            onPress()
                        }
                    }
                    .onEnded { _ in
                        isDown = false
                        onRelease()
                    }
            )
    }
}
