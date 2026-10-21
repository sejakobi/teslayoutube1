# ASCILINE YouTube Streamer

Plays any YouTube video (live or VOD) as a real-time ASCII art stream in
a web browser.  Designed for the Tesla in-car browser, works in any
Chromium browser.  Runs directly on a Mac mini — no Docker.

## Requirements

- macOS (Apple Silicon recommended)
- Python 3.11+
- ffmpeg (Homebrew)

## Setup

```bash
brew install ffmpeg
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Or run `./run.sh` once and it does the same thing idempotently, prompts
for a PIN, and starts the server.

## Running

```bash
source .venv/bin/activate
python server.py --pin 1234
```

The server listens on `http://0.0.0.0:8000` by default.  Open it,
enter the PIN, then type a YouTube URL, video ID, or search query and
press Play.

| Flag | Default | Description |
|------|---------|-------------|
| `--pin` | required | 4–8 digit PIN (or `ASCIILINE_PIN` env var) |
| `--port` | 8000 | TCP port to listen on |
| `--bind` | 0.0.0.0 | Bind address |
| `--max-source-height` | 720 | Maximum source video resolution |

## Quality presets

| Preset | Grid | FPS | Notes |
|--------|------|-----|-------|
| **Low** (default) | 120×50 | 24 | Tesla / target |
| **Med** | 160×68 | 30 | Desktop |
| **High** | 200×84 | 30 | Desktop |

LOW is the only preset that's been verified clean on the M4 reference
(FPS 24/24, JIT ~42 ms).  MED/HIGH are paint-bound on the per-cell
`fillText` loop on the M4 — they work, but with visible jitter.  The
Tesla in-car browser runs LOW.

Preset changes take effect on the next Play (server restarts ffmpeg with
the new dimensions).

## Architecture

```
Browser                     Mac mini
─────────                  ────────────────────────────────────────
GET  /                ──▶  static/index.html  (or pin.html if no cookie)
POST /api/auth        ──▶  HMAC cookie issued (Secure only on https)
POST /api/play        ──▶  resolver.py (yt-dlp) → ResolvedMedia
                           pipeline.py spawns ffmpeg ×2 (video + audio)
WS   /ws/video        ◀──  INIT message + binary ASCILINE frames
GET  /audio           ◀──  AAC/ADTS chunked stream
```

Wire format and rendering are vendored from
[ASCILINE](https://github.com/YusufB5/ASCILINE).  See
`vendor/asciline/PROTOCOL-NOTES.md`.

### Pipeline pacing

ffmpeg is invoked with `-re -fps_mode cfr -r <target_fps>` so frames
arrive evenly paced at the target rate.  The consumer is then a trivial
drain — read from the queue, encode, send.  Earlier iterations tried
consumer-side pacing (relative sleep, absolute targets, skip-ahead,
re-anchor) and all failed the same way: a bursty producer cannot be
smoothed by any consumer-side scheme.  Source-side pacing fixed it in
one flag.

## Cloudflare Tunnel

The service is designed to run behind a Cloudflare Tunnel for internet
access from the Tesla:

```bash
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel login
cloudflared tunnel create asciline
cloudflared tunnel route dns asciline yourdomain.com
cloudflared tunnel run asciline
```

The PIN brute-force lockout uses `CF-Connecting-IP`, so each car/device
is locked out independently — one device's 5 bad attempts does not lock
out the others.

The auth cookie is marked `Secure` only when the auth request itself
came in over https.  Over plain `http://localhost` (local dev) the
cookie is set without `Secure` so the browser will actually send it on
the `/audio` GET; otherwise audio would silently 403 while video kept
working.

## Tesla browser notes

- **Audio** is AAC/ADTS via `<audio>`; no extra codecs needed.
- **Touch targets** are ≥ 48 px; PIN keypad has large tap targets.
- **Cookie** persists 30 days; you should not re-enter the PIN often.
- **Preset**: stick to LOW.

## Known limitations

- **A/V drift on long VODs.**  Video and audio run as two independent
  ffmpeg processes with no shared clock.  They start together but drift
  is inevitable over hours.  Negligible on live streams; audible after
  20–40 min on long VODs.  Timestamp-level sync is out of scope.
- **Signed stream URL expiry (~6 h).**  YouTube googlevideo.com URLs
  carry time-limited signatures.  Live sessions left running past ~6 h
  will stop when the manifest URL expires.  Press Play again to
  re-resolve.
- **In-memory PIN lockout** resets on restart (acceptable for a personal
  service).
- **No seeking, no pause/resume.**  Stop and re-Play restarts from the
  beginning (VOD) or live head (live).
- **Single active session.**  A new Play immediately kills the previous.
- **MED/HIGH paint-bound on M4.**  The per-cell `fillText` color render
  caps at ~150–300 K calls/s on Chromium; MED at 30 fps × 10880 cells is
  near the wall, HIGH is past it.  The known fix if MED/HIGH smoothness
  ever matters is an `ImageData`/`putImageData` pixel renderer (the
  `pixelMode` path already does this for upstream pixel-mode streams) —
  **NOT a glyph atlas** (we tried; LRU thrashes on mode-3 colors and the
  result regressed to single-digit FPS).
- **Tesla in-car untested** in this code state; numbers above are M4
  proxy.

## Test matrix

| Test | Input | Expected |
|------|-------|----------|
| VOD | `dQw4w9WgXcQ` | ASCII video, audio, no LIVE badge |
| Live | `https://www.youtube.com/watch?v=X4VbdwhkE10` | ASCII + audio + LIVE badge |
| Search | `lofi hip hop` | First search hit, plays |
| Invalid | `not-a-real-id-!!` | Error shown in status bar |

## Process cleanup

The server registers `atexit` + SIGTERM/SIGINT handlers.  Both ffmpeg
processes get SIGTERM in parallel; SIGKILL after 3 s if needed.  No
orphans survive a clean shutdown.

```bash
# Verify after Ctrl-C or kill:
ps aux | grep ffmpeg
# Expected: (nothing)
```
