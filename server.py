"""FastAPI application entry point.

Every route is gated by AuthMiddleware: HTTP gets the PIN page or 403,
WebSocket upgrades close with 4003.  /api/auth is exempt so the PIN can
be submitted in the first place.
"""

from __future__ import annotations

import argparse
import atexit
import logging
import os
import shutil
import signal
import sys
from contextlib import asynccontextmanager

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
from config import PRESETS, DEFAULT_PRESET, SERVER_DEFAULTS
from pipeline import PresetSpec
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

        if path == "/audio":
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


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


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
        media_type="audio/aac",
        headers={
            "Cache-Control": "no-cache",
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
    query: str
    preset: str = DEFAULT_PRESET


@app.post("/api/play")
async def api_play(req: PlayRequest):
    preset_name = req.preset if req.preset in PRESETS else DEFAULT_PRESET
    mgr = get_manager()
    try:
        session = await mgr.play(req.query, preset_name)
    except ResolverError as exc:
        return JSONResponse(
            status_code=422,
            content={"error": str(exc), "query": req.query},
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
    """Stream ASCII frames for an already-playing session."""
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
