// PongPingAudioUnit — AUv3 shell around the C++ core.
//
// Rules for anything reachable from the render block (see ARCHITECTURE.md §4.1):
// no allocation, no locks, no Objective-C/Swift messaging, no logging or file
// calls. The render block captures a raw pointer to a C++ RenderContext and
// only touches that.
#import "PongPingAudioUnit.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreMIDI/CoreMIDI.h>
#import <mach/mach_time.h>
#import <os/log.h>
#import <os/workgroup.h>
#import <pthread.h>
#import <sys/sysctl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <memory>
#include <string>
#include <vector>

#include "pongping/HostProbe.hpp"
#include "pongping/Midi.hpp"
#include "pongping/SineKernel.hpp"

// Set to 1 to ask the host for MIDI 2.0 (Universal MIDI Packets) instead of
// MIDI 1.0. Milestone 1 runs the probe both ways; see docs/MILESTONE-1.md.
#ifndef PONGPING_REQUEST_MIDI2
#define PONGPING_REQUEST_MIDI2 0
#endif

const AudioComponentDescription PongPingComponentDescription = {
    .componentType = kAudioUnitType_MusicDevice,  // 'aumu'
    .componentSubType = 'Pnpg',
    .componentManufacturer = 'Pgpg',
    .componentFlags = 0,
    .componentFlagsMask = 0,
};

