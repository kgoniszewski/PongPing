import SwiftUI

/// Container app for the AUv3 extension. It exists so macOS registers the
/// extension, and it hosts the audio unit in-process for development.
@main
struct PongPingApp: App {
    @StateObject private var host = AudioHost()

    var body: some Scene {
        WindowGroup("PongPing") {
            HostView(host: host)
                .onAppear { host.load() }
        }
        .windowResizability(.contentSize)
    }
}
