"""FastAPI application entry point.

Every route is gated by AuthMiddleware: HTTP gets the PIN page or 403,
WebSocket upgrades close with 4003.  /api/auth is exempt so the PIN can
be submitted in the first place.
"""

from __future__ import annotations

import argparse
import atexit
import asyncio
import json
import logging
import os
import shutil
import signal
import secrets
import time
import subprocess
import sys
from contextlib import asynccontextmanager
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen
from urllib.error import HTTPError, URLError

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.websockets import WebSocketState

import auth
from config import PRESETS, CANVAS_PRESETS, DEFAULT_PRESET, SERVER_DEFAULTS
from pipeline import PresetSpec, _ffmpeg_input_header_args
from resolver import ResolverError
from session import (
    Session, State,
    _atexit_cleanup, _signal_handler,
    get_manager, init_manager,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("server")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
PIN_PAGE = os.path.join(STATIC_DIR, "pin.html")

# Short-lived opaque selections: YouTube IDs stay on the server, not in page URLs.
_SELECTIONS: dict[str, tuple[str, float]] = {}
_SELECTION_TTL = 30 * 60

def _new_selection(video_id: str) -> str:
    now = time.time()
    for key, (_, expiry) in list(_SELECTIONS.items()):
        if expiry < now:
            _SELECTIONS.pop(key, None)
    token = secrets.token_urlsafe(24)
    _SELECTIONS[token] = (video_id, now + _SELECTION_TTL)
    return token

def _resolve_selection(token: str) -> str | None:
    item = _SELECTIONS.get(token)
    if not item or item[1] < time.time():
        _SELECTIONS.pop(token, None)
        return None
    return "https://www.youtube.com/watch?v=" + item[0]


class AuthMiddleware(BaseHTTPMiddleware):
    """Enforce the PIN cookie on every route.

    - WebSocket upgrades: 403 here so the handshake fails cleanly; the
      ws_video handler also re-checks and closes with code 4003.
    - /api/* without cookie: 403 JSON.
    - /audio without cookie: 403 plain (it's a streaming endpoint, not a page).
    - Everything else without cookie: serve pin.html.
    - /api/auth itself is exempt so the PIN can be submitted.
    """

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        if path == "/api/auth":
            return await call_next(request)

        if auth.is_authenticated(request.scope):
            return await call_next(request)

        upgrade = request.headers.get("upgrade", "").lower()
        if upgrade == "websocket":
            return Response(status_code=403, content="Unauthorized")

        if path.startswith("/api/"):
            return JSONResponse(status_code=403, content={"error": "unauthorized"})

        if path in {"/audio", "/media"}:
            return Response(status_code=403, content="Unauthorized")

        with open(PIN_PAGE, "rb") as f:
            return HTMLResponse(content=f.read().decode("utf-8"), status_code=200)


def check_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        print(
            "ERROR: ffmpeg not found in PATH.\n"
            "Install it with: brew install ffmpeg",
            file=sys.stderr,
        )
        sys.exit(1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # atexit + signal handlers so no orphan ffmpeg survives a crash.
    atexit.register(_atexit_cleanup)
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)
    yield
    try:
        mgr = get_manager()
        await mgr.stop()
    except Exception:
        pass


app = FastAPI(title="ASCILINE YouTube Streamer", lifespan=lifespan)
app.add_middleware(AuthMiddleware)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api/search")
async def api_search(q: str = ""):
    """Search YouTube videos via the server-side YouTube Data API v3."""
    query = q.strip()
    if not query:
        return JSONResponse(status_code=400, content={"error": "Bitte einen Suchbegriff eingeben."})
    if len(query) > 200:
        return JSONResponse(status_code=400, content={"error": "Der Suchbegriff ist zu lang."})
    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        return JSONResponse(status_code=503, content={"error": "YOUTUBE_API_KEY ist auf dem Server nicht konfiguriert."})
    params = urlencode({"part":"snippet", "type":"video", "maxResults":10, "q":query, "regionCode":"DE", "relevanceLanguage":"de", "key":api_key})
    url = "https://www.googleapis.com/youtube/v3/search?" + params
    def fetch_results():
        request = UrlRequest(url, headers={"User-Agent":"ASCILINE/1.0"})
        with urlopen(request, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))
    try:
        data = await asyncio.to_thread(fetch_results)
        results = []
        for item in data.get("items", []):
            video_id = item.get("id", {}).get("videoId")
            snippet = item.get("snippet", {})
            if not video_id:
                continue
            thumbs = snippet.get("thumbnails", {})
            thumb = thumbs.get("medium") or thumbs.get("high") or thumbs.get("default") or {}
            results.append({"selection":_new_selection(video_id), "title":snippet.get("title", "Unbekanntes Video"), "channel":snippet.get("channelTitle", ""), "thumbnail":thumb.get("url", ""), "published_at":snippet.get("publishedAt", "")})
        return {"results":results}
    except HTTPError as exc:
        try:
            details = json.loads(exc.read().decode("utf-8"))
            api_message = details.get("error", {}).get("message", "")
        except Exception:
            api_message = ""
        log.warning("YouTube API HTTP %s: %s", exc.code, api_message)
        if exc.code == 403:
            return JSONResponse(status_code=502, content={"error":"YouTube hat die Suche abgelehnt. Prüfe API-Schlüssel, aktivierte YouTube Data API v3 und Tageskontingent."})
        return JSONResponse(status_code=502, content={"error":"Fehler bei der YouTube-Suche."})
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        log.warning("YouTube search request failed: %s", exc)
        return JSONResponse(status_code=502, content={"error":"YouTube ist momentan nicht erreichbar."})


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

