# PongPing — Architecture Plan (revised)

A physically modelled grand piano with no audio samples, delivered as an
Audio Unit v3 instrument for GarageBand on one machine.

This revision replaces the original plan. Section 10 lists what changed and why.

## 1. Scope

| | In scope | Out of scope |
|---|---|---|
| Hardware | Mac mini, M4 (4 performance + 6 efficiency cores), 16 GB | Any other Mac, Intel, iOS |
| OS | macOS 27 | Older macOS, other operating systems |
| Host | GarageBand for macOS | Logic, Live, Cubase, VST3, CLAP, AAX |
| Format | AUv3 instrument (`aumu`) in an app extension | Standalone performance app |
| Input | MIDI 1.0 note, velocity, sustain/sostenuto/una corda | Continuous key-position sensing |

AUv3 extensions must ship inside a containing app. That app stays a thin shell:
it installs the extension and hosts it in-process for development, profiling
and automated tests. It is not a product surface.

### Host facts to confirm in milestone 1

These shape the engine, so they are measured before anything is built on them:

- Sample rate GarageBand delivers (expected: 44.1 kHz, fixed).
- Render buffer sizes GarageBand uses while a track is armed and while it plays back.
- Whether GarageBand hands the extension an audio workgroup
  (`AUAudioUnit.renderContextObserver`) so helper threads can join it.
- Velocity resolution delivered (expected: 7-bit MIDI 1.0) and whether pedal
  controllers arrive as continuous values (needed for half-pedalling).
- Which plugin parameters GarageBand can automate, and how many it tolerates.

## 2. Synthesis approach

**Linear modal synthesis with offline-solved coupling, plus targeted
nonlinear stages.**

Each string is a bank of second-order resonators, one per partial. Everything
linear and expensive about the instrument — how strings of one note couple
through the bridge, how the soundboard colours and radiates them — is solved
ahead of time by a *presynthesis* step and baked into resonator frequencies,
decay rates and gains. The audio thread then runs independent resonators,
which is cheap, stable and vectorises well. Nonlinear behaviour that cannot be
precomputed (hammer contact, string tension effects) runs in the time domain
only where and when it is audible.

Why not the alternatives:

- **Full finite-element / finite-difference simulation**: orders of magnitude
  too slow in real time. Used offline as the source of soundboard modes.
- **Digital waveguides**: cheap, but dispersion filters make per-partial
  control and nonlinear coupling awkward.
- **Neural synthesis at runtime**: adds latency and removes physical editing.
  Differentiable models are used offline for calibration only.
- **Fully coupled runtime network** (strings ↔ bridge ↔ soundboard exchanging
  force every sample): physically direct, but it forbids block processing and
  parallelism, and any delay in the loop corrupts the coupling. At 44.1 kHz a
  32-sample delay is already ~105° of phase lag at 440 Hz, enough to turn a
  lossy bridge into an energy source.

## 3. The instrument model

There are no "voices". The model has one resonator bank per physical string,
about 240 strings across 88 notes, and every one of them exists all the time.
Striking a ringing string adds energy to it; holding the sustain pedal leaves
all of them free to ring. The worst case is therefore fixed and known: all
strings live.

### 3.1 Presynthesis (off the audio thread)

Turns physical parameters into runtime tables. Three tiers by cost:

| Tier | Examples | Cost | Handling |
|---|---|---|---|
| Instant | Tuning, unison detune, hammer hardness, strike point, mic gains | < 20 ms | Recomputed on every edit |
| Slow | Soundboard thickness, ribbing, bridge position | Seconds to minutes | Background job on efficiency cores, result cached on disk by parameter hash |
| Shipped | Reference soundboard mode sets | — | Precomputed, bundled |

Steps:

1. **String partials.** From length, diameter, tension, density and stiffness,
   compute inharmonicity `B` and partial frequencies
   `f_k = k·f0·sqrt(1 + B·k²)` up to 20 kHz.
2. **Soundboard modes.** Eigenmodes of the ribbed orthotropic plate (sparse
   eigen-solve on the CPU via Accelerate), giving mode frequencies, losses,
   and shapes sampled at each bridge point and at the radiating surface.
3. **Bridge admittance.** From the soundboard modes, the 2×2 admittance
   (vertical and horizontal motion) seen by each string at its bridge point,
   across the full band.
