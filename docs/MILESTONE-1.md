# Milestone 1 — Skeleton AUv3 in GarageBand

Goal (ARCHITECTURE.md §8): a working AUv3 instrument in GarageBand on the Mac
mini M4 that plays a placeholder sine, and numbers for every question in
ARCHITECTURE.md §1 "Host facts to confirm".

Done when the table in [host-facts.md](host-facts.md) is filled in.

## What is in the repository

| Path | What |
|---|---|
| `Core/` | Platform-independent C++23: `SineKernel` (placeholder instrument), MIDI 1.0 / UMP parsing, `HostProbe` (lock-free recorder of host behaviour), tests. Builds anywhere with CMake. |
| `Kit/` | `PongPingKit.framework`: the `AUAudioUnit` subclass (Objective-C++), its view controller / factory, and the SwiftUI probe view. |
| `Extension/` | The AUv3 app extension (`aumu`, subtype `Pnpg`, manufacturer `Pgpg`). Code lives in the framework. |
| `App/` | Container app. Registers the extension and hosts the plugin in-process with a small keyboard for quick checks. |
| `project.yml` | XcodeGen spec; the `.xcodeproj` is generated. |

The placeholder instrument: 16-voice sine with velocity, sustain pedal and two
automatable parameters (Gain, Brightness). It exists to prove the plumbing,
not to sound like a piano.

## Build

Requirements: Xcode (16 or later), Homebrew, an Apple ID signed into Xcode
(a free personal team is enough for local use).

```sh
brew install xcodegen cmake
cd PongPing
xcodegen generate
open PongPing.xcodeproj
```

In Xcode:

1. Select each of the three targets → *Signing & Capabilities* → choose your
   team. (Or set `DEVELOPMENT_TEAM` in `project.yml` once and regenerate.)
2. If you change `PONGPING_BUNDLE_PREFIX` in `project.yml`, regenerate; the
   extension's Info.plist follows it.
3. Scheme **PongPing**, destination **My Mac** → *Run* (⌘R).

The app window should say "Loaded in-process"; clicking the keys plays sines
and the probe panel fills in. This confirms the audio unit works before
GarageBand is involved.

Audio unit tests: scheme **PongPingKit** → *Test* (⌘U). They load the plugin
in-process, render offline, and check pitch, note-off, sustain, the Gain
parameter and the probe report.

Core tests (optional, also run in CI):

```sh
cmake -S Core -B Core/build && cmake --build Core/build && ctest --test-dir Core/build
```

## Install for GarageBand

The quickest path is the script, which does everything below (build inside
`./build` regardless of Xcode's Locations settings, raise the plugin version,
self-test, install, register, `auval`):

```sh
scripts/install.sh --test        # ad-hoc signed
scripts/install.sh --team ABC123 # or signed with your Apple ID team
scripts/install.sh --midi2       # probe step I
```

Manual steps, for reference:

1. *Product → Archive* is not needed. Copy the built app to `/Applications`:
   *Product → Show Build Folder in Finder* → `Products/Debug/PongPing.app`.
2. Launch `/Applications/PongPing.app` once and quit it. This registers the
   extension.
3. Check registration:
   ```sh
   pluginkit -m -v -p com.apple.AudioUnit-UI | grep -i pongping
   auval -v aumu Pnpg Pgpg
   ```
   `auval` must end with `AU VALIDATION SUCCEEDED`.
4. Open GarageBand → new project → *Software Instrument* track → in the Smart
   Controls / Library area choose *Plug-ins* → *Audio Units* → **PongPing →
   Piano**.

If GarageBand does not list it: quit GarageBand, run
`killall -9 AudioComponentRegistrar`, relaunch. After rebuilding, increment
`version` in `Extension/Info.plist` (the `AudioComponents` entry) so hosts
rescan the plugin.

## Measurement protocol

Open the plugin's window in GarageBand: it shows the probe live. The full
report is also written every 2 s to

```
~/Library/Containers/com.pongping.PongPing.PongPingExtension/Data/Library/Application Support/PongPing/host-probe.json
```

(the path is shown at the bottom of the plugin window; it differs if you
changed the bundle prefix). Press **Reset** in the plugin window before each
step so its numbers belong to that step only, then **Copy report** after it
and save the text as `docs/probe/<step>.json`.

| Step | Do this | Answers |
|---|---|---|
| A. Idle armed | Record-arm the track, play nothing for 10 s | Sample rate, buffer size while armed, workgroup, render thread stability |
| B. Playing | Play for 30 s: soft and loud notes, fast repeats, chords | Buffer sizes while live, load, event timing |
| C. Velocity | Play one key ~40 times from the softest to the hardest touch you can | Velocity resolution (distinct values, MIDI 1 vs MIDI 2) |
| D. Pedal | Press the sustain pedal down slowly over ~3 s and release slowly; then try half-pedal | Continuous pedal or on/off |
| E. Playback | Record a short take, stop, reset probe, play the take back | Buffer size during playback (often larger than live) |
| F. Buffer setting | GarageBand → Settings → Audio/MIDI → I/O Buffer Size: repeat A at each available size | Which sizes the host actually uses |
| G. Automation | Show automation (A), add Gain and Brightness lanes with a few points and ramps, play back | Whether automation arrives as sample-accurate ramps; how many parameters GarageBand exposes |
| H. Export | *Share → Export Song to Disk* | Offline rendering flag and offline buffer size |
| I. MIDI 2.0 | Rebuild with `PONGPING_REQUEST_MIDI2=1` (Build Settings → Preprocessor Macros on PongPingKit), bump the plugin `version`, repeat C and D | Whether GarageBand delivers UMP / 16-bit velocity when asked |

For G, also note in host-facts.md how GarageBand presents the parameter list
(all parameters, or a subset), since the real plugin will expose tens of them.

For a keyboard without a pedal, step D can be skipped; note that in the table.

## Reading the report

- `probe.format.sampleRate`, `probe.render.frameSizes` (`{"size": count}`),
  `minFrames` / `maxFrames`.
- `probe.render.averageLoad` / `peakLoad`: render time ÷ audio time for the
  sine. Expect well under 1 %. This is the baseline milestone 2 builds on.
- `probe.render.threadChanges`: how often the host switched render threads.
- `probe.workgroup.present`, `maxParallelThreads`: whether helper threads
  could join the host's workgroup (ARCHITECTURE.md §4.2).
- `probe.events`: `inBuffer` means sample-accurate timestamps; `immediate`
  means the host sends events without timing.
- `probe.midi.midi1DistinctVelocities`: up to 127 for MIDI 1.0.
  `midi2HighResolutionVelocities` > 0 means true 16-bit velocity arrived.
- `probe.midi.sustainCC64.intermediateValues` > 0 means the pedal is
  continuous (half-pedalling possible); 0 means on/off only.
- `host.hostMIDIProtocol`: 1 = MIDI 1.0, 2 = MIDI 2.0, 0 = not set by host.
- `host.process`: the process the plugin runs in (GarageBand loads AUv3
  out-of-process, so expect an `AUHostingService`-style name).

Logs: `log stream --predicate 'subsystem == "com.pongping.audiounit"' --info`

## Known limits

- Swift is compiled in Swift 5 language mode for now; moving to Swift 6
  strict concurrency is deferred until the UI grows (no Mac was available to
  iterate on concurrency diagnostics while writing this milestone).
- The render-context observer queries `os_workgroup_max_parallel_threads` on
  the render thread. Acceptable for the probe; to be revisited when helper
  threads are added.
