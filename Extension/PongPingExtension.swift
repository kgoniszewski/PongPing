// The extension's code lives in PongPingKit. This file only makes sure the
// framework is linked so the system can find `PongPingViewController`
// (NSExtensionPrincipalClass) when GarageBand loads the plugin.
import PongPingKit

enum PongPingExtension {
    static let principalClass: AnyClass = PongPingViewController.self
}