4. **Choir coupling, solved offline.** For each note and each partial, the
   note's 1–3 strings × 2 polarisations coupled through that admittance form
   an eigenproblem of at most 6×6. Its solutions are the true coupled modes:
   slightly split frequencies and distinct decay rates. This is what produces
   unison beating, the fast-then-slow two-stage decay, and correct una corda
   behaviour (the unstruck string is driven through the bridge) — with no
   runtime feedback loop.
5. **Radiation gains.** Per soundboard mode and per microphone, a complex gain
   from integrating the mode shape toward the mic position, including the lid.

Output is an immutable snapshot handed to the audio thread through a lock-free
triple buffer. Old snapshots are recycled off the audio thread.

Applying a new snapshot without clicks:

- String tables take effect per string at its next strike, or by a short
  coefficient ramp when only frequencies/decays moved slightly.
- A changed soundboard mode set cannot be ramped. Two soundboard instances run
  briefly and their outputs are crossfaded.

### 3.2 Hammer and action

- **Action** is a mapping, not a simulation: MIDI velocity → hammer velocity
  through a calibrated curve. MIDI carries no key position, so key inertia and
  let-off are not modelled. Fast repetition needs no special case because the
  string keeps its state between strikes.
- **Hammer–string contact** uses the hysteretic felt law
  `F = K·[Δy]₊^p + R·d/dt([Δy]₊^p)`, with mass, stiffness, loss and exponent
  varying across the keyboard. It is solved only during contact (1–4 ms), at
  2× the host rate, with a non-iterative energy-stable scheme (scalar
  auxiliary variable). The resonators use the rotation form
  (`u' = a·u − b·v + f`, `v' = b·u + a·v`), whose state is independent of
  sample rate, so switching rate for the contact window is clean.
- **Dampers** add loss to each partial in proportion to damper engagement and
  the partial's amplitude at the damper position. Engagement is continuous,
  which gives half-pedalling, sostenuto and silently held keys.
- **Mechanical noise** (key thump, damper lift, pedal) is synthesised from
  short filtered-noise and resonator bursts scaled by velocity.

### 3.3 Strings

- Coupled modes from step 4, stored per string as contiguous
  structure-of-arrays blocks, 64-byte aligned, single precision.
- Partials are ordered by frequency and high ones die first, so each string
  keeps an active count that shrinks as partials fall below −110 dB. Strings
  with nothing audible sleep and wake on strike or sympathetic drive.
- **Duplex segments** are short extra banks on the notes that have them.
- **Nonlinear effects**, added after the linear instrument sounds right:
  - *Phantom partials*: longitudinal response driven by products of
    transverse partials. Cost grows with the square of partial count, so it is
    limited to the lower ~40 notes, to partial pairs whose sum stays below
    Nyquist, and to strikes above an amplitude threshold.
  - *Pitch glide* from tension modulation: coefficient updates once per
    sub-block, on struck strings only, while amplitude is high.

### 3.4 Sympathetic resonance

A one-way bus, processed in fixed 32-sample sub-blocks:

1. Struck and sounding strings render and sum their bridge force onto the bus.
2. The bus drives every undamped string that is not itself struck.

Energy fed back from sympathetic strings into the bus is second-order and is
omitted in the first version. If listening tests show it matters, it is added
with a one-sub-block delay and a gain bound that keeps the loop passive.

### 3.5 Soundboard and microphones

- **Low and mid band**: explicit soundboard modes, driven by each string's
  force weighted by the mode shape at its bridge point. Because mode shapes
  differ across the board, each note radiates with its own spatial signature.
  Target is 400–600 modes reaching ~3 kHz (the original plan's 120–200 to
  1.5 kHz is the fallback).
- **High band**: one-way radiation filters (fixed-pole parallel second-order
  sections) fitted to the computed response. Bridge losses in this band are
  already inside the per-partial decay rates from presynthesis.
- **Microphones**: up to 5, positioned in 3D, omni / cardioid / figure-8.
  Each is a row of the radiation gain matrix plus a bulk propagation delay.
  Moving a mic is an instant-tier recompute.
- **Binaural**: the same projection through minimum-phase HRTF filters and
  interaural delays.
- **Room**: algorithmic reverb (feedback delay network) only. No convolution:
  it would rely on recorded impulse responses and its large FFTs are a
  deadline risk.

## 4. Real-time design

### 4.1 Rules for the render path

C++23 only. No heap allocation, no locks, no Swift or Objective-C runtime
calls, no file or logging calls. Denormals flushed to zero on every thread
that renders. One wake per helper thread per render call is the only
permitted syscall; no spin-waiting.

