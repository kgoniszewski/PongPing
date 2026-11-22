// Core tests. Dependency-free: run `pongping_tests`, exit code 0 = pass.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <string>
#include <vector>

#include "pongping/HostProbe.hpp"
#include "pongping/Midi.hpp"
#include "pongping/SineKernel.hpp"

// ---- Allocation tracking ------------------------------------------------------
// Counts every heap allocation so tests can assert the render path makes none.
static thread_local long gAllocations = 0;

void* operator new(std::size_t size) {
    ++gAllocations;
    if (void* p = std::malloc(size ? size : 1)) return p;
    throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

// ---- Minimal harness --------------------------------------------------------------
static int gFailures = 0;
static int gChecks = 0;

#define CHECK(cond)                                                                 \
    do {                                                                            \
        ++gChecks;                                                                  \
        if (!(cond)) {                                                              \
            ++gFailures;                                                            \
            std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
        }                                                                           \
    } while (0)

#define CHECK_NEAR(a, b, tol) CHECK(std::fabs(double(a) - double(b)) <= double(tol))

using namespace pongping;

namespace {

constexpr double kRate = 48000.0;

struct Buffer {
    std::vector<float> left, right;
    explicit Buffer(int frames) : left(frames), right(frames) {}
    float* ptrs[2];
    float* const* channels(int offset = 0) {
        ptrs[0] = left.data() + offset;
        ptrs[1] = right.data() + offset;
        return ptrs;
    }
};

double rms(const float* x, int n) {
    double s = 0;
    for (int i = 0; i < n; ++i) s += double(x[i]) * x[i];
    return std::sqrt(s / n);
}

// Frequency estimated from positive-going zero crossings.
double estimateFrequency(const float* x, int n, double rate) {
    int first = -1, last = -1, crossings = 0;
    for (int i = 1; i < n; ++i) {
        if (x[i - 1] < 0.0f && x[i] >= 0.0f) {
            if (first < 0) first = i; else ++crossings;
            last = i;
        }
    }
    if (crossings == 0) return 0.0;
    return crossings * rate / (last - first);
}

void noteOn(SineKernel& k, int note, int velocity) {
    const uint8_t m[3] = {0x90, uint8_t(note), uint8_t(velocity)};
    midi::parseMidi1(m, 3, k);
}
void noteOff(SineKernel& k, int note) {
    const uint8_t m[3] = {0x80, uint8_t(note), 0};
    midi::parseMidi1(m, 3, k);
}
void sustain(SineKernel& k, bool down) {
    const uint8_t m[3] = {0xB0, 64, uint8_t(down ? 127 : 0)};
    midi::parseMidi1(m, 3, k);
}

// ---- Kernel ------------------------------------------------------------------------

void testFrequencyAndStereo() {
    SineKernel k;
    k.prepare(kRate);
    k.setParameter(kParameterGain, 0.0f, 0);
    noteOn(k, 69, 100);
    const int n = 48000;
    Buffer b(n);
    k.beginBlock();
    k.render(b.channels(), 2, n);
    CHECK_NEAR(estimateFrequency(b.left.data(), n, kRate), 440.0, 0.5);
    CHECK(b.left == b.right);
    CHECK(rms(b.left.data(), n) > 0.05);
}

void testVelocityScalesLevel() {
    auto level = [](int velocity) {
        SineKernel k;
        k.prepare(kRate);
        noteOn(k, 60, velocity);
        Buffer b(4800);
        k.render(b.channels(), 2, 4800);
        return rms(b.left.data() + 2400, 2400);
    };
    const double soft = level(20), loud = level(120);
    CHECK(loud > soft * 10.0);
}

void testNoteOffReleasesAndFreesVoice() {
    SineKernel k;
    k.prepare(kRate);
    noteOn(k, 60, 100);
    Buffer b(4800);
    k.render(b.channels(), 2, 4800);
    CHECK(k.activeVoiceCount() == 1);
    noteOff(k, 60);
    k.render(b.channels(), 2, 4800);   // 100 ms > 80 ms release
    CHECK(k.activeVoiceCount() == 0);
    CHECK(rms(b.left.data() + 4000, 800) == 0.0);
}

void testNoteOnVelocityZeroIsNoteOff() {
    SineKernel k;
    k.prepare(kRate);
    noteOn(k, 60, 100);
    noteOn(k, 60, 0);
    Buffer b(4800);
    k.render(b.channels(), 2, 4800);
    CHECK(k.activeVoiceCount() == 0);
}

void testSustainPedalHoldsNotes() {
    SineKernel k;
    k.prepare(kRate);
    sustain(k, true);
    noteOn(k, 60, 100);
    noteOff(k, 60);
    Buffer b(9600);
    k.render(b.channels(), 2, 9600);
    CHECK(k.activeVoiceCount() == 1);
    CHECK(rms(b.left.data() + 8000, 1600) > 0.01);
    sustain(k, false);
    k.render(b.channels(), 2, 9600);
    CHECK(k.activeVoiceCount() == 0);
}

void testRestrikeReusesVoice() {
    SineKernel k;
    k.prepare(kRate);
    noteOn(k, 60, 100);
    noteOn(k, 60, 100);
    CHECK(k.activeVoiceCount() == 1);
}

void testVoiceStealing() {
    SineKernel k;
    k.prepare(kRate);
    for (int n = 0; n < SineKernel::kMaxVoices + 4; ++n) noteOn(k, 40 + n, 100);
    CHECK(k.activeVoiceCount() == SineKernel::kMaxVoices);
}

void testAllNotesOff() {
    SineKernel k;
    k.prepare(kRate);
    sustain(k, true);
    for (int n = 0; n < 5; ++n) noteOn(k, 60 + n, 100);
    const uint8_t m[3] = {0xB0, 123, 0};
    midi::parseMidi1(m, 3, k);
    Buffer b(9600);
    k.render(b.channels(), 2, 9600);
    CHECK(k.activeVoiceCount() == 0);
    CHECK(!k.sustainDown());
}

void testGainParameterRampsSampleAccurately() {
    SineKernel k;
    k.prepare(kRate);
    k.setParameter(kParameterGain, 0.0f, 0);
    noteOn(k, 69, 127);
    Buffer b(9600);
    k.render(b.channels(), 2, 4800);
    const double before = rms(b.left.data() + 2400, 2400);
    k.setParameter(kParameterGain, -20.0f, 480);
    k.render(b.channels(4800), 2, 4800);
    const double after = rms(b.left.data() + 4800 + 2400, 2400);
    CHECK_NEAR(after / before, 0.1, 0.01);
    CHECK_NEAR(k.parameterValue(kParameterGain), -20.0f, 1e-6);
}

void testRequestedParameterAppliesAtBlockStart() {
    SineKernel k;
    k.prepare(kRate);
    k.requestParameter(kParameterGain, -12.0f);
    CHECK_NEAR(k.parameterValue(kParameterGain), -12.0f, 1e-6);
    k.requestParameter(kParameterGain, 100.0f);   // clamped
    CHECK_NEAR(k.parameterValue(kParameterGain), 6.0f, 1e-6);
    noteOn(k, 69, 127);
    k.beginBlock();
    Buffer b(4800);
    k.render(b.channels(), 2, 4800);
    CHECK(rms(b.left.data(), 4800) > 0.0);
}

void testBrightnessAddsHarmonics() {
    auto harmonicEnergy = [](float brightness) {
        SineKernel k;
        k.prepare(kRate);
        k.setParameter(kParameterBrightness, brightness, 0);
        noteOn(k, 57, 127);   // 220 Hz
        const int n = 4800;
        Buffer b(n);
        k.render(b.channels(), 2, n);
        // Correlation at 660 Hz (3rd harmonic).
        double re = 0, im = 0;
        for (int i = 0; i < n; ++i) {
            re += b.left[i] * std::cos(6.283185307 * 660.0 * i / kRate);
            im += b.left[i] * std::sin(6.283185307 * 660.0 * i / kRate);
        }
        return std::sqrt(re * re + im * im) / n;
    };
    CHECK(harmonicEnergy(1.0f) > 10.0 * harmonicEnergy(0.0f) + 1e-4);
}

void testRenderDoesNotAllocate() {
    SineKernel k;
    HostProbe probe;
    k.prepare(kRate);
    Buffer b(512);
    const long before = gAllocations;
    for (int block = 0; block < 200; ++block) {
        k.beginBlock();
        if (block % 10 == 0) noteOn(k, 40 + block / 10, 90);
        if (block % 25 == 0) sustain(k, block % 50 == 0);
        k.setParameter(kParameterGain, -6.0f - block % 3, 64);
        k.render(b.channels(), 2, 512);
        probe.recordRender(512, 1000 + block, false);
        probe.recordMidi1NoteOn(uint8_t(block % 128));
        probe.recordController(64, HostProbe::upscale7to32(uint8_t(block % 128)), false);
        probe.recordEventTiming(HostProbe::EventTiming::InBuffer);
    }
    CHECK(gAllocations == before);
}

// ---- MIDI ---------------------------------------------------------------------------

struct RecordingSink : MidiSink {
    std::vector<std::string> log;
    void noteOn(int note, float v) noexcept override {
        log.push_back("on " + std::to_string(note) + " " + std::to_string(v));
    }
    void noteOff(int note, float) noexcept override { log.push_back("off " + std::to_string(note)); }
    void controlChange(int c, float v) noexcept override {
        log.push_back("cc " + std::to_string(c) + " " + std::to_string(v));
    }
    void allNotesOff() noexcept override { log.push_back("all off"); }
};

void testUmpMidi2NoteAndController() {
    RecordingSink sink;
    HostProbe probe;
    const uint32_t words[] = {
        0x40903C00u, 0x80000000u,   // MIDI 2.0 note on, note 60, velocity 0x8000
        0x40B04000u, 0x40000000u,   // MIDI 2.0 CC 64 = 0x40000000 (quarter: half-pedal)
        0x10F80000u,                // system real-time (1 word), skipped
        0x40803C00u, 0x00000000u,   // MIDI 2.0 note off
        0x20903E7Fu,                // MIDI 1.0 in UMP: note on 62 velocity 127
    };
    midi::parseUmp(words, std::size(words), sink, &probe);
    CHECK(sink.log.size() == 4);
    CHECK(sink.log[0] == "on 60 " + std::to_string(0x8000 / 65535.0f));
    CHECK(sink.log[1].rfind("cc 64 0.25", 0) == 0);
    CHECK(sink.log[2] == "off 60");
    CHECK(sink.log[3] == "on 62 1.000000");

    const std::string json = probe.toJSON();
    CHECK(json.find("\"midi2NoteOns\":1") != std::string::npos);
    CHECK(json.find("\"midi1NoteOns\":1") != std::string::npos);
    // 0x8000 is exactly the upscale of 7-bit 64, so it is not "high resolution".
    CHECK(json.find("\"midi2HighResolutionVelocities\":0") != std::string::npos);
    // 0x40000000 is the upscale of 7-bit 32 -> not high resolution, but intermediate.
    CHECK(json.find("\"sustainCC64\":{\"messages\":1,\"midi2Messages\":1,\"distinct7BitValues\":1,"
                    "\"intermediateValues\":1,\"highResolutionValues\":0}") != std::string::npos);
}

void testUmpHighResolutionDetected() {
    RecordingSink sink;
    HostProbe probe;
    const uint32_t words[] = {0x40903C00u, 0x80010000u, 0x40B04000u, 0x40000123u};
    midi::parseUmp(words, std::size(words), sink, &probe);
    const std::string json = probe.toJSON();
    CHECK(json.find("\"midi2HighResolutionVelocities\":1") != std::string::npos);
    CHECK(json.find("\"highResolutionValues\":1") != std::string::npos);
}

void testUmpTruncatedPacketIsIgnored() {
    RecordingSink sink;
    const uint32_t words[] = {0x40903C00u};   // missing second word
    midi::parseUmp(words, 1, sink);
    CHECK(sink.log.empty());
}

void testUpscaling() {
    CHECK(HostProbe::upscale7to16(0) == 0);
    CHECK(HostProbe::upscale7to16(64) == 0x8000);
    CHECK(HostProbe::upscale7to16(127) == 0xFFFF);
    CHECK(HostProbe::upscale7to32(64) == 0x80000000u);
    CHECK(HostProbe::upscale7to32(127) == 0xFFFFFFFFu);
    for (int v = 1; v < 128; ++v) {
        CHECK(HostProbe::upscale7to16(uint8_t(v)) > HostProbe::upscale7to16(uint8_t(v - 1)));
        CHECK(HostProbe::upscale7to32(uint8_t(v)) > HostProbe::upscale7to32(uint8_t(v - 1)));
    }
}

// ---- Probe ---------------------------------------------------------------------------

void testProbeRenderStatistics() {
    HostProbe p;
    p.recordFormat(44100.0, 2, 4096);
    for (int i = 0; i < 10; ++i) p.recordRender(512, 1000000, false);   // 1 ms per 11.6 ms
    p.recordRender(128, 500000, true);
    p.recordRenderThread(7);
    p.recordRenderThread(7);
    p.recordRenderThread(9);
    p.recordWorkgroup(true, 4);
    p.recordParameterEvent(true, 256);
    const std::string j = p.toJSON();
    CHECK(j.find("\"sampleRate\":44100") != std::string::npos);
    CHECK(j.find("\"calls\":11") != std::string::npos);
    CHECK(j.find("\"offlineCalls\":1") != std::string::npos);
    CHECK(j.find("\"minFrames\":128,\"maxFrames\":512") != std::string::npos);
    CHECK(j.find("\"frameSizes\":{\"512\":10,\"128\":1}") != std::string::npos);
    CHECK(j.find("\"threadChanges\":1") != std::string::npos);
    CHECK(j.find("\"present\":true,\"maxParallelThreads\":4") != std::string::npos);
    CHECK(j.find("\"maxRampFrames\":256") != std::string::npos);
    p.reset();
    const std::string r = p.toJSON();
    CHECK(r.find("\"calls\":0") != std::string::npos);
    CHECK(r.find("\"frameSizes\":{}") != std::string::npos);
    CHECK(r.find("\"sampleRate\":44100") != std::string::npos);   // setup survives reset
}

void testProbeFrameSizeOverflow() {
    HostProbe p;
    for (uint32_t f = 1; f <= HostProbe::kFrameSizeSlots + 3; ++f) p.recordRender(f, 10, false);
    CHECK(p.toJSON().find("\"frameSizeOverflow\":3") != std::string::npos);
}

} // namespace

int main() {
    testFrequencyAndStereo();
    testVelocityScalesLevel();
    testNoteOffReleasesAndFreesVoice();
    testNoteOnVelocityZeroIsNoteOff();
    testSustainPedalHoldsNotes();
    testRestrikeReusesVoice();
    testVoiceStealing();
    testAllNotesOff();
    testGainParameterRampsSampleAccurately();
    testRequestedParameterAppliesAtBlockStart();
    testBrightnessAddsHarmonics();
    testRenderDoesNotAllocate();
    testUmpMidi2NoteAndController();
    testUmpHighResolutionDetected();
    testUmpTruncatedPacketIsIgnored();
    testUpscaling();
    testProbeRenderStatistics();
    testProbeFrameSizeOverflow();

    std::printf("%d checks, %d failures\n", gChecks, gFailures);
    return gFailures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