namespace {

constexpr AUAudioFrameCount kDefaultMaximumFrames = 4096;
constexpr double kReportIntervalSeconds = 2.0;

struct RenderContext {
    pongping::SineKernel kernel;
    pongping::HostProbe probe;
    std::array<std::vector<float>, pongping::SineKernel::kMaxChannels> scratch;
    AUAudioFrameCount maximumFrames = 0;
    double ticksToNanos = 1.0;
    std::atomic<bool> renderingOffline{false};
    AUHostMusicalContextBlock musicalContext = nil;   // strong (ARC), set before rendering
};

bool isImmediate(AUEventSampleTime t) {
    // Immediate events are AUEventSampleTimeImmediate plus a small offset.
    return t < 0 && (t - AUEventSampleTimeImmediate) < (AUEventSampleTime{1} << 31);
}

void handleEvent(RenderContext& ctx, const AURenderEvent* event) {
    switch (event->head.eventType) {
    case AURenderEventParameter:
    case AURenderEventParameterRamp: {
        const AUParameterEvent& p = event->parameter;
        const bool ramp = event->head.eventType == AURenderEventParameterRamp;
        ctx.probe.recordParameterEvent(ramp, p.rampDurationSampleFrames);
        ctx.kernel.setParameter(p.parameterAddress, p.value, ramp ? p.rampDurationSampleFrames : 0);
        break;
    }
    case AURenderEventMIDI:
        pongping::midi::parseMidi1(event->MIDI.data, event->MIDI.length, ctx.kernel, &ctx.probe);
        break;
    case AURenderEventMIDIEventList: {
        const MIDIEventList& list = event->MIDIEventsList.eventList;
        ctx.probe.recordMidiEventList(static_cast<uint8_t>(list.protocol));
        const MIDIEventPacket* packet = &list.packet[0];
        for (UInt32 i = 0; i < list.numPackets; ++i) {
            pongping::midi::parseUmp(packet->words, packet->wordCount, ctx.kernel, &ctx.probe);
            packet = MIDIEventPacketNext(packet);
        }
        break;
    }
    default:
        break;   // SysEx and anything newer: ignored
    }
}

void renderSegment(RenderContext& ctx, float** channels, int channelCount,
                   AUAudioFrameCount offset, AUAudioFrameCount frames) {
    if (frames == 0) return;
    float* shifted[pongping::SineKernel::kMaxChannels];
    for (int c = 0; c < channelCount; ++c) shifted[c] = channels[c] + offset;
    ctx.kernel.render(shifted, channelCount, static_cast<int>(frames));
}

AUAudioUnitStatus render(RenderContext& ctx, const AudioTimeStamp* timestamp,
                         AUAudioFrameCount frameCount, AudioBufferList* output,
                         const AURenderEvent* events) {
    const uint64_t startTicks = mach_absolute_time();
    if (frameCount > ctx.maximumFrames) return kAudioUnitErr_TooManyFramesToProcess;

    ctx.probe.recordRenderThread(reinterpret_cast<uint64_t>(pthread_self()));

    // Hosts may pass null buffers and expect the plugin to supply memory.
    const int channelCount = std::min<int>(static_cast<int>(output->mNumberBuffers),
                                           pongping::SineKernel::kMaxChannels);
    float* channels[pongping::SineKernel::kMaxChannels] = {};
    for (int c = 0; c < channelCount; ++c) {
        AudioBuffer& buffer = output->mBuffers[c];
        if (buffer.mData == nullptr) buffer.mData = ctx.scratch[c].data();
        buffer.mDataByteSize = frameCount * sizeof(float);
        channels[c] = static_cast<float*>(buffer.mData);
    }
    for (UInt32 c = static_cast<UInt32>(channelCount); c < output->mNumberBuffers; ++c) {
        if (output->mBuffers[c].mData != nullptr) {
            std::fill_n(static_cast<float*>(output->mBuffers[c].mData), frameCount, 0.0f);
        }
    }

    if (ctx.musicalContext != nil) {
        double tempo = 0.0;
        if (ctx.musicalContext(&tempo, nullptr, nullptr, nullptr, nullptr, nullptr)) {
            ctx.probe.recordTempo(tempo);
        }
    }

    ctx.kernel.beginBlock();

    AUEventSampleTime now = static_cast<AUEventSampleTime>(timestamp->mSampleTime);
    const AUEventSampleTime blockEnd = now + frameCount;
    for (const AURenderEvent* e = events; e != nullptr; e = e->head.next) {
        const AUEventSampleTime t = e->head.eventSampleTime;
        using Timing = pongping::HostProbe::EventTiming;
        ctx.probe.recordEventTiming(isImmediate(t) ? Timing::Immediate
                                    : t < now      ? Timing::Late
                                    : t < blockEnd ? Timing::InBuffer
                                                   : Timing::BeyondBuffer);
    }

    // Split the buffer at each event so notes and automation are sample-accurate.
    const AURenderEvent* event = events;
    AUAudioFrameCount done = 0;
    while (done < frameCount) {
        while (event != nullptr && event->head.eventSampleTime <= now) {
            handleEvent(ctx, event);
            event = event->head.next;
        }
        AUAudioFrameCount segment = frameCount - done;
        if (event != nullptr) {
            segment = static_cast<AUAudioFrameCount>(
                std::min<AUEventSampleTime>(segment, event->head.eventSampleTime - now));
        }
        renderSegment(ctx, channels, channelCount, done, segment);
        done += segment;
        now += segment;
    }
    // Events stamped after this buffer should not happen; apply rather than lose them.
    for (; event != nullptr; event = event->head.next) handleEvent(ctx, event);

    const uint64_t elapsed = mach_absolute_time() - startTicks;
    ctx.probe.recordRender(frameCount, static_cast<uint64_t>(elapsed * ctx.ticksToNanos),
                           ctx.renderingOffline.load(std::memory_order_relaxed));
    return noErr;
}

NSString* sysctlString(const char* name) {
    size_t size = 0;
    if (sysctlbyname(name, nullptr, &size, nullptr, 0) != 0 || size == 0) return @"";
    std::string value(size, '\0');
    if (sysctlbyname(name, value.data(), &size, nullptr, 0) != 0) return @"";
    return [NSString stringWithUTF8String:value.c_str()] ?: @"";
}

NSNumber* sysctlInt(const char* name) {
    int value = 0;
    size_t size = sizeof value;
    if (sysctlbyname(name, &value, &size, nullptr, 0) != 0) return @(-1);
    return @(value);
}

} // namespace

@implementation PongPingAudioUnit {
    std::unique_ptr<RenderContext> _context;
    AUAudioUnitBus* _outputBus;
    AUAudioUnitBusArray* _outputBusArray;
    AUParameterTree* _parameterTree;
    dispatch_source_t _reportTimer;
    os_log_t _log;
}

@synthesize parameterTree = _parameterTree;

- (nullable instancetype)initWithComponentDescription:(AudioComponentDescription)componentDescription
                                              options:(AudioComponentInstantiationOptions)options
                                                error:(NSError**)outError {
    self = [super initWithComponentDescription:componentDescription options:options error:outError];
    if (self == nil) return nil;

    _log = os_log_create("com.pongping.audiounit", "probe");
    _context = std::make_unique<RenderContext>();
    mach_timebase_info_data_t timebase{};
    mach_timebase_info(&timebase);
    _context->ticksToNanos = static_cast<double>(timebase.numer) / timebase.denom;

    AVAudioFormat* format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:44100.0 channels:2];
    _outputBus = [[AUAudioUnitBus alloc] initWithFormat:format error:outError];
    if (_outputBus == nil) return nil;
    _outputBus.maximumChannelCount = pongping::SineKernel::kMaxChannels;
    _outputBusArray = [[AUAudioUnitBusArray alloc] initWithAudioUnit:self
                                                             busType:AUAudioUnitBusTypeOutput
                                                              busses:@[ _outputBus ]];
    [self buildParameterTree];
    self.maximumFramesToRender = kDefaultMaximumFrames;
    [self startReportTimer];
    return self;
}