@app.get("/watch")
async def watch_page():
    return FileResponse(os.path.join(STATIC_DIR, "watch.html"))


@app.get("/audio")
async def audio_stream(request: Request):
    session_id = request.query_params.get("session")
    if not session_id:
        return Response(status_code=400, content="missing session id")
    session = get_manager().get(session_id)
    if session is None:
        return Response(status_code=404, content="unknown or stale session id")
    audio_pipeline = session.audio_pipeline
    if audio_pipeline is None:
        return Response(status_code=503, content="audio pipeline not ready")

    return StreamingResponse(
        audio_pipeline.chunks(),
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _native_mp4_command(session: Session) -> list[str]:
    """Create a video-only fragmented MP4 stream for Canvas/WebCodecs.

    Video is stream-copied without re-encoding. Audio is delivered by the
    separate AudioPipeline endpoint, so including an audio track here only
    adds muxing work and can produce unnecessary MP4 codec warnings.
    """
    media = session.media
    if media is None:
        raise ValueError("media is not ready")

    return [
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin",
        "-thread_queue_size", "512",
        *_ffmpeg_input_header_args(media.video_headers),
        "-i", media.video_url,
        "-map", "0:v:0", "-an",
        "-c:v", "copy",
        "-sn", "-dn",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-flush_packets", "1",
        "-f", "mp4", "pipe:1",
    ]


async def _drain_native_ffmpeg_stderr(proc: asyncio.subprocess.Process, sid: str) -> None:
    """Drain stderr so FFmpeg cannot block; never log signed stream URLs."""
    if proc.stderr is None:
        return
    try:
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            message = line.decode("utf-8", errors="replace").strip()
            if message:
                log.warning("native Canvas ffmpeg session=%s: %s", sid, message[:600])
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.debug("native Canvas stderr reader ended for session=%s: %s", sid, exc)


async def _native_mp4_body(
    proc: asyncio.subprocess.Process,
    session: Session,
    stderr_task: asyncio.Task,
):
    """Stream fragmented MP4 chunks and tear FFmpeg down on disconnect/stop."""
    try:
        if proc.stdout is None:
            return
        while not session.cancel_event.is_set():
            chunk = await proc.stdout.read(64 * 1024)
            if not chunk:
                break
            yield chunk
    except asyncio.CancelledError:
        raise
    finally:
        if proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.5)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2)
                except asyncio.TimeoutError:
                    pass
        if not stderr_task.done():
            stderr_task.cancel()
        try:
            await stderr_task
        except (asyncio.CancelledError, Exception):
            pass


