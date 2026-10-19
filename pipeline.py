"""Video and audio pipelines.

Video: FFmpeg reads the resolved media URL in realtime and scales it to the
selected size and frame rate. ASCII mode emits raw BGR24 frames; Canvas mode
emits native MJPEG frames directly from FFmpeg. Sending MJPEG avoids copying
raw frames into Python and re-encoding every frame with OpenCV. Frames are
read on a worker thread and sent over WebSocket with a 4-byte frame index.

Audio: a second ffmpeg encodes the selected audio source as MP3 and pipes
chunks to the /audio HTTP endpoint. Stream-specific HTTP headers from yt-dlp
are forwarded to FFmpeg for the YouTube CDN requests.
"""

from __future__ import annotations

import asyncio
import logging
import struct
import subprocess
import threading
from dataclasses import dataclass
from typing import AsyncIterator, Optional

import cv2
import numpy as np

from vendor.asciline.ascii_video_player2 import AsciiMapper

log = logging.getLogger("pipeline")

# Quantisation bits per render mode (PROTOCOL-NOTES §4).  Mode 2 = 5 bits
# stripped → 8-color-per-channel = 512 colors.  Mode 3 = 3 bits → 32 K.
_QB_BY_MODE = {1: 0, 2: 5, 3: 3, 4: 2, 5: 0}

# At-most-this-many encoded frames waiting for the consumer.  With ffmpeg
# `-re` paced at the source frame rate the queue rarely exceeds 1.
_FRAME_QUEUE_MAX = 2

_AUDIO_CHUNK_SIZE = 4096


@dataclass
class PresetSpec:
    cols: int
    rows: int
    fps_cap: int
    mode: int          # 1-5; we ship 2 (Low) and 3 (Med/High)


def _ffmpeg_input_header_args(headers: Optional[dict[str, str]]) -> list[str]:
    """Translate yt-dlp request headers into FFmpeg HTTP input options."""
    normalised: dict[str, tuple[str, str]] = {}
    for key, value in (headers or {}).items():
        if not key or value is None:
            continue
        name = str(key).strip()
        if not name or "\r" in name or "\n" in name or ":" in name:
            continue
        text_value = str(value).replace("\r", "").replace("\n", "")
        normalised[name.lower()] = (name, text_value)

    args: list[str] = []
    user_agent = normalised.pop("user-agent", None)
    referer = normalised.pop("referer", None)
    if user_agent and user_agent[1]:
        args.extend(["-user_agent", user_agent[1]])
    if referer and referer[1]:
        args.extend(["-referer", referer[1]])

    # FFmpeg expects each custom HTTP header to end in CRLF. These are input
    # options and therefore must appear before the corresponding -i argument.
    if normalised:
        raw_headers = "".join(
            f"{original_name}: {value}\r\n"
            for original_name, value in normalised.values()
        )
        args.extend(["-headers", raw_headers])
    return args


