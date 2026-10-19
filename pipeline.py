"""Video and audio pipelines.

Video: ffmpeg reads the resolved media URL at native realtime rate
(`-re`), scales to cols×rows, and emits a constant-rate raw BGR24 stream
(`-fps_mode cfr -r N`).  Frames are read on a worker thread, encoded to
the ASCILINE color frame format on an executor, and yielded straight to
the WebSocket.  No consumer-side pacing — the producer's source pacing
is what makes the cadence even.

Audio: a second ffmpeg encodes the same source to AAC/ADTS and pipes
chunks to the /audio HTTP endpoint.
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


def _build_ffmpeg_cmd(media_url: str, preset: PresetSpec) -> list[str]:
    # `-re` (before `-i`) makes ffmpeg read the input at native realtime
    # rate, so frames arrive on the consumer side evenly paced rather than
    # in bursts.  `-fps_mode cfr -r N` then duplicates/drops to a constant
    # N fps stream so the wire frame count matches `targetFps` exactly.
    # Live HLS sources are already realtime — `-re` is then redundant but
    # harmless (it caps read speed; live is already capped).
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",
        "-nostdin",
        "-re",
        "-i", media_url,
        "-an",
        "-vf", f"scale={preset.cols}:{preset.rows}:flags=fast_bilinear",
        "-fps_mode", "cfr",
        "-r", str(preset.fps_cap),
        "-f", "rawvideo",
        "-pix_fmt", "bgr24",
        "pipe:1",
    ]


def _build_audio_ffmpeg_cmd(audio_url: str) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",
        "-nostdin",
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

    def __init__(self, media_url: str, preset: PresetSpec):
        self.media_url = media_url
        self.preset = preset
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
        """Plain-text INIT message (PROTOCOL-NOTES §2)."""
        p = self.preset
        return f"INIT:{float(p.fps_cap)}:{p.mode}:{p.cols}:{p.rows}:0"

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=_FRAME_QUEUE_MAX)

        cmd = _build_ffmpeg_cmd(self.media_url, self.preset)
        log.info("ffmpeg start: %sx%s @ %s fps mode=%s",
                 self.preset.cols, self.preset.rows,
                 self.preset.fps_cap, self.preset.mode)
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
        """Worker thread: blocking reads of fixed-size BGR frames."""
        proc = self._proc
        loop = self._loop
        if proc is None or loop is None or proc.stdout is None:
            return
        frame_bytes = self.preset.cols * self.preset.rows * 3
        try:
            while not self._stop.is_set():
                # Loop the read explicitly so a short final read does not
                # get treated as a full frame.
                chunks: list[bytes] = []
                remaining = frame_bytes
                while remaining > 0:
                    chunk = proc.stdout.read(remaining)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                if remaining > 0:
                    break  # EOF
                self.frames_read += 1
                data = b"".join(chunks) if len(chunks) > 1 else chunks[0]
                loop.call_soon_threadsafe(self._enqueue, data)
        finally:
            loop.call_soon_threadsafe(self._signal_eof)

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
        """Drain the queue, encode each frame, yield wire-format bytes."""
        assert self._queue is not None
        mapper = AsciiMapper()
        char_byte_lut = np.array([ord(c) for c in mapper._lut], dtype=np.uint8)
        n_chars = mapper._n
        qb = _QB_BY_MODE.get(self.preset.mode, 0)
        cols, rows = self.preset.cols, self.preset.rows
        send_buf = bytearray(4 + rows * cols * 4)

        loop = asyncio.get_running_loop()
        frame_index = 0

        while True:
            raw = await self._queue.get()
            if not raw:
                return  # EOF sentinel

            # Encode in the executor — luminance/quantisation are CPU-bound
            # (a few ms at HIGH 200×84) and we don't want them on the loop.
            payload = await loop.run_in_executor(
                None,
                _encode_frame,
                raw, frame_index, cols, rows, char_byte_lut, n_chars, qb, send_buf,
            )
            yield payload
            frame_index += 1


class AudioPipeline:
    """One-shot AAC/ADTS audio pipeline.  Build a fresh instance per Play."""

    def __init__(self, audio_url: str):
        self.audio_url = audio_url
        self._proc: Optional[subprocess.Popen] = None
        self._stderr_drain: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def start(self) -> None:
        cmd = _build_audio_ffmpeg_cmd(self.audio_url)
        log.info("audio ffmpeg start: url=%s…", self.audio_url[:60])
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
