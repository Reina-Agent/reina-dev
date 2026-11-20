#!/usr/bin/env bash
#
# Dev launch loop for the Reina desktop app on macOS / Linux — the bash
# equivalent of start-desktop.cmd. Builds (only when needed), then runs the app
# in dev mode with a timestamped log.
#
# Usage:
#   ./start-desktop.sh              # auto: rebuild only if sources changed since last build
#   ./start-desktop.sh --rebuild    # force a full rebuild before launching   (-r)
#   ./start-desktop.sh --no-build   # skip build, use last compiled output     (-n)
#   ./start-desktop.sh --restart    # kill any running Reina, then start
#   ./start-desktop.sh --help       # show help                                (-h)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
cd "$ROOT_DIR"

print_help() {
  cat <<'USAGE'
Usage: ./start-desktop.sh [options]   (macOS/Linux equivalent of start-desktop.cmd)

  (no args)         Auto: rebuild only if source files changed since last build
  --rebuild, -r     Force a full rebuild before launching
  --no-build, -n    Skip build entirely (use last compiled output)
  --restart         Kill any already-running Reina before starting
  --help, -h        Show this help

Environment:
  REINA_CDP_PORT   Chrome DevTools Protocol port (default 9333; set 0 to disable)

Note: the terminal feature needs node-pty built for Electron's ABI. If it errors
on first launch, run:  npm --workspace=@reina/desktop run rebuild-native
USAGE
}

# --- parse args ---
MODE="auto"   # auto | rebuild | skip
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --rebuild|-r)  MODE="rebuild" ;;
    --no-build|-n) MODE="skip" ;;
    --restart)     RESTART=1 ;;
    --help|-h)     print_help; exit 0 ;;
    *) echo "Unknown argument: $arg"; echo; print_help; exit 1 ;;
  esac
done

# --- logs (rotate: keep newest 10) ---
LOG_DIR="$ROOT_DIR/.logs"
mkdir -p "$LOG_DIR"
BUILD_STAMP="$LOG_DIR/.last-build-ok"
ls -1t "$LOG_DIR"/reina-app-*.log 2>/dev/null | tail -n +11 | while IFS= read -r old; do
  rm -f "$old"
done
STAMP="$(date +%Y%m%d-%H%M%S)"
APP_LOG="$LOG_DIR/reina-app-$STAMP.log"
export REINA_DESKTOP_LOG="$APP_LOG"

# --- already running? (match this project's electron, not other apps) ---
ELECTRON_DIR="$ROOT_DIR/node_modules/electron"
RUNNING_PIDS="$(pgrep -f "$ELECTRON_DIR" 2>/dev/null || true)"
if [[ -n "$RUNNING_PIDS" ]]; then
  if [[ "$RESTART" -eq 1 ]]; then
    echo "Stopping running Reina instance(s): $(echo "$RUNNING_PIDS" | tr '\n' ' ')"
    # shellcheck disable=SC2086  # word-split the newline-separated PID list
    kill $RUNNING_PIDS 2>/dev/null || true
    sleep 1
    RUNNING_PIDS="$(pgrep -f "$ELECTRON_DIR" 2>/dev/null || true)"
    # shellcheck disable=SC2086
    [[ -n "$RUNNING_PIDS" ]] && kill -9 $RUNNING_PIDS 2>/dev/null || true
  else
    echo "Reina Desktop is already running."
    echo
    echo "  Close it first, or re-run with --restart to kill and replace it."
    exit 0
  fi
fi

# --- npm check ---
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found on PATH." >&2
  exit 1
fi

# --- decide whether to build ---
SHOULD_BUILD=0
case "$MODE" in
  rebuild) SHOULD_BUILD=1 ;;
  skip)    SHOULD_BUILD=0 ;;
  auto)
    if [[ ! -f "$BUILD_STAMP" ]]; then
      SHOULD_BUILD=1
    elif find packages/*/src apps/desktop/src -type f \
           \( -name '*.ts' -o -name '*.tsx' -o -name '*.cjs' -o -name '*.mjs' -o -name '*.js' \) \
           -newer "$BUILD_STAMP" 2>/dev/null | grep -q .; then
      SHOULD_BUILD=1
    fi
    ;;
esac

if [[ "$SHOULD_BUILD" -eq 1 ]]; then
  echo "Building..."
  if ! npm run build:desktop; then
    echo
    echo "Build failed." >&2
    exit 1
  fi
  touch "$BUILD_STAMP"   # mark the last successful build time
else
  echo "No source changes since last build; skipping rebuild (use --rebuild to force)."
fi

echo
echo "Starting Reina Desktop..."
echo "  App log: $APP_LOG"
echo
npm run dev --workspace=@reina/desktop
EXITCODE=$?

if [[ "$EXITCODE" -ne 0 ]]; then
  echo
  echo "Reina Desktop exited with code $EXITCODE." >&2
fi
exit "$EXITCODE"
