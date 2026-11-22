#include "pongping/SineKernel.hpp"

#include <algorithm>
#include <cmath>

namespace pongping {

namespace {
constexpr double kTwoPi = 6.283185307179586;
constexpr double kAttackSeconds = 0.003;
constexpr double kReleaseSeconds = 0.08;
constexpr double kDecaySeconds = 4.0;       // time constant of the natural fade
constexpr double kParameterRampSeconds = 0.02;
constexpr float kSilence = 1.0e-5f;         // -100 dB

float clampParameter(uint64_t address, float value) noexcept {
    const auto& info = kParameterInfo[address];
    return std::clamp(value, info.minimum, info.maximum);
}
} // namespace

float decibelsToGain(float decibels) noexcept {
    return std::pow(10.0f, decibels / 20.0f);
}

// ---- Ramp ----------------------------------------------------------------------

void SineKernel::Ramp::set(float value, uint32_t frames) noexcept {
    target = value;
    if (frames == 0) {
        current = value;
        remaining = 0;
        step = 0.0f;
    } else {
        remaining = frames;
        step = (target - current) / static_cast<float>(frames);
    }
}

float SineKernel::Ramp::next() noexcept {
    if (remaining > 0) {
        current += step;
        if (--remaining == 0) current = target;
    }
    return current;
}

// ---- Setup ----------------------------------------------------------------------

SineKernel::SineKernel() {
    for (uint64_t a = 0; a < kParameterCount; ++a) {
        const float v = kParameterInfo[a].defaultValue;
        requested_[a].store(v, std::memory_order_relaxed);
        applied_[a].store(v, std::memory_order_relaxed);
    }
    ramps_[kParameterGain].set(decibelsToGain(kParameterInfo[kParameterGain].defaultValue), 0);
    ramps_[kParameterBrightness].set(kParameterInfo[kParameterBrightness].defaultValue, 0);
    prepare(sampleRate_);
}

void SineKernel::prepare(double sampleRate) noexcept {
    sampleRate_ = sampleRate > 0.0 ? sampleRate : 44100.0;
    attackStep_ = static_cast<float>(1.0 / (kAttackSeconds * sampleRate_));
    releaseStep_ = static_cast<float>(1.0 / (kReleaseSeconds * sampleRate_));
    decayFactor_ = static_cast<float>(std::exp(-1.0 / (kDecaySeconds * sampleRate_)));
    defaultRampFrames_ = static_cast<uint32_t>(kParameterRampSeconds * sampleRate_);
    reset();
}

void SineKernel::reset() noexcept {
    for (auto& v : voices_) v = Voice{};
    sustain_ = false;
}

// ---- Parameters -------------------------------------------------------------------

void SineKernel::requestParameter(uint64_t address, float value) noexcept {
    if (address >= kParameterCount) return;
    value = clampParameter(address, value);
    requested_[address].store(value, std::memory_order_relaxed);
    applied_[address].store(value, std::memory_order_relaxed);
    requestSerial_.fetch_add(1, std::memory_order_release);
}

float SineKernel::parameterValue(uint64_t address) const noexcept {
    if (address >= kParameterCount) return 0.0f;
    return applied_[address].load(std::memory_order_relaxed);
}

void SineKernel::setParameter(uint64_t address, float value, uint32_t rampFrames) noexcept {
    if (address >= kParameterCount) return;
    value = clampParameter(address, value);
    applied_[address].store(value, std::memory_order_relaxed);
    const float internal = address == kParameterGain ? decibelsToGain(value) : value;
    ramps_[address].set(internal, rampFrames);
}

void SineKernel::beginBlock() noexcept {
    const uint32_t serial = requestSerial_.load(std::memory_order_acquire);
    if (serial == seenSerial_) return;
    seenSerial_ = serial;
    for (uint64_t a = 0; a < kParameterCount; ++a) {
        const float value = requested_[a].load(std::memory_order_relaxed);
        const float internal = a == kParameterGain ? decibelsToGain(value) : value;
        if (internal != ramps_[a].target) ramps_[a].set(internal, defaultRampFrames_);
    }
}

// ---- Notes --------------------------------------------------------------------------

SineKernel::Voice* SineKernel::findVoiceForNote(int note) noexcept {
    for (auto& v : voices_) {
        if (v.stage != Stage::Idle && v.note == note) return &v;
    }
    return nullptr;
}

SineKernel::Voice& SineKernel::allocateVoice() noexcept {
    Voice* best = nullptr;
    for (auto& v : voices_) {
        if (v.stage == Stage::Idle) return v;
        // Prefer stealing a releasing voice, then the oldest.
        if (best == nullptr ||
            (v.stage == Stage::Release && best->stage != Stage::Release) ||
            ((v.stage == Stage::Release) == (best->stage == Stage::Release) &&
             v.startOrder < best->startOrder)) {
            best = &v;
        }
    }
    return *best;
}

void SineKernel::noteOn(int note, float velocity) noexcept {
    if (note < 0 || note > 127) return;
    // Re-striking a sounding key reuses its voice, like a real string.
    Voice* voice = findVoiceForNote(note);
    if (voice == nullptr) {
        voice = &allocateVoice();
        voice->phase = 0.0;
        voice->level = 0.0f;
    }
    const double frequency = 440.0 * std::pow(2.0, (note - 69) / 12.0);
    voice->note = note;
    voice->increment = frequency / sampleRate_;
    velocity = std::clamp(velocity, 0.0f, 1.0f);
    voice->peak = 0.3f * velocity * velocity;
    voice->stage = Stage::Attack;
    voice->keyDown = true;
    voice->sustained = false;
    voice->startOrder = ++voiceCounter_;
}

void SineKernel::release(Voice& voice) noexcept {
    voice.stage = Stage::Release;
    voice.sustained = false;
}

void SineKernel::noteOff(int note, float) noexcept {
    for (auto& v : voices_) {
        if (v.stage == Stage::Idle || v.note != note || !v.keyDown) continue;
        v.keyDown = false;
        if (sustain_) {
            v.sustained = true;
        } else {
            release(v);
        }
    }
}

void SineKernel::controlChange(int controller, float value) noexcept {
    if (controller != 64) return;
    const bool down = value >= 0.5f;
    if (down == sustain_) return;
    sustain_ = down;
    if (!down) {
        for (auto& v : voices_) {
            if (v.stage != Stage::Idle && v.sustained) release(v);
        }
    }
}

void SineKernel::allNotesOff() noexcept {
    for (auto& v : voices_) {
        if (v.stage != Stage::Idle) {
            v.keyDown = false;
            release(v);
        }
    }
    sustain_ = false;
}

int SineKernel::activeVoiceCount() const noexcept {
    int n = 0;
    for (const auto& v : voices_) n += v.stage != Stage::Idle;
    return n;
}

// ---- Render ---------------------------------------------------------------------------

void SineKernel::render(float* const* channels, int channelCount, int frames) noexcept {
    if (frames <= 0 || channelCount <= 0) return;
    float* left = channels[0];
    std::fill(left, left + frames, 0.0f);

    for (auto& v : voices_) {
        if (v.stage == Stage::Idle) continue;
        for (int i = 0; i < frames; ++i) {
            switch (v.stage) {
            case Stage::Attack:
                v.level += attackStep_ * v.peak;
                if (v.level >= v.peak) {
                    v.level = v.peak;
                    v.stage = Stage::Hold;
                }
                break;
            case Stage::Hold:
                v.level *= decayFactor_;
                break;
            case Stage::Release:
                v.level -= releaseStep_ * v.peak;
                break;
            case Stage::Idle:
                break;
            }
            if (v.stage != Stage::Attack && v.level <= kSilence) {
                v = Voice{};   // finished: free the voice
                break;
            }
            left[i] += v.level * static_cast<float>(std::sin(kTwoPi * v.phase));
            v.phase += v.increment;
            if (v.phase >= 1.0) v.phase -= 1.0;
        }
    }

    // Brightness: an odd waveshaper (x·|x|) adds 3rd, 5th, … harmonics.
    // Gain: linear ramp. Both are sample-accurate.
    auto& gain = ramps_[kParameterGain];
    auto& brightness = ramps_[kParameterBrightness];
    for (int i = 0; i < frames; ++i) {
        const float x = left[i];
        const float b = brightness.next();
        const float shaped = x + b * 2.0f * x * std::fabs(x);
        left[i] = gain.next() * shaped;
    }
    for (int c = 1; c < channelCount; ++c) {
        std::copy(left, left + frames, channels[c]);
    }
}

} // namespace pongping