### 4.2 Threads

| Thread | Cores | Work |
|---|---|---|
| Host render thread | Performance | Events, hammer, strings, bus, soundboard, mics |
| Render helpers (0–2, optional) | Performance, joined to the host workgroup | Share of string banks |
| Presynthesis | Efficiency, utility priority | Tiers "instant" and "slow" |
| UI | Main actor | Controls, visualisation at display rate |

The engine is built and tuned single-threaded first. Helpers are enabled only
if measurement on the M4 shows the worst case needs them, and only if
GarageBand provides a workgroup. When enabled, each render call fans out twice
— struck strings, then sympathetic strings — which matches the one-way bus and
adds no delay.

### 4.3 Budget on the M4

Worst case, pedal down, all ~240 strings with both polarisations: about
20,000 string resonators plus soundboard modes. At 44.1 kHz that is roughly
10⁹ resonator updates per second.

| Component | Estimated share of one performance core |
|---|---|
| String resonators, 4-wide NEON | 15–30% |
| Soundboard modes and string→mode drive | 5–10% |
| Mics, binaural, reverb | 5% |
| Hammer contact, nonlinear strings (peaks) | 5–15% |

These are estimates, not measurements; milestone 2 replaces them with numbers.
The working set (~0.5 MB) exceeds the first-level cache, so each string bank
is processed for a whole sub-block before moving on.

Acceptance target: worst case stays under 50% of one performance core at
GarageBand's smallest buffer, with no overruns in a 30-minute stress run.

### 4.4 Where the M4's capacity goes

A single target machine means no scaling tiers and no quality settings. The
headroom is spent on quality, in this order:

1. All strings always live, both polarisations, full partial count to 20 kHz.
2. Larger soundboard mode set (the 400–600 target).
3. Hammer contact at 4× instead of 2×.
4. Nonlinear strings on more notes.
5. Engine-wide 2× internal rate, only if listening tests show a benefit.

The six efficiency cores take presynthesis, so soundboard edits never compete
with audio. Memory is not a constraint: every cached soundboard mode set stays
loaded. The GPU is used for visualisation only; audio never runs on it.
SIMD is hand-written NEON (4 floats wide) plus Accelerate for linear algebra.

## 5. Plugin shell

- `AUAudioUnit` subclass with a thin Objective-C++ shim that returns the
  render block and calls the C++ kernel. Everything else is Swift 6.
- **Parameters** split three ways:
  - *Automatable* (tens, in the parameter tree, ramped per sub-block):
    output level, dynamics, mic levels and pans, reverb mix, lid position,
    hammer hardness, global unison width.
  - *Structural* (in the tree where GarageBand tolerates it, applied
    asynchronously): anything needing presynthesis.
  - *Per-note voicing* (thousands of values): stored in plugin state
    (`fullState`), never in the parameter tree.
- **UI**: SwiftUI in the plugin view — model, voicing, soundboard, mics, room.
  Metal for the mic stage and the soundboard energy view, fed by a lock-free
  telemetry buffer.
- **Presets and caches** live in the extension's container.

## 6. Calibration

Good equations with wrong constants sound synthetic, so calibration is a
first-class track, not a late phase.

1. **Starting point**: published Steinway D parameters (Chabassier & Duruflé,
   INRIA RT-425). These are parameters, not validation data.
2. **Reference recordings**: isolated notes at several dynamics from a named,
   licence-checked source. Choosing it is a milestone 1 task; the University
   of Iowa anechoic piano set is the first candidate to evaluate.
3. **Classical analysis first**: high-resolution partial tracking per note to
   fit inharmonicity, per-partial decay (both stages) and beating. Gradient
   descent is unreliable for partial frequencies and is not used for them.
4. **Differentiable model second**: a Python mirror of the linear engine fits
   what analysis cannot separate — hammer felt parameters and spectral
   evolution with velocity.
5. **One source of truth**: the Python mirror and the C++ engine are held
   together by golden test vectors, checked in CI.

## 7. Verification

- **Reference renderer**: the C++ core built in double precision with no
  real-time constraints, rendering MIDI to a file. Every DSP change is
  compared against it.
- **Physics tests**: partial frequencies against the inharmonicity formula,
  energy never increasing in an undriven system, hammer contact duration and
  force against published simulations.
- **Real-time tests**: allocation and lock detection on the render thread in
  CI; `auval`; worst-case stress run on the M4.