- (void)dealloc {
    if (_reportTimer != nil) dispatch_source_cancel(_reportTimer);
}

- (void)buildParameterTree {
    const AudioUnitParameterOptions flags = kAudioUnitParameterFlag_IsReadable |
                                            kAudioUnitParameterFlag_IsWritable |
                                            kAudioUnitParameterFlag_CanRamp;
    const auto& gainInfo = pongping::kParameterInfo[pongping::kParameterGain];
    AUParameter* gain = [AUParameterTree createParameterWithIdentifier:@"gain"
                                                                  name:@"Gain"
                                                               address:pongping::kParameterGain
                                                                   min:gainInfo.minimum
                                                                   max:gainInfo.maximum
                                                                  unit:kAudioUnitParameterUnit_Decibels
                                                              unitName:nil
                                                                 flags:flags
                                                          valueStrings:nil
                                                   dependentParameters:nil];
    const auto& brightInfo = pongping::kParameterInfo[pongping::kParameterBrightness];
    AUParameter* brightness = [AUParameterTree createParameterWithIdentifier:@"brightness"
                                                                        name:@"Brightness"
                                                                     address:pongping::kParameterBrightness
                                                                         min:brightInfo.minimum
                                                                         max:brightInfo.maximum
                                                                        unit:kAudioUnitParameterUnit_Generic
                                                                    unitName:nil
                                                                       flags:flags
                                                                valueStrings:nil
                                                         dependentParameters:nil];
    gain.value = gainInfo.defaultValue;
    brightness.value = brightInfo.defaultValue;
    _parameterTree = [AUParameterTree createTreeWithChildren:@[ gain, brightness ]];

    // Parameter changes that do not arrive as render events (UI, host
    // set-value) go through lock-free slots read at the next block start.
    pongping::SineKernel* kernel = &_context->kernel;
    _parameterTree.implementorValueObserver = ^(AUParameter* parameter, AUValue value) {
        kernel->requestParameter(parameter.address, value);
    };
    _parameterTree.implementorValueProvider = ^AUValue(AUParameter* parameter) {
        return kernel->parameterValue(parameter.address);
    };
}

#pragma mark - Busses and capabilities

- (AUAudioUnitBusArray*)outputBusses {
    return _outputBusArray;
}

- (NSArray<NSNumber*>*)channelCapabilities {
    return @[ @0, @2 ];   // no input, stereo output
}

#if PONGPING_REQUEST_MIDI2
- (MIDIProtocolID)AudioUnitMIDIProtocol {
    return kMIDIProtocol_2_0;
}
#endif

- (void)setRenderingOffline:(BOOL)renderingOffline {
    [super setRenderingOffline:renderingOffline];
    _context->renderingOffline.store(renderingOffline, std::memory_order_relaxed);
}

#pragma mark - Render resources

- (BOOL)allocateRenderResourcesAndReturnError:(NSError**)outError {
    if (![super allocateRenderResourcesAndReturnError:outError]) return NO;

    AVAudioFormat* format = _outputBus.format;
    if (format.commonFormat != AVAudioPCMFormatFloat32 || format.isInterleaved ||
        format.channelCount < 1 || format.channelCount > pongping::SineKernel::kMaxChannels) {
        if (outError != nullptr) {
            *outError = [NSError errorWithDomain:NSOSStatusErrorDomain
                                            code:kAudioUnitErr_FormatNotSupported
                                        userInfo:nil];
        }
        [super deallocateRenderResources];
        return NO;
    }

    RenderContext& ctx = *_context;
    ctx.maximumFrames = self.maximumFramesToRender;
    for (auto& buffer : ctx.scratch) buffer.assign(ctx.maximumFrames, 0.0f);
    ctx.kernel.prepare(format.sampleRate);
    ctx.musicalContext = self.musicalContextBlock;
    ctx.renderingOffline.store(self.renderingOffline, std::memory_order_relaxed);
    ctx.probe.recordFormat(format.sampleRate, format.channelCount, ctx.maximumFrames);

    os_log_info(_log, "allocate: %.0f Hz, %u ch, max %u frames", format.sampleRate,
                format.channelCount, ctx.maximumFrames);
    return YES;
}

