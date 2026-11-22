#include "pongping/Midi.hpp"

#include "pongping/HostProbe.hpp"

namespace pongping::midi {

namespace {
constexpr int kControllerAllSoundOff = 120;
constexpr int kControllerAllNotesOff = 123;

void controller(int number, float value, MidiSink& sink) noexcept {
    if (number == kControllerAllSoundOff || number == kControllerAllNotesOff) {
        sink.allNotesOff();
    } else {
        sink.controlChange(number, value);
    }
}
} // namespace

std::size_t umpWordCount(uint32_t messageType) noexcept {
    static constexpr std::size_t kSizes[16] = {1, 1, 1, 2, 2, 4, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4};
    return kSizes[messageType & 0xF];
}

bool parseMidi1(const uint8_t* bytes, std::size_t length, MidiSink& sink,
                HostProbe* probe) noexcept {
    if (bytes == nullptr || length < 1) return false;
    const uint8_t status = bytes[0] & 0xF0;
    if (status < 0x80 || status == 0xF0) return false;
    const uint8_t data1 = length > 1 ? (bytes[1] & 0x7F) : 0;
    const uint8_t data2 = length > 2 ? (bytes[2] & 0x7F) : 0;

    switch (status) {
    case 0x90:
        if (length < 3) return false;
        if (data2 == 0) {
            sink.noteOff(data1, 0.0f);
        } else {
            if (probe) probe->recordMidi1NoteOn(data2);
            sink.noteOn(data1, data2 / 127.0f);
        }
        return true;
    case 0x80:
        if (length < 3) return false;
        sink.noteOff(data1, data2 / 127.0f);
        return true;
    case 0xB0:
        if (length < 3) return false;
        if (probe) probe->recordController(data1, HostProbe::upscale7to32(data2), false);
        controller(data1, data2 / 127.0f, sink);
        return true;
    default:
        return false;
    }
}

void parseUmp(const uint32_t* words, std::size_t wordCount, MidiSink& sink,
              HostProbe* probe) noexcept {
    std::size_t i = 0;
    while (i < wordCount) {
        const uint32_t w0 = words[i];
        const uint32_t type = w0 >> 28;
        const std::size_t size = umpWordCount(type);
        if (i + size > wordCount) return;   // truncated packet

        if (type == 0x2) {
            // MIDI 1.0 channel voice message carried in UMP.
            const uint8_t bytes[3] = {static_cast<uint8_t>(w0 >> 16),
                                      static_cast<uint8_t>((w0 >> 8) & 0x7F),
                                      static_cast<uint8_t>(w0 & 0x7F)};
            parseMidi1(bytes, 3, sink, probe);
        } else if (type == 0x4) {
            // MIDI 2.0 channel voice message.
            const uint32_t w1 = words[i + 1];
            const uint32_t opcode = (w0 >> 20) & 0xF;
            const int index = static_cast<int>((w0 >> 8) & 0x7F);
            switch (opcode) {
            case 0x9: {
                // In MIDI 2.0 a velocity of 0 is a real (very soft) note-on.
                const auto velocity = static_cast<uint16_t>(w1 >> 16);
                if (probe) probe->recordMidi2NoteOn(velocity);
                const float v = velocity == 0 ? 1.0f / 65535.0f : velocity / 65535.0f;
                sink.noteOn(index, v);
                break;
            }
            case 0x8:
                sink.noteOff(index, static_cast<uint16_t>(w1 >> 16) / 65535.0f);
                break;
            case 0xB:
                if (probe) probe->recordController(static_cast<uint8_t>(index), w1, true);
                controller(index, static_cast<float>(w1 / 4294967295.0), sink);
                break;
            default:
                break;
            }
        }
        i += size;
    }
}

} // namespace pongping::midi
