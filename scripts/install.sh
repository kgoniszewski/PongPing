#!/bin/bash
# Build PongPing, install it to /Applications and register the plugin.
#
#   scripts/install.sh                 ad-hoc signed build (no Apple ID needed)
#   scripts/install.sh --team ABC123   sign with your Apple ID team instead
#   scripts/install.sh --midi2         ask the host for MIDI 2.0 (probe step I)
#   scripts/install.sh --test          also run the audio unit tests first
#   scripts/install.sh --no-install    build only
#
# All build files stay in ./build, whatever Xcode's Locations settings say.
# Every run gets a higher plugin version so GarageBand rescans the plugin.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
BUILD="$ROOT/build"
TEAM=""
MIDI2=0
RUN_TESTS=0
INSTALL=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --team) TEAM="$2"; shift 2 ;;
        --midi2) MIDI2=1; shift ;;
        --test) RUN_TESTS=1; shift ;;
        --no-install) INSTALL=0; shift ;;
        -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

mkdir -p "$BUILD"

# Plugin version: 0x00010000 = 1.0.0; the low 16 bits count builds.
VERSION_FILE="$BUILD/au-version"
VERSION=$(( $(cat "$VERSION_FILE" 2>/dev/null || echo 65536) + 1 ))
echo "$VERSION" > "$VERSION_FILE"

if [[ -n "$TEAM" ]]; then
    SIGNING=(CODE_SIGN_STYLE=Automatic "DEVELOPMENT_TEAM=$TEAM" -allowProvisioningUpdates)
else
    SIGNING=(CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= ENABLE_HARDENED_RUNTIME=NO)
fi

# Keep every Xcode output inside ./build (overrides custom Locations settings).
LOCATIONS=(
    -derivedDataPath "$BUILD/DerivedData"
    -IDEBuildLocationStyle=Unique
    "SYMROOT=$BUILD/Products"
    "OBJROOT=$BUILD/Intermediates"
)

COMMON=(
    -project PongPing.xcodeproj
    -destination 'platform=macOS,arch=arm64'
    "${LOCATIONS[@]}"
    "${SIGNING[@]}"
    "PONGPING_AU_VERSION=$VERSION"
    "PONGPING_REQUEST_MIDI2=$MIDI2"
)

run_xcodebuild() {   # $1 = log name, rest = xcodebuild arguments
    local log="$BUILD/$1.log"; shift
    if ! xcodebuild "$@" > "$log" 2>&1; then
        echo "FAILED. Relevant lines from $log:" >&2
        grep -n -i -E "error|failed|denied|permission" "$log" | grep -v "IDELogStore" | head -30 >&2
        exit 1
    fi
}

echo "==> Generating Xcode project"
command -v xcodegen >/dev/null || { echo "xcodegen missing: brew install xcodegen" >&2; exit 1; }
xcodegen generate --quiet

if [[ $RUN_TESTS == 1 ]]; then
    echo "==> Audio unit tests"
    run_xcodebuild test -scheme PongPingKit "${COMMON[@]}" test
    grep -E "Executed [0-9]+ tests" "$BUILD/test.log" | tail -1
fi

echo "==> Building (plugin version $VERSION, MIDI 2.0 request: $MIDI2)"
run_xcodebuild build -scheme PongPing -configuration Release "${COMMON[@]}" build
APP="$BUILD/Products/Release/PongPing.app"
APPEX="$APP/Contents/PlugIns/PongPingExtension.appex"
echo "    built $APP"

echo "==> Self-test (sandboxed app, offline render)"
"$APP/Contents/MacOS/PongPing" --selftest | tail -1

[[ $INSTALL == 1 ]] || exit 0

echo "==> Installing to /Applications"
rm -rf /Applications/PongPing.app
cp -R "$APP" /Applications/
pluginkit -a /Applications/PongPing.app/Contents/PlugIns/PongPingExtension.appex || true
killall -9 AudioComponentRegistrar 2>/dev/null || true
sleep 2

echo "==> Registration"
pluginkit -m -v -p com.apple.AudioUnit-UI | grep -i pongping || echo "    (not listed by pluginkit yet)"
if auval -v aumu Pnpg Pgpg > "$BUILD/auval.log" 2>&1; then
    echo "    auval: $(grep -E "AU VALIDATION" "$BUILD/auval.log" || tail -1 "$BUILD/auval.log")"
else
    echo "    auval FAILED — see $BUILD/auval.log:"
    grep -i -E "error|fail|cannot|not found" "$BUILD/auval.log" | head -10
fi

cat <<DONE

Done. Next:
  open /Applications/PongPing.app       # window should say "Loaded in-process"
  then GarageBand → Software Instrument track → Audio Units → PongPing → Piano
Probe report from GarageBand:
  ~/Library/Containers/com.pongping.PongPing.PongPingExtension/Data/Library/Application Support/PongPing/host-probe.json
DONE
