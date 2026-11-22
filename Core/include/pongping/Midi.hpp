// MIDI decoding shared by the plugin and the tests.
//
// Accepts MIDI 1.0 byte messages (AURenderEventMIDI) and Universal MIDI
// Packet words (AURenderEventMIDIEventList), normalises values to 0…1 and
// forwards them to a MidiSink. Real-time safe.
#pragma once

#include <cstddef>
#include <cstdint>

namespace pongping {

class HostProbe;

class MidiSink {
public:
    virtual ~MidiSink() = default;
    // velocity in (0, 1]
    virtual void noteOn(int note, float velocity) noexcept = 0;
    // release velocity in [0, 1]
    virtual void noteOff(int note, float velocity) noexcept = 0;
    // value in [0, 1]
    virtual void controlChange(int controller, float value) noexcept = 0;
    virtual void allNotesOff() noexcept = 0;
};

namespace midi {

// One MIDI 1.0 channel message (status byte first). Running status and
// system messages are ignored. Returns false if nothing was understood.
bool parseMidi1(const uint8_t* bytes, std::size_t length, MidiSink& sink,
                HostProbe* probe = nullptr) noexcept;

// A run of UMP words (one MIDIEventPacket). Handles MIDI 1.0 channel voice
// (message type 2) and MIDI 2.0 channel voice (message type 4); skips all
// other message types using the UMP size table.
void parseUmp(const uint32_t* words, std::size_t wordCount, MidiSink& sink,
              HostProbe* probe = nullptr) noexcept;

// UMP message size in 32-bit words for a given message type (0–15).
std::size_t umpWordCount(uint32_t messageType) noexcept;

} // namespace midi
} // namespace pongping