@app.get("/media")
async def native_canvas_media(request: Request):
    """Browser-native stream endpoint used only by Canvas mode."""
    session_id = request.query_params.get("session")
    if not session_id:
        return Response(status_code=400, content="missing session id")
    session = get_manager().get(session_id)
    if session is None or session.media is None:
        return Response(status_code=404, content="unknown or stale session id")
    if session.display_mode != "canvas":
        return Response(status_code=409, content="native media is only available in Canvas mode")

    try:
        command = _native_mp4_command(session)
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except Exception as exc:
        log.exception("could not start native Canvas FFmpeg process for session=%s", session_id)
        return Response(status_code=502, content="could not start native video stream")

    stderr_task = asyncio.create_task(_drain_native_ffmpeg_stderr(proc, session_id))
    log.info(
        "native Canvas stream opened session=%s format=%s separate_audio_url=%s",
        session_id, session.media.format_note, bool(session.media.audio_url),
    )
    return StreamingResponse(
        _native_mp4_body(proc, session, stderr_task),
        media_type="video/mp4",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Accept-Ranges": "none",
            "X-Content-Type-Options": "nosniff",
        },
    )


class AuthRequest(BaseModel):
    pin: str


@app.post("/api/auth")
async def api_auth(req: AuthRequest, request: Request):
    ip = auth._ip_from_scope(request.scope)

    if auth.is_locked_out(ip):
        return JSONResponse(
            status_code=429,
            content={"error": "too many attempts", "retry_after": auth._LOCKOUT_SECONDS},
        )

    if not auth.check_pin(req.pin):
        locked = auth.record_failure(ip)
        if locked:
            return JSONResponse(
                status_code=429,
                content={"error": "too many attempts", "retry_after": auth._LOCKOUT_SECONDS},
            )
        return JSONResponse(status_code=401, content={"error": "wrong pin"})

    auth.record_success(ip)
    cookie_value = auth.make_cookie_value()
    response = JSONResponse(content={"ok": True})
    # Mark Secure only when this request itself came in over https; over
    # plain http the browser would refuse to send a Secure cookie back on
    # the /audio GET.
    is_https = (
        request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto", "").lower() == "https"
    )
    response.headers["Set-Cookie"] = auth.cookie_header(cookie_value, secure=is_https)
    log.info("Successful auth from %s", ip)
    return response


class PlayRequest(BaseModel):
    query: str | None = None
    selection: str | None = None
    preset: str = DEFAULT_PRESET
    display_mode: str = "canvas"


@app.post("/api/play")
async def api_play(req: PlayRequest):
    preset_name = req.preset if req.preset in PRESETS else DEFAULT_PRESET
    display_mode = req.display_mode if req.display_mode in {"ascii", "canvas"} else "ascii"
    query = _resolve_selection(req.selection or "") if req.selection else (req.query or "").strip()
    if not query:
        return JSONResponse(status_code=400, content={"error": "Die Auswahl ist ungültig oder abgelaufen. Bitte suche das Video erneut."})
    mgr = get_manager()
    try:
        session = await mgr.play(query, preset_name, display_mode)
    except ResolverError as exc:
        return JSONResponse(
            status_code=422,
            content={"error": str(exc)},
        )

    if session.state == State.PLAYING and session.media is not None:
        preset_cfg = PRESETS[session.preset_name if session.preset_name in PRESETS else DEFAULT_PRESET]
        return {
            "session_id": session.session_id,
            "title": session.media.title,
            "is_live": session.media.is_live,
            "cols": preset_cfg["cols"],
            "rows": preset_cfg["rows"],
            "fps": preset_cfg["fps_cap"],
            "mode": preset_cfg["mode"],
            "display_mode": session.display_mode,
            "canvas_width": (CANVAS_PRESETS.get(preset_name) or CANVAS_PRESETS[DEFAULT_PRESET])["width"],
            "canvas_height": (CANVAS_PRESETS.get(preset_name) or CANVAS_PRESETS[DEFAULT_PRESET])["height"],
        }

    # Superseded during resolve (rare race — another Play beat us).
    return JSONResponse(
        status_code=409,
        content={"error": "session superseded by a newer play request"},
    )


