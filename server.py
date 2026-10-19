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
import re
import shutil
import signal
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
async def api_search(
    q: str = "",
    search_type: str = "video",
    page_token: str = "",
    channel_id: str = "",
    uploads_playlist_id: str = "",
    order: str = "relevance",
    max_results: int = 25,
):
    """Search videos/channels and page through all public channel uploads."""
    query = q.strip()
    kind = (search_type or "video").strip().lower()
    channel_id = channel_id.strip()
    uploads_playlist_id = uploads_playlist_id.strip()
    page_token = page_token.strip()

    if kind not in {"video", "channel"}:
        return JSONResponse(status_code=400, content={"error": "Ungültiger Suchtyp."})
    if channel_id:
        # Channel browsing uses the channel's uploads playlist, not search relevance.
        kind = "video"
        if len(channel_id) > 200:
            return JSONResponse(status_code=400, content={"error": "Die Kanal-ID ist ungültig."})
    elif not query:
        return JSONResponse(status_code=400, content={"error": "Bitte einen Suchbegriff eingeben."})
    if len(query) > 200:
        return JSONResponse(status_code=400, content={"error": "Der Suchbegriff ist zu lang."})
    if len(page_token) > 2048:
        return JSONResponse(status_code=400, content={"error": "Ungültiger Seitentoken."})

    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        return JSONResponse(status_code=503, content={"error": "YOUTUBE_API_KEY ist auf dem Server nicht konfiguriert."})

    per_page = max(1, min(int(max_results), 50))

    def api_get(resource: str, request_params: dict):
        params = dict(request_params)
        params["key"] = api_key
        url = "https://www.googleapis.com/youtube/v3/" + resource + "?" + urlencode(params)
        request = UrlRequest(url, headers={"User-Agent": "ASCILINE/1.0"})
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))

    def fetch_results():
        if channel_id:
            playlist_id = uploads_playlist_id
            if not playlist_id:
                channel_data = api_get("channels", {"part": "contentDetails", "id": channel_id})
                channel_items = channel_data.get("items", [])
                if not channel_items:
                    raise ValueError("YouTube-Kanal wurde nicht gefunden oder ist nicht öffentlich.")
                playlist_id = channel_items[0].get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads", "")
                if not playlist_id:
                    raise ValueError("Für diesen Kanal wurde keine Uploads-Playlist gefunden.")

            playlist_params = {"part": "snippet,contentDetails", "playlistId": playlist_id, "maxResults": per_page}
            if page_token:
                playlist_params["pageToken"] = page_token
            result = api_get("playlistItems", playlist_params)
            result["_asciline_uploads_playlist_id"] = playlist_id
            return result

        search_params = {"part": "snippet", "type": kind, "maxResults": per_page}
        if query:
            search_params["q"] = query
        if page_token:
            search_params["pageToken"] = page_token
        if kind == "video":
            search_params["regionCode"] = "DE"
            search_params["relevanceLanguage"] = "de"
        return api_get("search", search_params)

    try:
        data = await asyncio.to_thread(fetch_results)
        results = []
        for item in data.get("items", []):
            item_id = item.get("id", {})
            snippet = item.get("snippet", {})
            thumbs = snippet.get("thumbnails", {})
            thumb = thumbs.get("medium") or thumbs.get("high") or thumbs.get("default") or {}
            published_at = snippet.get("publishedAt", "")

            if kind == "channel":
                result_channel_id = item_id.get("channelId")
                if not result_channel_id:
                    continue
                title = snippet.get("title", "Unbekannter Kanal")
                results.append({
                    "result_type": "channel",
                    "channel_id": result_channel_id,
                    "title": title,
                    "channel": title,
                    "description": snippet.get("description", ""),
                    "thumbnail": thumb.get("url", ""),
                    "published_at": published_at,
                })
            else:
                if channel_id:
                    video_id = item.get("contentDetails", {}).get("videoId") or snippet.get("resourceId", {}).get("videoId")
                else:
                    video_id = item_id.get("videoId")
                if not video_id:
                    continue
                results.append({
                    "result_type": "video",
                    "video_id": video_id,
                    "channel_id": snippet.get("channelId", channel_id),
                    "title": snippet.get("title", "Unbekanntes Video"),
                    "channel": snippet.get("channelTitle", ""),
                    "description": snippet.get("description", ""),
                    "thumbnail": thumb.get("url", ""),
                    "published_at": published_at,
                })

        page_info = data.get("pageInfo", {})
        response_data = {
            "results": results,
            "next_page_token": data.get("nextPageToken", ""),
            "total_results": page_info.get("totalResults", len(results)),
            "results_per_page": page_info.get("resultsPerPage", len(results)),
            "search_type": kind,
        }
        if channel_id:
            response_data["uploads_playlist_id"] = data.get("_asciline_uploads_playlist_id", uploads_playlist_id)
        return response_data
    except HTTPError as exc:
        try:
            details = json.loads(exc.read().decode("utf-8"))
            api_message = details.get("error", {}).get("message", "")
        except Exception:
            api_message = ""
        log.warning("YouTube API HTTP %s: %s", exc.code, api_message)
        if exc.code == 403:
            return JSONResponse(status_code=502, content={"error": "YouTube hat die Suche abgelehnt. Prüfe API-Schlüssel, aktivierte YouTube Data API v3 und Tageskontingent."})
        if exc.code == 400 and page_token:
            return JSONResponse(status_code=400, content={"error": "Diese Ergebnisseite ist nicht mehr verfügbar. Bitte suche erneut."})
        return JSONResponse(status_code=502, content={"error": "Fehler bei der YouTube-Suche."})
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        log.warning("YouTube search request failed: %s", exc)
        if isinstance(exc, ValueError) and (str(exc).startswith("YouTube-Kanal") or str(exc).startswith("Für diesen Kanal")):
            return JSONResponse(status_code=404, content={"error": str(exc)})
        return JSONResponse(status_code=502, content={"error": "YouTube ist momentan nicht erreichbar."})


