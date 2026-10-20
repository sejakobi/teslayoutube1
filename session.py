"""Single-active-session state machine.

States: idle | resolving | playing | error(message).  Exactly one session
can be active at a time; a new play() terminates the previous session's
pipeline before starting the new one.  Pipeline teardown is dispatched
as a background task so /api/play returns quickly while the previous
ffmpeg exits.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import uuid
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Optional

from config import PRESETS, CANVAS_PRESETS, DEFAULT_PRESET, SERVER_DEFAULTS
from pipeline import AudioPipeline, PresetSpec, VideoPipeline
from resolver import ResolvedMedia, ResolverError, resolve

log = logging.getLogger("session")


class State(Enum):
    IDLE = auto()
    RESOLVING = auto()
    PLAYING = auto()
    ERROR = auto()


@dataclass
class Session:
    session_id: str
    query: str
    preset_name: str
    display_mode: str = "ascii"
    state: State = State.RESOLVING
    error_msg: str = ""
    media: Optional[ResolvedMedia] = None
    pipeline: Optional[VideoPipeline] = None
    audio_pipeline: Optional[AudioPipeline] = None
    # Set when the session is superseded or stopped.
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)


class SessionManager:
    """Single-session lifecycle manager.

    All methods are called from asyncio tasks on a single event loop.
    Pipeline stop() calls are dispatched as background tasks so the state
    machine never blocks waiting for ffmpeg to exit.
    """

    def __init__(self, max_source_height: int = SERVER_DEFAULTS["max_source_height"]):
        self._max_height = max_source_height
        self._current: Optional[Session] = None
        self._lock = asyncio.Lock()

    async def play(self, query: str, preset_name: str, display_mode: str = "ascii") -> Session:
        """Start a new session.

        Kills the previous session, resolves the query, starts the
        pipeline, returns a Session with state=PLAYING.  Raises
        ResolverError if resolution fails (state set to ERROR first).
        """
        async with self._lock:
            await self._kill_current()

            session_id = uuid.uuid4().hex[:16]
            session = Session(
                session_id=session_id,
                query=query,
                preset_name=preset_name,
                display_mode="canvas" if display_mode == "canvas" else "ascii",
            )
            self._current = session
            log.info("session %s: resolving %r preset=%s", session_id, query, preset_name)

        # Resolve outside the lock so a hammered Play can supersede us.
        # Native Canvas playback uses browser-compatible H.264/AAC media and
        # lets the browser decode frames; keep the existing ASCII selection.
        requested_height = self._max_height
        if session.display_mode == "canvas":
            canvas_cfg = CANVAS_PRESETS.get(preset_name) or CANVAS_PRESETS[DEFAULT_PRESET]
            requested_height = min(self._max_height, int(canvas_cfg["height"]))
        try:
            media = await asyncio.to_thread(
                resolve,
                query,
                requested_height,
                prefer_native=False,
            )
        except ResolverError as exc:
            async with self._lock:
                if self._current is session:
                    session.state = State.ERROR
                    session.error_msg = str(exc)
            raise

        async with self._lock:
            if self._current is not session:
                log.info("session %s superseded during resolve — discarding", session_id)
                return session

            pipeline = None
            audio_pipeline = None

            preset_cfg = PRESETS.get(preset_name) or PRESETS[DEFAULT_PRESET]
            preset = PresetSpec(
                cols=preset_cfg["cols"],
                rows=preset_cfg["rows"],
                fps_cap=preset_cfg["fps_cap"],
                mode=preset_cfg["mode"],
            )

            if session.display_mode == "canvas":
                canvas_cfg = CANVAS_PRESETS.get(preset_name) or CANVAS_PRESETS[DEFAULT_PRESET]
                pipeline = VideoPipeline(
                    media.video_url,
                    preset,
                    headers=media.video_headers,
                    display_mode="canvas",
                    frame_width=int(canvas_cfg["width"]),
                    frame_height=int(canvas_cfg["height"]),
                    fps_cap=int(canvas_cfg["fps_cap"]),
                    jpeg_quality=int(canvas_cfg.get("jpeg_quality", 75)),
                )
            else:
                pipeline = VideoPipeline(
                    media.video_url,
                    preset,
                    headers=media.video_headers,
                    display_mode="ascii",
                )
            # Canvas now consumes the fragmented-MP4 endpoint and decodes video
            # in the browser with WebCodecs; do not also run the JPEG/WebSocket
            # pipeline in parallel. ASCII mode keeps the legacy pipeline.
            if session.display_mode == "ascii":
                pipeline.start()
            else:
                pipeline = None

            # Keep the separate audio endpoint for broad desktop compatibility.
            audio_src = media.audio_url if media.audio_url else media.video_url
            audio_headers = media.audio_headers if media.audio_url else media.video_headers
            audio_pipeline = AudioPipeline(audio_src, headers=audio_headers)
            audio_pipeline.start()
            if session.display_mode == "canvas":
                log.info(
                    "session %s: WebCodecs Canvas selected %dx%d; fragmented MP4 + separate audio started",
                    session_id, int(canvas_cfg["width"]), int(canvas_cfg["height"]),
                )

            session.media = media
            session.pipeline = pipeline
            session.audio_pipeline = audio_pipeline
            session.state = State.PLAYING

            log.info(
                "session %s: playing %r is_live=%s title=%r",
                session_id, query, media.is_live, media.title,
            )

        return session

    async def stop(self) -> None:
        async with self._lock:
            await self._kill_current()

    def get(self, session_id: str) -> Optional[Session]:
        sess = self._current
        if sess is not None and sess.session_id == session_id:
            return sess
        return None

    @property
    def current(self) -> Optional[Session]:
        return self._current

    def status(self) -> dict:
        sess = self._current
        if sess is None:
            return {"state": "idle", "session_id": None, "title": None}
        state_str = {
            State.IDLE: "idle",
            State.RESOLVING: "resolving",
            State.PLAYING: "playing",
            State.ERROR: "error",
        }.get(sess.state, "unknown")
        result: dict = {"state": state_str, "session_id": sess.session_id}
        if sess.state == State.ERROR:
            result["error"] = sess.error_msg
        if sess.media:
            result["title"] = sess.media.title
            result["is_live"] = sess.media.is_live
        else:
            result["title"] = None
        return result

    async def _kill_current(self) -> None:
        """Signal the current session to stop and dispatch teardown.

        Must be called with self._lock held.  Returns immediately; the
        teardown task runs concurrently so callers are not delayed.
        """
        sess = self._current
        if sess is None:
            return
        sess.cancel_event.set()
        pipeline = sess.pipeline
        audio_pipeline = sess.audio_pipeline
        if pipeline is not None:
            sess.pipeline = None
            asyncio.ensure_future(_stop_pipeline(pipeline, sess.session_id))
        if audio_pipeline is not None:
            sess.audio_pipeline = None
            asyncio.ensure_future(_stop_audio_pipeline(audio_pipeline, sess.session_id))
        self._current = None

    def stop_sync(self) -> None:
        """Synchronous teardown for atexit / signal handlers.

        Sends SIGTERM to both pipelines first, then waits on each, so the
        worst-case time is max(video_wait, audio_wait), not their sum.
        """
        sess = self._current
        if sess is None:
            return
        sess.cancel_event.set()
        pipeline = sess.pipeline
        audio_pipeline = sess.audio_pipeline
        sess.pipeline = None
        sess.audio_pipeline = None

        if pipeline is not None:
            log.info("atexit: terminating session %s video pipeline", sess.session_id)
            pipeline._stop.set()
            proc = pipeline._proc
            if proc and proc.poll() is None:
                try:
                    proc.terminate()
                except Exception:
                    pass
        if audio_pipeline is not None:
            log.info("atexit: terminating session %s audio pipeline", sess.session_id)
            audio_pipeline._stop.set()
            aproc = audio_pipeline._proc
            if aproc and aproc.poll() is None:
                try:
                    aproc.terminate()
                except Exception:
                    pass

        import subprocess as _sp
        if pipeline is not None and pipeline._proc:
            try:
                pipeline._proc.wait(timeout=3)
            except _sp.TimeoutExpired:
                try:
                    pipeline._proc.kill()
                    pipeline._proc.wait(timeout=2)
                except Exception:
                    pass
        if audio_pipeline is not None and audio_pipeline._proc:
            try:
                audio_pipeline._proc.wait(timeout=3)
            except _sp.TimeoutExpired:
                try:
                    audio_pipeline._proc.kill()
                    audio_pipeline._proc.wait(timeout=2)
                except Exception:
                    pass
        log.info("atexit: both pipelines stopped")


async def _stop_pipeline(pipeline: VideoPipeline, session_id: str) -> None:
    log.info("session %s: tearing down pipeline in background", session_id)
    await asyncio.to_thread(pipeline.stop)
    log.info("session %s: pipeline torn down", session_id)


async def _stop_audio_pipeline(pipeline: AudioPipeline, session_id: str) -> None:
    log.info("session %s: tearing down audio pipeline in background", session_id)
    await asyncio.to_thread(pipeline.stop)
    log.info("session %s: audio pipeline torn down", session_id)


# Module-level singleton: server.py imports it; signal handlers register here.
_manager: Optional[SessionManager] = None


def init_manager(max_source_height: int = SERVER_DEFAULTS["max_source_height"]) -> SessionManager:
    global _manager
    _manager = SessionManager(max_source_height=max_source_height)
    return _manager


def get_manager() -> SessionManager:
    if _manager is None:
        raise RuntimeError("SessionManager not initialised — call init_manager() first")
    return _manager


def _atexit_cleanup() -> None:
    if _manager is not None:
        _manager.stop_sync()


def _signal_handler(signum: int, frame) -> None:
    import os
    log.info("received signal %d — stopping pipeline before exit", signum)
    if _manager is not None:
        _manager.stop_sync()
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)