def _build_ffmpeg_cmd(
    media_url: str,
    preset: PresetSpec,
    headers: Optional[dict[str, str]] = None,
    *,
    display_mode: str = "ascii",
    frame_width: Optional[int] = None,
    frame_height: Optional[int] = None,
    fps_cap: Optional[int] = None,
    jpeg_quality: int = 80,
) -> list[str]:
    """Build an FFmpeg command for ASCII raw frames or Canvas MJPEG frames."""
    if display_mode == "canvas":
        width = int(frame_width or 640)
        height = int(frame_height or 360)
        fps = max(1, min(30, int(fps_cap or preset.fps_cap)))
        video_filter = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black"
        )
        # FFmpeg's MJPEG qscale runs in the opposite direction to a typical
        # JPEG quality slider: 2 is high quality, 31 is small/low quality.
        # A modest qscale keeps 25 FPS practical without inflating WebSocket data.
        quality = max(40, min(95, int(jpeg_quality)))
        qscale = max(2, min(9, int(round(2 + (100 - quality) * 0.16))))
    else:
        width, height, fps = preset.cols, preset.rows, preset.fps_cap
        video_filter = f"scale={width}:{height}:flags=fast_bilinear"

    # `-re` caps input reading to realtime. The output frame rate is also
    # capped so the frame indexes and frontend clock use the same cadence.
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",
        "-nostdin",
        "-re",
        *_ffmpeg_input_header_args(headers),
        "-i", media_url,
        "-an",
        "-vf", video_filter,
        "-fps_mode", "cfr",
        "-r", str(fps),
    ]

    if display_mode == "canvas":
        # Stream JPEGs straight from FFmpeg. This eliminates the prior path
        # raw BGR -> Python -> OpenCV JPEG -> WebSocket, reducing CPU and copies.
        cmd.extend([
            "-c:v", "mjpeg",
            "-q:v", str(qscale),
            "-threads:v", "2",
            "-f", "image2pipe",
            "pipe:1",
        ])
    else:
        cmd.extend([
            "-f", "rawvideo",
            "-pix_fmt", "bgr24",
            "pipe:1",
        ])
    return cmd


def _build_audio_ffmpeg_cmd(
    audio_url: str,
    headers: Optional[dict[str, str]] = None,
) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",
        "-nostdin",
        *_ffmpeg_input_header_args(headers),
        "-i", audio_url,
        "-vn",
        # MP3 is broadly supported by HTMLAudioElement across desktop browsers.
        "-c:a", "libmp3lame",
        "-b:a", "128k",
        "-f", "mp3",
        "pipe:1",
    ]


