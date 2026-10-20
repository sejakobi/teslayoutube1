#!/usr/bin/env bash
set -Eeuo pipefail

# Render Build Command:
#   bash render-build.sh
#
# Installs the Python dependencies, a project-local Deno runtime, and the
# current yt-dlp prerelease with its default dependencies (including EJS).
# Note: this can improve compatibility with YouTube changes, but cannot
# guarantee that YouTube will stop returning HTTP 429.

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

export DENO_INSTALL="$PROJECT_DIR/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"

log() {
  printf '\n[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

command -v python >/dev/null 2>&1 || fail "Python was not found in the Render build environment."
command -v curl >/dev/null 2>&1 || fail "curl is required to install Deno."

log "Upgrading pip"
python -m pip install --upgrade pip

log "Installing application requirements"
python -m pip install --upgrade -r requirements.txt

log "Installing Deno locally in the project"
mkdir -p "$DENO_INSTALL"
if [[ ! -x "$DENO_INSTALL/bin/deno" ]]; then
  curl --fail --location --silent --show-error https://deno.land/install.sh \
    | sh
fi

[[ -x "$DENO_INSTALL/bin/deno" ]] \
  || fail "Deno installation did not produce $DENO_INSTALL/bin/deno"

log "Updating yt-dlp to the latest available prerelease"
python -m pip install --upgrade --pre 'yt-dlp[default]'

log "Checking installed Python dependencies"
python -m pip check

log "Installed runtime versions"
printf '\nProject directory: %s\n' "$PROJECT_DIR"
printf 'Deno executable: %s\n' "$DENO_INSTALL/bin/deno"
printf '\nDeno version:\n'
"$DENO_INSTALL/bin/deno" --version

printf '\nPython version:\n'
python --version

printf '\nyt-dlp version:\n'
python -c 'import yt_dlp; print(yt_dlp.version.__version__)'

printf '\nyt-dlp-ejs version:\n'
python - <<'PY'
from importlib.metadata import PackageNotFoundError, version

try:
    print(version("yt-dlp-ejs"))
except PackageNotFoundError:
    raise SystemExit(
        "ERROR: yt-dlp-ejs is not installed. Check the yt-dlp[default] install."
    )
PY

log "Build dependencies installed successfully"