- (void)deallocateRenderResources {
    _context->musicalContext = nil;
    [super deallocateRenderResources];
}

- (AUInternalRenderBlock)internalRenderBlock {
    RenderContext* ctx = _context.get();
    return ^AUAudioUnitStatus(AudioUnitRenderActionFlags* /*actionFlags*/,
                              const AudioTimeStamp* timestamp,
                              AUAudioFrameCount frameCount,
                              NSInteger /*outputBusNumber*/,
                              AudioBufferList* outputData,
                              const AURenderEvent* realtimeEventListHead,
                              AURenderPullInputBlock /*pullInputBlock*/) {
        return render(*ctx, timestamp, frameCount, outputData, realtimeEventListHead);
    };
}

// Called by the host on the render thread whenever the render context (and
// with it the audio workgroup) changes.
- (AURenderContextObserver)renderContextObserver {
    pongping::HostProbe* probe = &_context->probe;
    return ^(const AudioUnitRenderContext* context) {
        if (context != nullptr && context->workgroup != nullptr) {
            probe->recordWorkgroup(true, os_workgroup_max_parallel_threads(context->workgroup, nullptr));
        } else {
            probe->recordWorkgroup(false, 0);
        }
    };
}

#pragma mark - Probe report

- (NSString*)probeReportJSON {
    NSMutableDictionary* host = [NSMutableDictionary dictionary];
    NSProcessInfo* process = NSProcessInfo.processInfo;
    host[@"process"] = process.processName ?: @"";
    host[@"processBundleIdentifier"] = NSBundle.mainBundle.bundleIdentifier ?: @"";
    host[@"osVersion"] = process.operatingSystemVersionString ?: @"";
    host[@"hardwareModel"] = sysctlString("hw.model");
    host[@"cpu"] = sysctlString("machdep.cpu.brand_string");
    host[@"performanceCores"] = sysctlInt("hw.perflevel0.logicalcpu");
    host[@"efficiencyCores"] = sysctlInt("hw.perflevel1.logicalcpu");
    host[@"hostMIDIProtocol"] = @(self.hostMIDIProtocol);
    host[@"requestedMIDI2"] = @(PONGPING_REQUEST_MIDI2 != 0);
    host[@"musicalContextBlock"] = @(self.musicalContextBlock != nil);
    host[@"transportStateBlock"] = @(self.transportStateBlock != nil);
    host[@"renderResourcesAllocated"] = @(self.renderResourcesAllocated);
    host[@"renderingOffline"] = @(self.renderingOffline);
    host[@"maximumFramesToRender"] = @(self.maximumFramesToRender);
    host[@"timestamp"] = [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]];

    const std::string probeJSON = _context->probe.toJSON();
    NSData* probeData = [NSData dataWithBytes:probeJSON.data() length:probeJSON.size()];
    id probe = [NSJSONSerialization JSONObjectWithData:probeData options:0 error:nil] ?: @{};

    NSDictionary* report = @{@"host" : host, @"probe" : probe};
    NSData* data = [NSJSONSerialization dataWithJSONObject:report
                                                   options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
                                                     error:nil];
    return data != nil ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{}";
}

- (void)resetProbe {
    _context->probe.reset();
}

- (nullable NSURL*)probeReportURL {
    NSURL* support = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                          inDomains:NSUserDomainMask].firstObject;
    return [[support URLByAppendingPathComponent:@"PongPing" isDirectory:YES]
        URLByAppendingPathComponent:@"host-probe.json"];
}

- (void)startReportTimer {
    dispatch_queue_t queue = dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
    _reportTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    const uint64_t interval = static_cast<uint64_t>(kReportIntervalSeconds * NSEC_PER_SEC);
    dispatch_source_set_timer(_reportTimer, dispatch_time(DISPATCH_TIME_NOW, interval), interval,
                              interval / 10);
    __weak PongPingAudioUnit* weakSelf = self;
    dispatch_source_set_event_handler(_reportTimer, ^{
        [weakSelf writeReport];
    });
    dispatch_resume(_reportTimer);
}

- (void)writeReport {
    NSURL* url = self.probeReportURL;
    if (url == nil) return;
    [NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent
                           withIntermediateDirectories:YES
                                            attributes:nil
                                                 error:nil];
    NSError* error = nil;
    if (![[self probeReportJSON] writeToURL:url atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
        os_log_error(_log, "could not write probe report: %{public}@", error.localizedDescription);
    } else {
        os_log_debug(_log, "probe report written to %{public}@", url.path);
    }
}

@end
