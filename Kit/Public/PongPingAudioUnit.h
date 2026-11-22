// PongPingAudioUnit — the AUv3 instrument (type 'aumu').
//
// Pure Objective-C interface so Swift can use it; the implementation is
// Objective-C++ and keeps the render path in C++.
#import <AudioToolbox/AudioToolbox.h>

NS_ASSUME_NONNULL_BEGIN

/// Component description values, also declared in Extension/Info.plist.
extern const AudioComponentDescription PongPingComponentDescription;

@interface PongPingAudioUnit : AUAudioUnit

/// Everything the host probe has recorded so far, as pretty-printed JSON.
/// Safe to call from any thread except the render thread.
- (NSString *)probeReportJSON;

/// Clears the probe's counters (render calls, events, MIDI statistics).
/// The current format and workgroup are kept.
- (void)resetProbe;

/// Where the probe report is written every two seconds while the plugin is
/// loaded. Inside the sandbox container of whichever process hosts the plugin.
@property (nonatomic, readonly, nullable) NSURL *probeReportURL;

@end

NS_ASSUME_NONNULL_END
