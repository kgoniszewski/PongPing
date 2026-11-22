# Host facts — GarageBand on Mac mini M4

Filled in from the milestone 1 probe (procedure: [MILESTONE-1.md](MILESTONE-1.md)).
Raw reports go in `docs/probe/`.

Machine: Mac mini M4, 16 GB — macOS: _ — GarageBand: _

| Question (ARCHITECTURE.md §1) | Answer | Evidence |
|---|---|---|
| Sample rate delivered | _ | A: `format.sampleRate` |
| Buffer sizes while armed / live | _ | A, B: `render.frameSizes` |
| Buffer sizes during playback | _ | E |
| Buffer sizes per I/O setting | _ | F |
| Offline (export) buffer size; `renderingOffline` set? | _ | H |
| Render thread stable? | _ | `render.threadChanges` |
| Audio workgroup provided? Max parallel threads | _ | `workgroup.present`, `maxParallelThreads` |
| Event timing sample-accurate? | _ | `events.inBuffer` vs `immediate` |
| Velocity resolution (MIDI 1.0) | _ | C: `midi1DistinctVelocities` |
| MIDI 2.0 / 16-bit velocity when requested | _ | I: `midi2NoteOns`, `midi2HighResolutionVelocities` |
| Sustain pedal continuous? | _ | D: `sustainCC64.intermediateValues` |
| Automation: ramps, sample-accurate? | _ | G: `parameterRamp`, `maxRampFrames` |
| Automation: parameters GarageBand exposes / tolerates | _ | G: observation |
| Host process (in/out of process) | _ | `host.process` |
| Baseline load of the sine (avg / peak) | _ | B: `averageLoad`, `peakLoad` |

## Consequences for the plan

_Fill in after measuring: e.g. sample rate fixes the hammer oversampling
factor; buffer size sets the deadline for §4.3; workgroup presence decides
whether helper threads are possible; pedal resolution decides whether
half-pedalling is worth modelling now._
