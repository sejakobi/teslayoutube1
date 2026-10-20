#!/usr/bin/env bash
# Idempotent setup + launch.
#
#   ./run.sh                        # prompts for PIN if ASCIILINE_PIN not set
#   ASCIILINE_PIN=1234 ./run.sh     # non-interactive
#   ./run.sh --port 8787            # extra args are passed to server.py
#
# Safe to re-run: skips venv creation when .venv already exists.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Checking ffmpeg..."
if ! command -v ffmpeg &>/dev/null; then
    echo
    echo "ERROR: ffmpeg not found in PATH."
    echo "Install it with:  brew install ffmpeg"
    exit 1
fi
echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1)"

if [ ! -d ".venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv .venv
    echo "  .venv created"
else
    echo "  .venv already exists — skipping creation"
fi

# shellcheck disable=SC1091
source .venv/bin/activate
echo "  Python: $(python --version)"

echo "Installing / verifying Python dependencies..."
pip install -q -r requirements.txt
echo "  Dependencies OK"

if [ -z "${ASCIILINE_PIN:-}" ]; then
    echo
    read -r -s -p "Enter PIN (4-8 digits): " ASCIILINE_PIN
    echo
    if [ -z "$ASCIILINE_PIN" ]; then
        echo "ERROR: PIN is required."
        exit 1
    fi
fi
export ASCIILINE_PIN

echo
echo "Starting ASCILINE YouTube Streamer..."
echo "  Press Ctrl-C to stop (ffmpeg processes will be cleaned up automatically)"
echo
exec python server.py "$@"
