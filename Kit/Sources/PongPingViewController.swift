import AudioToolbox
import CoreAudioKit
import SwiftUI

/// Entry point of the AUv3 extension: the host asks this class (named in
/// Extension/Info.plist as `factoryFunction` and `NSExtensionPrincipalClass`)
/// to create the audio unit and its view.
@objc(PongPingViewController)
public final class PongPingViewController: AUViewController, AUAudioUnitFactory {
    private let model = ProbeModel()

    public override func loadView() {
        let hosting = NSHostingView(rootView: ProbeView(model: model))
        hosting.frame = NSRect(x: 0, y: 0, width: 560, height: 520)
        view = hosting
        preferredContentSize = hosting.frame.size
    }

    // May be called on a background thread.
    public func createAudioUnit(with componentDescription: AudioComponentDescription) throws -> AUAudioUnit {
        let audioUnit = try PongPingAudioUnit(componentDescription: componentDescription, options: [])
        DispatchQueue.main.async { [weak self] in
            self?.model.audioUnit = audioUnit
        }
        return audioUnit
    }
}