@app.get("/api/video-info")
async def api_video_info(video_id: str = ""):
    """Return the public channel metadata for a video using YouTube Data API v3."""
    video_id = (video_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", video_id):
        return JSONResponse(status_code=400, content={"error": "Ungültige Video-ID."})

    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        return JSONResponse(status_code=503, content={"error": "YOUTUBE_API_KEY ist auf dem Server nicht konfiguriert."})

    def fetch_video_info():
        params = urlencode({"part": "snippet", "id": video_id, "key": api_key})
        url = "https://www.googleapis.com/youtube/v3/videos?" + params
        request = UrlRequest(url, headers={"User-Agent": "CyberCinema/1.0"})
        with urlopen(request, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))

    try:
        data = await asyncio.to_thread(fetch_video_info)
        items = data.get("items", [])
        if not items:
            return JSONResponse(status_code=404, content={"error": "Für dieses Video wurden keine öffentlichen Kanaldaten gefunden."})
        snippet = items[0].get("snippet", {})
        channel_id = snippet.get("channelId", "")
        channel_title = snippet.get("channelTitle", "YouTube-Kanal")
        if not channel_id:
            return JSONResponse(status_code=404, content={"error": "Für dieses Video wurde kein Kanal gefunden."})
        return {"video_id": video_id, "channel_id": channel_id, "channel_title": channel_title}
    except HTTPError as exc:
        try:
            details = json.loads(exc.read().decode("utf-8"))
            api_message = details.get("error", {}).get("message", "")
        except Exception:
            api_message = ""
        log.warning("YouTube video-info API HTTP %s: %s", exc.code, api_message)
        if exc.code == 403:
            return JSONResponse(status_code=502, content={"error": "YouTube-Metadaten nicht verfügbar. Prüfe API-Schlüssel und Kontingent."})
        return JSONResponse(status_code=502, content={"error": "Fehler beim Abrufen der YouTube-Kanaldaten."})
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        log.warning("YouTube video-info request failed: %s", exc)
        return JSONResponse(status_code=502, content={"error": "YouTube-Kanaldaten sind momentan nicht erreichbar."})


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
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _native_mp4_command(session: Session, start_seconds: float = 0.0) -> list[str]:
    """Create a stream-copy FFmpeg remux for browser-native Canvas playback.

    No video re-encoding occurs here. YouTube's H.264/AAC tracks are muxed into
    fragmented MP4 so the browser can decode them natively while JavaScript
    draws each decoded frame to the visible Canvas.
    """
    media = session.media
    if media is None:
        raise ValueError("media is not ready")

    # Seeking restarts this one-shot stream at a new input position.  The
    # browser stream itself is intentionally non-range/streaming; the progress
    # slider requests a fresh FFmpeg process at the chosen media timestamp.
    start_seconds = max(0.0, float(start_seconds or 0.0))
    video_seek_args = ["-ss", f"{start_seconds:.3f}"] if start_seconds > 0 else []
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin",
        "-thread_queue_size", "512",
        *_ffmpeg_input_header_args(media.video_headers),
        *video_seek_args,
        "-i", media.video_url,
    ]
    if media.audio_url:
        audio_seek_args = ["-ss", f"{start_seconds:.3f}"] if start_seconds > 0 else []
        cmd.extend([
            "-thread_queue_size", "512",
            *_ffmpeg_input_header_args(media.audio_headers),
            *audio_seek_args,
            "-i", media.audio_url,
            "-map", "0:v:0", "-map", "1:a:0",
        ])
    else:
        # Optional audio map means a progressive video-only format still works,
        # while muxed MP4 sources keep their original audio track.
        cmd.extend(["-map", "0:v:0", "-map", "0:a:0?"])

    cmd.extend([
        "-c:v", "copy", "-c:a", "copy",
        "-sn", "-dn",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-flush_packets", "1",
        "-f", "mp4", "pipe:1",
    ])
    return cmd


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
    try:
        start_seconds = max(0.0, float(request.query_params.get("start", "0")))
    except (TypeError, ValueError):
        return Response(status_code=400, content="invalid start time")
    session = get_manager().get(session_id)
    if session is None or session.media is None:
        return Response(status_code=404, content="unknown or stale session id")
    if session.display_mode != "canvas":
        return Response(status_code=409, content="native media is only available in Canvas mode")

    if session.media.is_live:
        start_seconds = 0.0
    elif session.media.duration and session.media.duration > 0:
        start_seconds = min(start_seconds, max(0.0, float(session.media.duration) - 0.5))

    try:
        command = _native_mp4_command(session, start_seconds)
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
        "native Canvas stream opened session=%s format=%s muxed_audio=%s",
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
    query: str
    preset: str = DEFAULT_PRESET
    display_mode: str = "ascii"


@app.post("/api/play")
async def api_play(req: PlayRequest):
    preset_name = req.preset if req.preset in PRESETS else DEFAULT_PRESET
    display_mode = req.display_mode if req.display_mode in {"ascii", "canvas"} else "ascii"
    mgr = get_manager()
    try:
        session = await mgr.play(req.query, preset_name, display_mode)
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
            "display_mode": session.display_mode,
            "canvas_width": (CANVAS_PRESETS.get(preset_name) or CANVAS_PRESETS[DEFAULT_PRESET])["width"],
            "canvas_height": (CANVAS_PRESETS.get(preset_name) or CANVAS_PRESETS[DEFAULT_PRESET])["height"],
            "duration": session.media.duration,
            "video_id": session.media.video_id,
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
