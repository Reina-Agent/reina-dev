#!/usr/bin/env bash
#
# Package the Reina desktop app for macOS (DMG + ZIP).
#
# Must run ON macOS: Electron and node-pty ship arch-specific native binaries,
# so the host that builds the package has to match the target platform. The
# electron-builder config lives in the root package.json ("build" key); this
# script just wraps the build + native-rebuild + packaging steps with sane
# defaults and arch selection.
#
# Usage:
#   ./scripts/package-mac.sh                 # build + package for the host arch
#   ./scripts/package-mac.sh --arch=arm64    # Apple Silicon only
#   ./scripts/package-mac.sh --arch=x64      # Intel only
#   ./scripts/package-mac.sh --arch=universal
#   ./scripts/package-mac.sh --arch=all      # both arm64 and x64 (config default)
#   ./scripts/package-mac.sh --no-build      # skip the TS/bundle build, just package
#   ./scripts/package-mac.sh --no-rebuild    # skip the node-pty native rebuild
#   ./scripts/package-mac.sh --dmg-only      # produce only the .dmg
#   ./scripts/package-mac.sh --zip-only      # produce only the .zip
#
# Output: release/Reina-<version>-mac-<arch>.{dmg,zip}

set -euo pipefail

# --- locate repo root (this script lives in <root>/scripts) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# --- defaults ---
ARCH="host"        # host | arm64 | x64 | universal | all
DO_BUILD=1
DO_REBUILD=1
TARGETS=("dmg" "zip")

for arg in "$@"; do
  case "$arg" in
    --arch=*)    ARCH="${arg#*=}" ;;
    --no-build)  DO_BUILD=0 ;;
    --no-rebuild) DO_REBUILD=0 ;;
    --dmg-only)  TARGETS=("dmg") ;;
    --zip-only)  TARGETS=("zip") ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2 ;;
  esac
done

# --- guard: macOS only ---
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: macOS packaging must run on macOS — Electron and node-pty need" >&2
  echo "       macOS native binaries that can't be produced on this host." >&2
  exit 1
fi

# --- resolve the electron-builder arch flag ---
case "$ARCH" in
  host)
    if [[ "$(uname -m)" == "arm64" ]]; then ARCH_FLAG="--arm64"; else ARCH_FLAG="--x64"; fi ;;
  arm64)     ARCH_FLAG="--arm64" ;;
  x64)       ARCH_FLAG="--x64" ;;
  universal) ARCH_FLAG="--universal" ;;
  all)       ARCH_FLAG="--arm64 --x64" ;;  # both, per the package.json default
  *)
    echo "Unknown --arch=$ARCH (use host|arm64|x64|universal|all)" >&2
    exit 2 ;;
esac

echo "==> Reina macOS package"
echo "    root:    $ROOT_DIR"
echo "    arch:    $ARCH ($ARCH_FLAG)"
echo "    targets: ${TARGETS[*]}"

# --- install dependencies if missing ---
if [[ ! -d node_modules ]]; then
  echo "==> Installing dependencies (npm install)"
  npm install
fi

# --- rebuild node-pty against the bundled Electron ABI ---
# electron-builder runs with npmRebuild:false, so native modules must already
# match Electron's ABI for the host before we package.
if [[ "$DO_REBUILD" -eq 1 ]]; then
  echo "==> Rebuilding native modules for Electron (node-pty)"
  npm --workspace=@reina/desktop run rebuild-native
fi

# --- build TS + bundle the renderer/main/agent-host ---
if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "==> Building desktop bundles (npm run build:desktop)"
  npm run build:desktop
fi

# --- package ---
# Artifacts land flat in release/ (the artifactName carries no subdir): a "/" in
# the name is non-GitHub-safe and makes electron-builder rename the file in the
# updater feed (latest.yml) so it no longer matches the uploaded asset.
echo "==> Running electron-builder"
# shellcheck disable=SC2086  # ARCH_FLAG may legitimately expand to two words
npx electron-builder --mac "${TARGETS[@]}" $ARCH_FLAG

# --- tidy up byproducts electron-builder leaves behind ---
echo "==> Cleaning byproducts"
rm -rf release/mac release/mac-arm64 release/mac-universal 2>/dev/null || true
rm -f release/latest-mac.yml release/builder-debug.yml 2>/dev/null || true
find release -maxdepth 1 -name '*.blockmap' -delete 2>/dev/null || true

echo "==> Done. Artifacts in: $ROOT_DIR/release"
ls -1 release/*.dmg release/*.zip 2>/dev/null || true
