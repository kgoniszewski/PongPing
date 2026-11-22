# PongPing

A physically modelled grand piano with no audio samples, built as an Audio
Unit v3 instrument for GarageBand on a Mac mini M4.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Current milestone (build, install, measure): [docs/MILESTONE-1.md](docs/MILESTONE-1.md)
- Host measurements: [docs/host-facts.md](docs/host-facts.md)

Quick start on the Mac:

```sh
brew install xcodegen
xcodegen generate && open PongPing.xcodeproj
```

Core DSP tests run anywhere:

```sh
cmake -S Core -B Core/build && cmake --build Core/build && ctest --test-dir Core/build
```
