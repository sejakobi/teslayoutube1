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
    """Enforce the PIN cookie on every route."""

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
async def api_search(q: str = "", search_type: str = "video", channel_id: str = "", uploads_playlist_id: str = "", page_token: str = ""):
    """YouTube Data API v3 Wrapper für Videos, Kanäle und Kanal-Uploads."""
    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        return JSONResponse(status_code=503, content={"error": "YOUTUBE_API_KEY ist auf dem Server nicht konfiguriert."})

    params = {"key": api_key, "maxResults": "25"}
    if page_token:
        params["pageToken"] = page_token

    if channel_id and uploads_playlist_id:
        url = "https://www.googleapis.com/youtube/v3/playlistItems?" + urlencode({**params, "part": "snippet,contentDetails", "playlistId": uploads_playlist_id})
    elif channel_id:
        chan_url = "https://www.googleapis.com/youtube/v3/channels?" + urlencode({"key": api_key, "part": "contentDetails,snippet", "id": channel_id})
        try:
            chan_data = await asyncio.to_thread(lambda: json.loads(urlopen(UrlRequest(chan_url, headers={"User-Agent": "ASCILINE/1.0"}), timeout=10).read().decode("utf-8")))
            items = chan_data.get("items", [])
            if not items:
                return {"results": []}
            uploads_id = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]
            return await api_search(channel_id=channel_id, uploads_playlist_id=uploads_id)
        except Exception:
            return JSONResponse(status_code=502, content={"error": "Kanal konnte nicht geladen werden."})
    else:
        query = q.strip()
        if not query:
            return JSONResponse(status_code=400, content={"error": "Bitte einen Suchbegriff eingeben."})
        stype = "channel" if search_type == "channel" else "video"
        url = "https://www.googleapis.com/youtube/v3/search?" + urlencode({**params, "part": "snippet", "type": stype, "q": query, "regionCode": "DE", "relevanceLanguage": "de"})

    def fetch_results():
        with urlopen(UrlRequest(url, headers={"User-Agent": "ASCILINE/1.0"}), timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))

    try:
        data = await asyncio.to_thread(fetch_results)
        results = []
        for item in data.get("items", []):
            snippet = item.get("snippet", {})
            thumbs = snippet.get("thumbnails", {})
            thumb = thumbs.get("medium") or thumbs.get("high") or thumbs.get("default") or {}
            
            if channel_id and uploads_playlist_id:
                vid = item.get("contentDetails", {}).get("videoId") or snippet.get("resourceId", {}).get("videoId")
                if not vid: continue
                results.append({
                    "selection": _new_selection(vid),
                    "title": snippet.get("title", "Video"),
                    "channel": snippet.get("channelTitle", ""),
                    "thumbnail": thumb.get("url", ""),
                    "published_at": snippet.get("publishedAt", ""),
                    "result_type": "video"
                })
            else:
                id_info = item.get("id", {})
                res_type = id_info.get("kind", "").split("#")[-1]
                if res_type == "channel":
                    cid = id_info.get("channelId")
                    if not cid: continue
                    results.append({
                        "channel_id": cid,
                        "title": snippet.get("title", "Kanal"),
                        "description": snippet.get("description", ""),
                        "thumbnail": thumb.get("url", ""),
                        "result_type": "channel"
                    })
                else:
                    vid = id_info.get("videoId")
                    if not vid: continue
                    results.append({
                        "selection": _new_selection(vid),
                        "title": snippet.get("title", "Video"),
                        "channel": snippet.get("channelTitle", ""),
                        "thumbnail": thumb.get("url", ""),
                        "published_at": snippet.get("publishedAt", ""),
                        "result_type": "video"
                    })

        return {
            "results": results,
            "next_page_token": data.get("nextPageToken", ""),
            "total_results": data.get("pageInfo", {}).get("totalResults", 0),
            "uploads_playlist_id": uploads_playlist_id
        }
    except Exception as exc:
        log.warning("YouTube search request failed: %s", exc)
        return JSONResponse(status_code=502, content={"error": "YouTube ist momentan nicht erreichbar."})


