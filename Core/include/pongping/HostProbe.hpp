// HostProbe — records facts about how the host drives the plugin.
//
// Milestone 1 instrument: answers the "Host facts to confirm" questions in
// docs/ARCHITECTURE.md §1 (sample rate, buffer sizes, workgroup, MIDI
// resolution, pedal resolution, parameter events).
//
// Threading: every record*() method is called from the render thread only
// (single writer) and is real-time safe: no allocation, no locks, relaxed
// atomics only. toJSON() and reset() may be called from any other thread.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <string>

namespace pongping {

class HostProbe {
public:
    static constexpr int kFrameSizeSlots = 16;

    // ---- Called when render resources are allocated (not real-time) -------
    void recordFormat(double sampleRate, uint32_t channelCount,
                      uint32_t maximumFramesToRender) noexcept;

    // ---- Render thread ------------------------------------------------------
    void recordRender(uint32_t frameCount, uint64_t durationNanos,
                      bool renderingOffline) noexcept;
    void recordRenderThread(uint64_t threadId) noexcept;
    void recordWorkgroup(bool present, int maxParallelThreads) noexcept;
    void recordTempo(double beatsPerMinute) noexcept;

    enum class EventTiming { Immediate, InBuffer, Late, BeyondBuffer };
    void recordEventTiming(EventTiming timing) noexcept;
    void recordParameterEvent(bool isRamp, uint32_t rampFrames) noexcept;

    void recordMidi1NoteOn(uint8_t velocity) noexcept;           // 7-bit
    void recordMidi2NoteOn(uint16_t velocity) noexcept;          // 16-bit UMP
    void recordMidiEventList(uint8_t protocol) noexcept;         // UMP list seen
    // value32: controller value scaled to 32 bits (MIDI 1.0 values upscaled).
    void recordController(uint8_t controller, uint32_t value32,
                          bool fromMidi2) noexcept;

    // ---- Any non-render thread ----------------------------------------------
    void reset() noexcept;
    std::string toJSON() const;

    // MIDI 2.0 "min-center-max" upscaling, used to tell whether a 16/32-bit
    // value carries more information than a 7-bit one.
    static uint16_t upscale7to16(uint8_t v) noexcept;
    static uint32_t upscale7to32(uint8_t v) noexcept;

private:
    using Counter = std::atomic<uint64_t>;
    static_assert(Counter::is_always_lock_free);

    struct Bitset128 {
        std::array<std::atomic<uint64_t>, 2> words{};
        void set(uint8_t bit) noexcept;
        int count() const noexcept;
        bool test(uint8_t bit) const noexcept;
        void clear() noexcept;
    };

    struct ControllerStats {
        Counter messages{0};
        Counter midi2Messages{0};
        Counter highResolution{0};   // values a 7-bit message could not carry
        Bitset128 values7;           // 7-bit projections of every value seen
    };

    // Format
    std::atomic<double> sampleRate_{0.0};
    std::atomic<uint32_t> channelCount_{0};
    std::atomic<uint32_t> maximumFramesToRender_{0};
    Counter allocations_{0};

    // Render calls
    Counter renderCalls_{0};
    Counter offlineRenderCalls_{0};
    Counter totalFrames_{0};
    Counter totalNanos_{0};
    Counter maxNanos_{0};
    Counter maxNanosFrames_{0};
    std::atomic<uint32_t> minFrames_{UINT32_MAX};
    std::atomic<uint32_t> maxFrames_{0};
    std::array<std::atomic<uint32_t>, kFrameSizeSlots> frameSizeValue_{};
    std::array<Counter, kFrameSizeSlots> frameSizeCount_{};
    std::atomic<int> frameSizeSlotsUsed_{0};
    Counter frameSizeOverflow_{0};

    // Threads and workgroup
    std::atomic<uint64_t> lastThreadId_{0};
    Counter threadChanges_{0};
    Counter workgroupCallbacks_{0};
    std::atomic<bool> workgroupPresent_{false};
    std::atomic<int> workgroupMaxThreads_{0};

    // Host context
    std::atomic<double> lastTempo_{0.0};

    // Events
    Counter eventsImmediate_{0};
    Counter eventsInBuffer_{0};
    Counter eventsLate_{0};
    Counter eventsBeyond_{0};
    Counter parameterEvents_{0};
    Counter parameterRamps_{0};
    Counter maxRampFrames_{0};

    // MIDI
    Counter midi1NoteOns_{0};
    Bitset128 midi1Velocities_;
    Counter midi2NoteOns_{0};
    Counter midi2HighResVelocities_{0};
    Bitset128 midi2Velocities7_;
    Counter midiEventLists_{0};
    std::atomic<int> lastEventListProtocol_{0};
    ControllerStats sustain_;     // CC 64
    ControllerStats sostenuto_;   // CC 66
    ControllerStats soft_;        // CC 67
    Counter otherControllers_{0};
};

} // namespace pongping
