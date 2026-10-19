#!/usr/bin/env bash
set -euo pipefail

# Render Build Command: bash render-build.sh
# Install the project requirements first, then explicitly install the latest
# yt-dlp nightly + matching yt-dlp-ejs package as recommended by yt-dlp when
# the stable extractor cannot resolve YouTube formats.

python -m pip install --upgrade pip
python -m pip install --upgrade -r requirements.txt

export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
if [ ! -x "$DENO_INSTALL/bin/deno" ]; then
  curl -fsSL https://deno.land/install.sh | sh
fi
export PATH="$DENO_INSTALL/bin:$PATH"

# The important difference from the previous build script:
# --pre permits yt-dlp's development/nightly builds, which can include
# fixes for YouTube extractor changes before the next stable release.
python -m pip install --upgrade --pre "yt-dlp[default]"

echo "=== YouTube extraction dependencies ==="
echo "Deno:"
deno --version
echo "yt-dlp:"
python -c 'import yt_dlp; print(yt_dlp.version.__version__)'
echo "yt-dlp-ejs:"
python - <<'PY'
from importlib.metadata import PackageNotFoundError, version
try:
    print(version("yt-dlp-ejs"))
except PackageNotFoundError:
    print("NOT INSTALLED")
    raise SystemExit(1)
PY
