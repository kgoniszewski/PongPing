// SineKernel — Milestone 1 placeholder instrument.
//
// A small polyphonic sine synth with velocity, sustain pedal and two
// automatable parameters. Its job is to prove the plugin plumbing (events,
// sample-accurate timing, parameters, real-time safety) inside GarageBand,
// not to sound like a piano. It is replaced by the modal engine in
// milestone 2.
//
// Threading: requestParameter() and parameterValue() may be called from any
// thread. Everything else is called from the render thread (or before
// rendering starts) and is real-time safe.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>

#include "pongping/Midi.hpp"

namespace pongping {

enum ParameterAddress : uint64_t {
    kParameterGain = 0,        // dB, -40 … +6
    kParameterBrightness = 1,  // 0 … 1, amount of added odd harmonics
    kParameterCount = 2,
};

struct ParameterInfo {
    float minimum;
    float maximum;
    float defaultValue;
};

constexpr std::array<ParameterInfo, kParameterCount> kParameterInfo{{
    {-40.0f, 6.0f, -6.0f},
    {0.0f, 1.0f, 0.0f},
}};

class SineKernel final : public MidiSink {
public:
    static constexpr int kMaxVoices = 16;
    static constexpr int kMaxChannels = 2;

    SineKernel();

    // Not real-time: called when render resources are allocated.
    void prepare(double sampleRate) noexcept;
    // Silences every voice.
    void reset() noexcept;

    // ---- Parameters -----------------------------------------------------------
    // From any thread (UI, parameter tree). Applied at the next block start
    // with a short ramp.
    void requestParameter(uint64_t address, float value) noexcept;
    // Last value requested or applied; any thread.
    float parameterValue(uint64_t address) const noexcept;
    // From the render thread (host automation events), sample-accurate.
    void setParameter(uint64_t address, float value, uint32_t rampFrames) noexcept;

    // ---- Render thread --------------------------------------------------------
    // Call once at the start of every render call.
    void beginBlock() noexcept;
    // Writes (overwrites) `frames` samples into each channel pointer.
    void render(float* const* channels, int channelCount, int frames) noexcept;

    void noteOn(int note, float velocity) noexcept override;
    void noteOff(int note, float velocity) noexcept override;
    void controlChange(int controller, float value) noexcept override;
    void allNotesOff() noexcept override;

    int activeVoiceCount() const noexcept;
    bool sustainDown() const noexcept { return sustain_; }

private:
    enum class Stage : uint8_t { Idle, Attack, Hold, Release };

    struct Voice {
        Stage stage = Stage::Idle;
        int note = -1;
        bool keyDown = false;
        bool sustained = false;   // key released while the pedal was down
        double phase = 0.0;       // cycles, [0, 1)
        double increment = 0.0;   // cycles per sample
        float level = 0.0f;       // envelope
        float peak = 0.0f;        // velocity-scaled target
        uint64_t startOrder = 0;
    };

    struct Ramp {
        float current = 0.0f;
        float target = 0.0f;
        float step = 0.0f;
        uint32_t remaining = 0;

        void set(float value, uint32_t frames) noexcept;
        float next() noexcept;
    };

    Voice* findVoiceForNote(int note) noexcept;
    Voice& allocateVoice() noexcept;
    void release(Voice& voice) noexcept;

    double sampleRate_ = 44100.0;
    float attackStep_ = 0.0f;
    float releaseStep_ = 0.0f;
    float decayFactor_ = 1.0f;
    uint32_t defaultRampFrames_ = 0;

    std::array<Voice, kMaxVoices> voices_{};
    uint64_t voiceCounter_ = 0;
    bool sustain_ = false;

    std::array<Ramp, kParameterCount> ramps_{};   // gain ramp is linear amplitude
    std::array<std::atomic<float>, kParameterCount> requested_{};
    std::array<std::atomic<float>, kParameterCount> applied_{};
    std::atomic<uint32_t> requestSerial_{0};
    uint32_t seenSerial_ = 0;
};

float decibelsToGain(float decibels) noexcept;

} // namespace pongping
