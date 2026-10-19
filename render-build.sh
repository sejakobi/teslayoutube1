#!/usr/bin/env bash
set -euo pipefail

# Render Build Command: bash render-build.sh
# Installs Python dependencies (including yt-dlp's EJS scripts) and Deno,
# which yt-dlp needs to solve current YouTube JavaScript challenges.

python -m pip install --upgrade pip
python -m pip install --upgrade -r requirements.txt

export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
if [ ! -x "$DENO_INSTALL/bin/deno" ]; then
  curl -fsSL https://deno.land/install.sh | sh
fi
export PATH="$DENO_INSTALL/bin:$PATH"

echo "Deno runtime:"
deno --version

echo "yt-dlp version:"
python -c 'import yt_dlp; print(yt_dlp.version.__version__)'