class VideoPipeline:
    """One-shot streaming pipeline.  Build a fresh instance per Play."""

    def __init__(
        self,
        media_url: str,
        preset: PresetSpec,
        headers: Optional[dict[str, str]] = None,
        *,
        display_mode: str = "ascii",
        frame_width: Optional[int] = None,
        frame_height: Optional[int] = None,
        fps_cap: Optional[int] = None,
        jpeg_quality: int = 80,
    ):
        self.media_url = media_url
        self.preset = preset
        self.headers = dict(headers or {})
        self.display_mode = "canvas" if display_mode == "canvas" else "ascii"
        self.frame_width = int(frame_width or preset.cols)
        self.frame_height = int(frame_height or preset.rows)
        self.target_fps = int(fps_cap or preset.fps_cap)
        self.jpeg_quality = max(40, min(95, int(jpeg_quality)))
        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._stderr_drain: Optional[threading.Thread] = None
        self._queue: Optional[asyncio.Queue] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._stop = threading.Event()
        self.frames_read = 0
        self.frames_dropped = 0
        self.frames_sent = 0

    def init_message(self) -> str:
        """Text handshake selecting the client-side frame decoder."""
        if self.display_mode == "canvas":
            return f"CANVAS_INIT:{float(self.target_fps)}:{self.frame_width}:{self.frame_height}"
        p = self.preset
        return f"INIT:{float(p.fps_cap)}:{p.mode}:{p.cols}:{p.rows}:0"

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=_FRAME_QUEUE_MAX)

        cmd = _build_ffmpeg_cmd(
            self.media_url, self.preset, self.headers,
            display_mode=self.display_mode,
            frame_width=self.frame_width,
            frame_height=self.frame_height,
            fps_cap=self.target_fps,
            jpeg_quality=self.jpeg_quality,
        )
        if self.display_mode == "canvas":
            log.info("ffmpeg start: canvas %sx%s @ %s fps request_headers=%s",
                     self.frame_width, self.frame_height, self.target_fps, bool(self.headers))
        else:
            log.info("ffmpeg start: ASCII %sx%s @ %s fps request_headers=%s",
                     self.preset.cols, self.preset.rows, self.preset.fps_cap, bool(self.headers))
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self._reader = threading.Thread(
            target=self._reader_loop, name="pipeline-reader", daemon=True,
        )
        self._reader.start()
        self._stderr_drain = threading.Thread(
            target=self._stderr_loop, name="pipeline-stderr", daemon=True,
        )
        self._stderr_drain.start()

    def stop(self) -> None:
        self._stop.set()
        proc = self._proc
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                log.info("ffmpeg did not exit on SIGTERM, sending SIGKILL")
                proc.kill()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        if self._reader and self._reader.is_alive():
            self._reader.join(timeout=2)
        if self._stderr_drain and self._stderr_drain.is_alive():
            self._stderr_drain.join(timeout=1)
        log.info(
            "pipeline stopped — frames_read=%d frames_dropped=%d frames_sent=%d",
            self.frames_read, self.frames_dropped, self.frames_sent,
        )

    def _reader_loop(self) -> None:
        """Read FFmpeg output; Canvas is a concatenated JPEG stream."""
        proc = self._proc
        loop = self._loop
        if proc is None or loop is None or proc.stdout is None:
            return
        try:
            if self.display_mode == "canvas":
                self._read_mjpeg_frames(proc.stdout, loop)
                return

            frame_bytes = self.frame_width * self.frame_height * 3
            while not self._stop.is_set():
                chunks: list[bytes] = []
                remaining = frame_bytes
                while remaining > 0:
                    chunk = proc.stdout.read(remaining)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                if remaining > 0:
                    break  # EOF or partial final raw frame
                self.frames_read += 1
                data = b"".join(chunks) if len(chunks) > 1 else chunks[0]
                loop.call_soon_threadsafe(self._enqueue, data)
        except (OSError, RuntimeError) as exc:
            if not self._stop.is_set():
                log.warning("video reader stopped: %s", exc)
        finally:
            try:
                loop.call_soon_threadsafe(self._signal_eof)
            except RuntimeError:
                pass

    def _read_mjpeg_frames(self, stdout, loop: asyncio.AbstractEventLoop) -> None:
        """Split FFmpeg image2pipe MJPEG output by JPEG SOI/EOI markers."""
        buffer = bytearray()
        soi = b"\xff\xd8"
        eoi = b"\xff\xd9"
        while not self._stop.is_set():
            chunk = stdout.read(65536)
            if not chunk:
                break
            buffer.extend(chunk)
            while True:
                start = buffer.find(soi)
                if start < 0:
                    # Keep a trailing 0xFF in case the next chunk starts with D8.
                    keep_tail = bool(buffer and buffer[-1] == 0xFF)
                    buffer[:] = b"\xff" if keep_tail else b""
                    break
                if start > 0:
                    del buffer[:start]
                end = buffer.find(eoi, 2)
                if end < 0:
                    break
                jpeg = bytes(buffer[:end + 2])
                del buffer[:end + 2]
                self.frames_read += 1
                try:
                    loop.call_soon_threadsafe(self._enqueue, jpeg)
                except RuntimeError:
                    return
            # Defensive guard against an invalid stream growing without bound.
            if len(buffer) > 8 * 1024 * 1024:
                log.warning("MJPEG frame buffer exceeded 8 MiB; resynchronising")
                start = buffer.find(soi, 1)
                if start >= 0:
                    del buffer[:start]
                else:
                    buffer.clear()

    def _stderr_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip()
            if line:
                log.warning("ffmpeg: %s", line)

    def _enqueue(self, raw_bgr: bytes) -> None:
        """Loop-thread: enqueue, dropping the oldest frame on overflow."""
        q = self._queue
        if q is None:
            return
        if q.full():
            try:
                q.get_nowait()
                self.frames_dropped += 1
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait(raw_bgr)
        except asyncio.QueueFull:
            self.frames_dropped += 1

    def _signal_eof(self) -> None:
        q = self._queue
        if q is None:
            return
        # Empty bytes is the EOS sentinel for frames().  Displace any
        # pending frame so the consumer wakes promptly.
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait(b"")
        except asyncio.QueueFull:
            pass

    async def frames(self) -> AsyncIterator[bytes]:
        """Yield either JPEG frames for Canvas or the existing ASCILINE frame protocol."""
        assert self._queue is not None
        loop = asyncio.get_running_loop()
        frame_index = 0

        if self.display_mode == "canvas":
            while True:
                jpeg = await self._queue.get()
                if not jpeg:
                    return
                # Same frontend wire protocol as before: 4-byte big-endian
                # frame index followed by one complete JPEG image.
                yield struct.pack(">I", frame_index) + jpeg
                frame_index += 1
            return

        mapper = AsciiMapper()
        char_byte_lut = np.array([ord(c) for c in mapper._lut], dtype=np.uint8)
        n_chars = mapper._n
        qb = _QB_BY_MODE.get(self.preset.mode, 0)
        cols, rows = self.preset.cols, self.preset.rows
        send_buf = bytearray(4 + rows * cols * 4)

        while True:
            raw = await self._queue.get()
            if not raw:
                return  # EOF sentinel

            payload = await loop.run_in_executor(
                None,
                _encode_frame,
                raw, frame_index, cols, rows, char_byte_lut, n_chars, qb, send_buf,
            )
            yield payload
            frame_index += 1


