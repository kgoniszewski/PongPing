// Umbrella header for PongPingKit, the framework that holds the Audio Unit.
// It is shared by the AUv3 extension (out-of-process loading, e.g. GarageBand)
// and the container app (in-process loading for development and tests).
#import <Foundation/Foundation.h>

FOUNDATION_EXPORT double PongPingKitVersionNumber;
FOUNDATION_EXPORT const unsigned char PongPingKitVersionString[];

#import <PongPingKit/PongPingAudioUnit.h>