@app.get("/api/video-info")
async def api_video_info(video_id: str):
    """Liefert Kanal-Metadaten zu einem Video für den Creator-Banner."""
    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key or not video_id:
        return {}
    url = "https://www.googleapis.com/youtube/v3/videos?" + urlencode({"key": api_key, "part": "snippet", "id": video_id})
    try:
        def fetch():
            with urlopen(UrlRequest(url, headers={"User-Agent": "ASCILINE/1.0"}), timeout=8) as r:
                return json.loads(r.read().decode("utf-8"))
        data = await asyncio.to_thread(fetch)
        items = data.get("items", [])
        if not items: return {}
        snip = items[0].get("snippet", {})
        return {
            "channel_id": snip.get("channelId", ""),
            "title": snip.get("channelTitle", "")
        }
    except Exception:
        return {}


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

    # Als neutraler Binärstrom getarnt, um Browser-Media-Sperren zu umgehen
    return StreamingResponse(
        audio_pipeline.chunks(),
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _native_mp4_command(session: Session) -> list[str]:
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
    
    return StreamingResponse(
        _native_mp4_body(proc, session, stderr_task),
        media_type="application/octet-stream",
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
    is_https = (
        request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto", "").lower() == "https"
    )
    response.headers["Set-Cookie"] = auth.cookie_header(cookie_value, secure=is_https)
    return response


class PlayRequest(BaseModel):
    query: str | None = None
    selection: str | None = None
    preset: str = DEFAULT_PRESET
    display_mode: str = "canvas"


@app.post("/api/play")
async def api_play(req: PlayRequest):
    preset_name = req.preset if req.preset in PRESETS else DEFAULT_PRESET
    display_mode = req.display_mode if req.display_mode in {"ascii", "canvas"} else "canvas"
    query = _resolve_selection(req.selection or "") if req.selection else (req.query or "").strip()
    if not query:
        return JSONResponse(status_code=400, content={"error": "Die Auswahl ist ungültig oder abgelaufen."})
    mgr = get_manager()
    try:
        session = await mgr.play(query, preset_name, display_mode)
    except ResolverError as exc:
        return JSONResponse(status_code=422, content={"error": str(exc)})

    if session.state == State.PLAYING and session.media is not None:
        preset_cfg = PRESETS[session.preset_name if session.preset_name in PRESETS else DEFAULT_PRESET]
        return {
            "session_id": session.session_id,
            "title": session.media.title,
            "is_live": session.media.is_live,
            "duration": session.media.duration or 0,
            "video_id": session.media.video_id,
            "cols": preset_cfg["cols"],
            "rows": preset_cfg["rows"],
            "fps": preset_cfg["fps_cap"],
            "mode": preset_cfg["mode"],
            "display_mode": session.display_mode,
            "canvas_width": (CANVAS_PRESETS.get(preset_name) or CANVAS_PRESETS[DEFAULT_PRESET])["width"],
            "canvas_height": (CANVAS_PRESETS.get(preset_name) or CANVAS_PRESETS[DEFAULT_PRESET])["height"],
        }

    return JSONResponse(status_code=409, content={"error": "superseded"})


@app.post("/api/stop")
async def api_stop():
    await get_manager().stop()
    return {"ok": True}


@app.get("/api/status")
async def api_status():
    return get_manager().status()


async def _run_video_ws(websocket: WebSocket, session: Session) -> None:
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
        async for payload in pipeline.frames():
            if websocket.client_state != WebSocketState.CONNECTED:
                break
            if session.cancel_event.is_set():
                break
            await websocket.send_bytes(payload)
            pipeline.frames_sent += 1
    except (WebSocketDisconnect, ConnectionError):
        pass
    except Exception:
        log.exception("video ws error")
    finally:
        if websocket.client_state == WebSocketState.CONNECTED:
            try:
                await websocket.close()
            except Exception:
                pass


@app.websocket("/ws/video")
async def ws_video(websocket: WebSocket):
    if not auth.is_authenticated(websocket.scope):
        await websocket.close(code=4003)
        return

    session_id = websocket.query_params.get("session")
    if not session_id:
        await websocket.close(code=4003)
        return
    session = get_manager().get(session_id)
    if session is None:
        await websocket.close(code=4003)
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
        help="4–8 digit PIN",
    )
    args = parser.parse_args()

    check_ffmpeg()

    if not args.pin:
        print("ERROR: PIN required.", file=sys.stderr)
        sys.exit(1)

    auth.init()
    auth.set_pin(args.pin)
    init_manager(max_source_height=args.max_source_height)

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