class AudioPipeline:
    """One-shot MP3 audio pipeline. Build a fresh instance per Play."""

    def __init__(
        self,
        audio_url: str,
        headers: Optional[dict[str, str]] = None,
    ):
        self.audio_url = audio_url
        self.headers = dict(headers or {})
        self._proc: Optional[subprocess.Popen] = None
        self._stderr_drain: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def start(self) -> None:
        cmd = _build_audio_ffmpeg_cmd(self.audio_url, self.headers)
        # Avoid logging signed YouTube URLs or request header values.
        log.info("audio ffmpeg start: request_headers=%s", bool(self.headers))
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self._stderr_drain = threading.Thread(
            target=self._stderr_loop, name="audio-stderr", daemon=True,
        )
        self._stderr_drain.start()

    def stop(self) -> None:
        self._stop.set()
        proc = self._proc
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                log.info("audio ffmpeg did not exit on SIGTERM, sending SIGKILL")
                proc.kill()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        if self._stderr_drain and self._stderr_drain.is_alive():
            self._stderr_drain.join(timeout=1)
        log.info("audio pipeline stopped")

    def _stderr_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip()
            if line:
                log.warning("audio ffmpeg: %s", line)

    async def chunks(self) -> AsyncIterator[bytes]:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        loop = asyncio.get_running_loop()
        stdout = proc.stdout
        stop = self._stop

        def _read() -> bytes:
            return stdout.read(_AUDIO_CHUNK_SIZE)

        while not stop.is_set():
            chunk = await loop.run_in_executor(None, _read)
            if not chunk:
                break
            yield chunk


def _encode_frame(
    raw: bytes,
    frame_index: int,
    cols: int,
    rows: int,
    char_byte_lut: np.ndarray,
    n_chars: int,
    qb: int,
    send_buf: bytearray,
) -> bytes:
    """BGR24 raw frame → ASCILINE color frame bytes (modes 2-5)."""
    bgr = np.frombuffer(raw, dtype=np.uint8).reshape(rows, cols, 3)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    indices = np.floor_divide(gray, max(1, 256 // n_chars))
    np.clip(indices, 0, n_chars - 1, out=indices)
    char_codes = char_byte_lut[indices]

    rgb = bgr[:, :, ::-1]
    if qb > 0:
        rgb = (rgb >> qb) << qb

    out = np.empty((rows, cols, 4), dtype=np.uint8)
    out[:, :, 0] = char_codes
    out[:, :, 1:] = rgb
    struct.pack_into(">I", send_buf, 0, frame_index)
    send_buf[4:] = out.tobytes()
    # Copy out — caller may dispatch concurrently while we reuse send_buf.
    return bytes(send_buf)