@app.post("/api/stop")
async def api_stop():
    await get_manager().stop()
    return {"ok": True}


@app.get("/api/status")
async def api_status():
    return get_manager().status()


async def _run_video_ws(websocket: WebSocket, session: Session) -> None:
    """Stream ASCII-protocol or JPEG Canvas frames for an already-playing session."""
    preset_name = session.preset_name if session.preset_name in PRESETS else DEFAULT_PRESET
    preset_cfg = PRESETS[preset_name]
    preset = PresetSpec(
        cols=preset_cfg["cols"],
        rows=preset_cfg["rows"],
        fps_cap=preset_cfg["fps_cap"],
        mode=preset_cfg["mode"],
    )

    await websocket.accept()

    pipeline = session.pipeline
    if pipeline is None or session.state != State.PLAYING:
        await websocket.send_text("Error: session not ready")
        await websocket.close()
        return

    try:
        await websocket.send_text(pipeline.init_message())

        first_frame_logged = False
        deflate_negotiated = _ws_offered_deflate(websocket)
        async for payload in pipeline.frames():
            if websocket.client_state != WebSocketState.CONNECTED:
                break
            if session.cancel_event.is_set():
                break
            await websocket.send_bytes(payload)
            pipeline.frames_sent += 1
            if not first_frame_logged:
                import zlib
                approx = len(zlib.compress(payload, 6))
                log.info(
                    "first frame: raw=%d bytes deflate≈%d bytes "
                    "(ratio=%.2f) preset=%s permessage-deflate=%s",
                    len(payload), approx, approx / max(1, len(payload)),
                    preset_name, deflate_negotiated,
                )
                first_frame_logged = True

    except (WebSocketDisconnect, ConnectionError):
        log.info("ws client disconnected")
    except Exception:
        log.exception("video ws error")
    finally:
        if websocket.client_state == WebSocketState.CONNECTED:
            try:
                await websocket.close()
            except Exception:
                pass


def _ws_offered_deflate(websocket: WebSocket) -> bool:
    headers = dict(websocket.scope.get("headers") or [])
    raw = headers.get(b"sec-websocket-extensions", b"")
    return b"permessage-deflate" in raw.lower()


async def _reject_ws(websocket: WebSocket, reason: str) -> None:
    await websocket.accept()
    await websocket.send_text(f"Error: {reason}")
    await websocket.close()


@app.websocket("/ws/video")
async def ws_video(websocket: WebSocket):
    if not auth.is_authenticated(websocket.scope):
        await websocket.close(code=4003)
        return

    session_id = websocket.query_params.get("session")
    if not session_id:
        await _reject_ws(websocket, "missing session id — call /api/play first")
        return
    session = get_manager().get(session_id)
    if session is None:
        await _reject_ws(websocket, f"unknown or stale session id: {session_id!r}")
        return
    await _run_video_ws(websocket, session)


def main() -> None:
    parser = argparse.ArgumentParser(description="ASCILINE YouTube Streamer")
    parser.add_argument("--port", type=int, default=SERVER_DEFAULTS["port"])
    parser.add_argument("--bind", default=SERVER_DEFAULTS["bind"])
    parser.add_argument(
        "--max-source-height", type=int, default=SERVER_DEFAULTS["max_source_height"]
    )
    parser.add_argument(
        "--pin",
        default=os.environ.get("ASCIILINE_PIN"),
        help="4–8 digit PIN (or set ASCIILINE_PIN env var)",
    )
    args = parser.parse_args()

    check_ffmpeg()

    if not args.pin:
        print(
            "ERROR: PIN required. Pass --pin <4-8 digits> or set ASCIILINE_PIN.",
            file=sys.stderr,
        )
        sys.exit(1)

    auth.init()
    auth.set_pin(args.pin)
    init_manager(max_source_height=args.max_source_height)

    print(f"ASCILINE starting on http://{args.bind}:{args.port}")
    uvicorn.run(
        app,
        host=args.bind,
        port=args.port,
        ws_ping_interval=None,
        ws_ping_timeout=None,
        ws_per_message_deflate=True,
        log_level="info",
    )


if __name__ == "__main__":
    main()
