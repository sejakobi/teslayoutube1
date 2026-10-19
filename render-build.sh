#!/usr/bin/env bash
set -euo pipefail

# Build command on Render: bash render-build.sh
# Install Deno inside the project directory so resolver.py can find it at runtime,
# even if Render uses a different HOME/PATH when starting the web service.
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

python -m pip install --upgrade pip
python -m pip install --upgrade -r requirements.txt

export DENO_INSTALL="$PROJECT_DIR/.deno"
mkdir -p "$DENO_INSTALL"
if [ ! -x "$DENO_INSTALL/bin/deno" ]; then
  curl -fsSL https://deno.land/install.sh | sh
fi
export PATH="$DENO_INSTALL/bin:$PATH"

# Explicitly install the current yt-dlp prerelease/nightly plus matching EJS
# challenge solver scripts. requirements.txt already declares yt-dlp[default],
# but this upgrade is intentional and ensures the latest compatible package.
python -m pip install --upgrade --pre "yt-dlp[default]"

echo "=== YouTube extraction dependencies ==="
echo "Project directory: $PROJECT_DIR"
echo "Deno executable: $DENO_INSTALL/bin/deno"
"$DENO_INSTALL/bin/deno" --version
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
