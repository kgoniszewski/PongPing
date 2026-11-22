#include "pongping/HostProbe.hpp"

#include <bit>
#include <cstdio>
#include <sstream>

namespace pongping {

namespace {
constexpr auto kRelaxed = std::memory_order_relaxed;

template <typename T>
void bump(std::atomic<T>& counter, T amount = 1) noexcept {
    // Single writer: a load + store is enough and avoids a locked RMW.
    counter.store(counter.load(kRelaxed) + amount, kRelaxed);
}

template <typename T>
void storeMax(std::atomic<T>& slot, T value) noexcept {
    if (value > slot.load(kRelaxed)) slot.store(value, kRelaxed);
}

std::string number(double v) {
    char buffer[32];
    std::snprintf(buffer, sizeof buffer, "%.6g", v);
    return buffer;
}
} // namespace

// ---- Bitset128 ---------------------------------------------------------------

void HostProbe::Bitset128::set(uint8_t bit) noexcept {
    auto& word = words[(bit >> 6) & 1];
    const uint64_t mask = uint64_t{1} << (bit & 63);
    const uint64_t old = word.load(kRelaxed);
    if ((old & mask) == 0) word.store(old | mask, kRelaxed);
}

int HostProbe::Bitset128::count() const noexcept {
    return std::popcount(words[0].load(kRelaxed)) +
           std::popcount(words[1].load(kRelaxed));
}

bool HostProbe::Bitset128::test(uint8_t bit) const noexcept {
    return (words[(bit >> 6) & 1].load(kRelaxed) >> (bit & 63)) & 1;
}

void HostProbe::Bitset128::clear() noexcept {
    words[0].store(0, kRelaxed);
    words[1].store(0, kRelaxed);
}

// ---- MIDI 2.0 upscaling (M2-104-UM, "min-center-max") -----------------------

uint16_t HostProbe::upscale7to16(uint8_t v) noexcept {
    v &= 0x7F;
    const uint16_t shifted = static_cast<uint16_t>(v << 9);
    if (v <= 64) return shifted;
    const uint16_t repeat = v & 0x3F;
    return static_cast<uint16_t>(shifted | (repeat << 3) | (repeat >> 3));
}

uint32_t HostProbe::upscale7to32(uint8_t v) noexcept {
    v &= 0x7F;
    const uint32_t shifted = uint32_t{v} << 25;
    if (v <= 64) return shifted;
    const uint32_t repeat = v & 0x3F;
    return shifted | (repeat << 19) | (repeat << 13) | (repeat << 7) |
           (repeat << 1) | (repeat >> 5);
}

// ---- Recording ----------------------------------------------------------------

void HostProbe::recordFormat(double sampleRate, uint32_t channelCount,
                             uint32_t maximumFramesToRender) noexcept {
    sampleRate_.store(sampleRate, kRelaxed);
    channelCount_.store(channelCount, kRelaxed);
    maximumFramesToRender_.store(maximumFramesToRender, kRelaxed);
    allocations_.fetch_add(1, kRelaxed);
}

void HostProbe::recordRender(uint32_t frameCount, uint64_t durationNanos,
                             bool renderingOffline) noexcept {
    bump(renderCalls_);
    if (renderingOffline) bump(offlineRenderCalls_);
    bump(totalFrames_, uint64_t{frameCount});
    bump(totalNanos_, durationNanos);
    if (durationNanos > maxNanos_.load(kRelaxed)) {
        maxNanos_.store(durationNanos, kRelaxed);
        maxNanosFrames_.store(frameCount, kRelaxed);
    }
    if (frameCount < minFrames_.load(kRelaxed)) minFrames_.store(frameCount, kRelaxed);
    storeMax(maxFrames_, frameCount);

    const int used = frameSizeSlotsUsed_.load(std::memory_order_acquire);
    for (int i = 0; i < used; ++i) {
        if (frameSizeValue_[i].load(kRelaxed) == frameCount) {
            bump(frameSizeCount_[i]);
            return;
        }
    }
    if (used < kFrameSizeSlots) {
        frameSizeValue_[used].store(frameCount, kRelaxed);
        frameSizeCount_[used].store(1, kRelaxed);
        frameSizeSlotsUsed_.store(used + 1, std::memory_order_release);
    } else {
        bump(frameSizeOverflow_);
    }
}

void HostProbe::recordRenderThread(uint64_t threadId) noexcept {
    const uint64_t last = lastThreadId_.load(kRelaxed);
    if (last != threadId) {
        if (last != 0) bump(threadChanges_);
        lastThreadId_.store(threadId, kRelaxed);
    }
}

void HostProbe::recordWorkgroup(bool present, int maxParallelThreads) noexcept {
    bump(workgroupCallbacks_);
    workgroupPresent_.store(present, kRelaxed);
    workgroupMaxThreads_.store(maxParallelThreads, kRelaxed);
}

void HostProbe::recordTempo(double beatsPerMinute) noexcept {
    lastTempo_.store(beatsPerMinute, kRelaxed);
}

void HostProbe::recordEventTiming(EventTiming timing) noexcept {
    switch (timing) {
    case EventTiming::Immediate:    bump(eventsImmediate_); break;
    case EventTiming::InBuffer:     bump(eventsInBuffer_); break;
    case EventTiming::Late:         bump(eventsLate_); break;
    case EventTiming::BeyondBuffer: bump(eventsBeyond_); break;
    }
}

void HostProbe::recordParameterEvent(bool isRamp, uint32_t rampFrames) noexcept {
    bump(isRamp ? parameterRamps_ : parameterEvents_);
    storeMax(maxRampFrames_, uint64_t{rampFrames});
}

void HostProbe::recordMidi1NoteOn(uint8_t velocity) noexcept {
    bump(midi1NoteOns_);
    midi1Velocities_.set(velocity & 0x7F);
}

void HostProbe::recordMidi2NoteOn(uint16_t velocity) noexcept {
    bump(midi2NoteOns_);
    const auto v7 = static_cast<uint8_t>(velocity >> 9);
    midi2Velocities7_.set(v7);
    if (velocity != upscale7to16(v7)) bump(midi2HighResVelocities_);
}

void HostProbe::recordMidiEventList(uint8_t protocol) noexcept {
    bump(midiEventLists_);
    lastEventListProtocol_.store(protocol, kRelaxed);
}

void HostProbe::recordController(uint8_t controller, uint32_t value32,
                                 bool fromMidi2) noexcept {
    ControllerStats* stats = nullptr;
    switch (controller) {
    case 64: stats = &sustain_; break;
    case 66: stats = &sostenuto_; break;
    case 67: stats = &soft_; break;
    default: bump(otherControllers_); return;
    }
    bump(stats->messages);
    const auto v7 = static_cast<uint8_t>(value32 >> 25);
    stats->values7.set(v7);
    if (fromMidi2) {
        bump(stats->midi2Messages);
        if (value32 != upscale7to32(v7)) bump(stats->highResolution);
    }
}

// ---- Reset / report -------------------------------------------------------------

void HostProbe::reset() noexcept {
    for (Counter* c : {&renderCalls_, &offlineRenderCalls_, &totalFrames_, &totalNanos_,
                       &maxNanos_, &maxNanosFrames_, &frameSizeOverflow_, &threadChanges_,
                       &eventsImmediate_, &eventsInBuffer_, &eventsLate_, &eventsBeyond_,
                       &parameterEvents_, &parameterRamps_, &maxRampFrames_,
                       &midi1NoteOns_, &midi2NoteOns_, &midi2HighResVelocities_,
                       &midiEventLists_, &otherControllers_}) {
        c->store(0, kRelaxed);
    }
    minFrames_.store(UINT32_MAX, kRelaxed);
    maxFrames_.store(0, kRelaxed);
    frameSizeSlotsUsed_.store(0, std::memory_order_release);
    midi1Velocities_.clear();
    midi2Velocities7_.clear();
    for (ControllerStats* s : {&sustain_, &sostenuto_, &soft_}) {
        s->messages.store(0, kRelaxed);
        s->midi2Messages.store(0, kRelaxed);
        s->highResolution.store(0, kRelaxed);
        s->values7.clear();
    }
    // Format, workgroup and tempo describe the current setup, not a history,
    // so they are kept.
}

std::string HostProbe::toJSON() const {
    std::ostringstream o;
    const double sr = sampleRate_.load(kRelaxed);
    const uint64_t calls = renderCalls_.load(kRelaxed);
    const uint64_t frames = totalFrames_.load(kRelaxed);
    const uint64_t nanos = totalNanos_.load(kRelaxed);
    const uint64_t maxNs = maxNanos_.load(kRelaxed);
    const uint64_t maxNsFrames = maxNanosFrames_.load(kRelaxed);
    const uint32_t minF = minFrames_.load(kRelaxed);

    // Load = time spent rendering / audio time produced.
    const double averageLoad = (frames > 0 && sr > 0) ? (nanos * 1e-9) / (frames / sr) : 0.0;
    const double peakLoad = (maxNsFrames > 0 && sr > 0) ? (maxNs * 1e-9) / (maxNsFrames / sr) : 0.0;

    o << "{";
    o << "\"format\":{\"sampleRate\":" << number(sr)
      << ",\"channels\":" << channelCount_.load(kRelaxed)
      << ",\"maximumFramesToRender\":" << maximumFramesToRender_.load(kRelaxed)
      << ",\"allocateCount\":" << allocations_.load(kRelaxed) << "},";

    o << "\"render\":{\"calls\":" << calls
      << ",\"offlineCalls\":" << offlineRenderCalls_.load(kRelaxed)
      << ",\"minFrames\":" << (calls ? minF : 0)
      << ",\"maxFrames\":" << maxFrames_.load(kRelaxed)
      << ",\"frameSizes\":{";
    const int used = frameSizeSlotsUsed_.load(std::memory_order_acquire);
    for (int i = 0; i < used; ++i) {
        if (i) o << ",";
        o << "\"" << frameSizeValue_[i].load(kRelaxed) << "\":" << frameSizeCount_[i].load(kRelaxed);
    }
    o << "},\"frameSizeOverflow\":" << frameSizeOverflow_.load(kRelaxed)
      << ",\"threadChanges\":" << threadChanges_.load(kRelaxed)
      << ",\"averageLoad\":" << number(averageLoad)
      << ",\"peakLoad\":" << number(peakLoad)
      << ",\"peakMicroseconds\":" << number(maxNs / 1000.0) << "},";

    o << "\"workgroup\":{\"observerCalls\":" << workgroupCallbacks_.load(kRelaxed)
      << ",\"present\":" << (workgroupPresent_.load(kRelaxed) ? "true" : "false")
      << ",\"maxParallelThreads\":" << workgroupMaxThreads_.load(kRelaxed) << "},";

    o << "\"tempo\":" << number(lastTempo_.load(kRelaxed)) << ",";

    o << "\"events\":{\"immediate\":" << eventsImmediate_.load(kRelaxed)
      << ",\"inBuffer\":" << eventsInBuffer_.load(kRelaxed)
      << ",\"late\":" << eventsLate_.load(kRelaxed)
      << ",\"beyondBuffer\":" << eventsBeyond_.load(kRelaxed)
      << ",\"parameter\":" << parameterEvents_.load(kRelaxed)
      << ",\"parameterRamp\":" << parameterRamps_.load(kRelaxed)
      << ",\"maxRampFrames\":" << maxRampFrames_.load(kRelaxed) << "},";

    auto controller = [&](const char* name, const ControllerStats& s, bool comma) {
        const int distinct = s.values7.count();
        int intermediate = distinct - (s.values7.test(0) ? 1 : 0) - (s.values7.test(127) ? 1 : 0);
        o << "\"" << name << "\":{\"messages\":" << s.messages.load(kRelaxed)
          << ",\"midi2Messages\":" << s.midi2Messages.load(kRelaxed)
          << ",\"distinct7BitValues\":" << distinct
          << ",\"intermediateValues\":" << intermediate
          << ",\"highResolutionValues\":" << s.highResolution.load(kRelaxed) << "}"
          << (comma ? "," : "");
    };

    o << "\"midi\":{\"midi1NoteOns\":" << midi1NoteOns_.load(kRelaxed)
      << ",\"midi1DistinctVelocities\":" << midi1Velocities_.count()
      << ",\"midi2NoteOns\":" << midi2NoteOns_.load(kRelaxed)
      << ",\"midi2DistinctVelocities7\":" << midi2Velocities7_.count()
      << ",\"midi2HighResolutionVelocities\":" << midi2HighResVelocities_.load(kRelaxed)
      << ",\"eventLists\":" << midiEventLists_.load(kRelaxed)
      << ",\"eventListProtocol\":" << lastEventListProtocol_.load(kRelaxed)
      << ",\"otherControllers\":" << otherControllers_.load(kRelaxed) << ",";
    controller("sustainCC64", sustain_, true);
    controller("sostenutoCC66", sostenuto_, true);
    controller("softCC67", soft_, false);
    o << "}}";
    return o.str();
}

} // namespace pongping