- **Listening tests**: blind A/B against the reference recordings and against
  Pianoteq 9, repeated at every milestone from 3 onward.

## 8. Milestones

Each ends with something playable or measurable. No dates: the original
34-week schedule was not credible for this scope.

| # | Deliverable | Done when |
|---|---|---|
| 1 | Skeleton AUv3 in GarageBand playing a sine; host facts measured | Section 1 questions answered with numbers |
| 2 | Reference renderer: one note, linear strings, hammer, fixed soundboard filter | Physics tests pass; budget table replaced by measurements |
| 3 | Playable 88 keys in GarageBand with offline choir coupling and dampers | Worst case within budget; first listening test |
| 4 | Calibration against recordings | Blind test: notes judged "piano" rather than "synth" |
| 5 | Sympathetic bus, pedals, soundboard modes, microphones, reverb | Pedalled chords and mic moves judged convincing |
| 6 | Nonlinear strings, mechanical noise, binaural | Bass fortissimo A/B improves in blind test |
| 7 | Voicing UI, live soundboard editing, presets | Edits apply without clicks or overruns |

## 9. Open questions

- **Reference recordings**: source and licence (milestone 1).
- **Soundboard solver**: write a plate eigen-solver in-house or generate mode
  sets with an external tool and ship only the results. The second is faster
  and removes "slow tier" editing from early milestones.
- **Distribution**: the repository is GPL-3.0 and the presynthesis idea
  overlaps Modartt's patent US7915515B2 (filed around 2007; status not
  verified). Neither matters for private use on one machine. Both need
  checking before any distribution.

## 10. Changes from the original plan

| Original | Revised | Reason |
|---|---|---|
| Runtime bridge loop synced every 16–32 samples | Choir coupling solved offline; one-way sympathetic bus | Delay in the loop breaks the physics and risks instability |
| 256-voice polyphony | ~240 permanent strings | A string-per-key model has no voices |
| 192 kHz, 32-sample buffer, < 1.5 ms round trip | GarageBand's rate and buffers, measured | Latency belongs to the host and device; 192 kHz is unavailable |
| 2–6 worker threads with spin barriers | Single thread first; up to 2 helpers if measured need | Estimated load fits one core; spinning wastes cores |
| Presynthesis always 5–20 ms; Metal for FEM | Three cost tiers; CPU sparse solver on efficiency cores | Plate eigen-solves take seconds or more |
| Feedback delay network soundboard above 1.5 kHz in the loop | One-way fitted radiation filters; more explicit modes | Stability, and the M4 can afford the modes |
| 12–16 radiation patches | Per-mode radiation gains per mic | Uses the modal structure directly; cheaper and more accurate |
| Action state machine with key inertia and let-off | Velocity mapping | MIDI has no key position |
| MIDI 2.0, 16-bit velocity | MIDI 1.0 as GarageBand delivers it | Host limitation |
| Convolution reverb | Algorithmic reverb only | Sample-free claim; deadline risk |
| Standalone app + AUv3 for Logic, Live, Cubase | AUv3 for GarageBand; thin container app | Scope decision |
| All parameters automatable | Automatable / structural / state | Recompiled parameters cannot be sample-accurate |
| Swift calls C++ with no Objective-C++ | Thin Objective-C++ render shim | Render block must not touch the Swift runtime |
| "8-wide NEON / AMX" | 4-wide NEON + Accelerate | NEON is 128-bit; AMX is not a public target |
| Differentiable fitting of everything | Classical partial analysis, then differentiable fitting | Gradient descent fits frequencies poorly |
| UI and calibration last | Playable in GarageBand by milestone 3, calibration at 4 | The instrument must be judged by ear early |

## References

- B. Bank, S. Zambon, F. Fontana, "A modal-based real-time piano synthesizer", IEEE TASLP, 2010.
- J. Chabassier, M. Duruflé, "Physical parameters for piano modeling", INRIA RT-0425, 2012.
- J. Chabassier, A. Chaigne, P. Joly, "Modeling and simulation of a grand piano", JASA, 2013.
- M. Ducceschi, S. Bilbao, C. Webb, "Real-time modal synthesis of nonlinearly interconnected networks", DAFx 2023.
- G. Weinreich, "Coupled piano strings", JASA, 1977.
- J. Berendes, S. Schwär, M. Schäfer, M. Müller, "Towards differentiable piano synthesis based on physical modeling", ISMIR 2023 late-breaking demo.
- P. Guillaume, US patent 7915515 B2.
