"""
stream_server.py
================
Streams the core Video-to-ASCII engine to the web via HTTP/WebSocket.
Dependencies: pip install fastapi uvicorn websockets

Priority Order:
  1. --playlist playlist.json  → JSON file (per-video vol, mode, path)
  2. --folder ./videos         → folder scan (filesystem order, not alphabetical)
  3. positional video arg      → single video (legacy behavior)

VENDORED — do not modify. Used as reference for protocol only.
See vendor/asciline/PROTOCOL-NOTES.md for the wire format documentation.
"""

import asyncio
import subprocess
import json
import numpy as np
import cv2
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import os
from websockets.exceptions import ConnectionClosed

from ascii_video_player2 import VideoDecoder, AsciiMapper

app = FastAPI()


def get_video_dimensions(path: str) -> tuple[int, int]:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Could not open video file: {path!r}")
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    return w, h


def calc_auto_rows(cols: int, vid_w: int, vid_h: int, pixel_mode: bool) -> int:
    ratio = vid_w / max(vid_h, 1)
    if pixel_mode:
        return max(1, round(cols / ratio))
    else:
        return max(1, round(cols / ratio / 2))


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=BASE_DIR), name="static")


def get_html_content():
    html_path = os.path.join(os.path.dirname(__file__), "index.html")
    with open(html_path, "r", encoding="utf-8") as f:
        return f.read()


def resolve_video_path(video: str) -> str:
    candidates = [
        video,
        os.path.join(BASE_DIR, video),
        os.path.join(BASE_DIR, "videos", os.path.basename(video)),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return video


def load_playlist(playlist_path: str) -> list[dict]:
    with open(playlist_path, "r", encoding="utf-8") as f:
        items = json.load(f)
    for item in items:
        item["video"] = resolve_video_path(item["video"])
    return items


def load_folder(folder_path: str, default_mode: int, default_vol: int) -> list[dict]:
    supported = (".mp4", ".mkv", ".avi", ".mov", ".webm")
    entries = []
    with os.scandir(folder_path) as it:
        for entry in it:
            if entry.is_file() and entry.name.lower().endswith(supported):
                entries.append({
                    "video": entry.path,
                    "mode":  default_mode,
                    "vol":   default_vol
                })
    return entries


def build_queue(args) -> list[dict]:
    if args.playlist:
        items = load_playlist(args.playlist)
        for item in items:
            item.setdefault("mode", args.mode)
            item.setdefault("vol",  args.vol)
            item.setdefault("pixel", args.pixel)
            is_pixel = item.get("pixel", False)
            default_cols = args.cols if args.cols is not None else (450 if is_pixel else 200)
            item.setdefault("cols", default_cols)
            item.setdefault("rows", args.rows)
        return items

    if args.folder:
        items = load_folder(args.folder, args.mode, args.vol)
        default_cols = args.cols if args.cols is not None else (450 if args.pixel else 200)
        for item in items:
            item["pixel"] = args.pixel
            item["cols"] = default_cols
            item["rows"] = args.rows
        return items

    default_cols = args.cols if args.cols is not None else (450 if args.pixel else 200)
    return [{"video": resolve_video_path(args.video), "mode": args.mode, "vol": args.vol, "pixel": args.pixel, "cols": default_cols, "rows": args.rows}]


@app.get("/")
async def root():
    return HTMLResponse(get_html_content())


@app.get("/audio")
async def audio_stream():
    queue = getattr(app.state, "queue", [])
    idx   = getattr(app.state, "current_index", 0)
    entry = queue[idx] if queue else {}

    vol_level  = entry.get("vol", 1)
    video_path = entry.get("video", "video.mp4")

    if vol_level <= 0:
        from fastapi import Response
        return Response(status_code=204)

    if not os.path.exists(video_path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Video file not found")

    ffmpeg_vol = 1.0 + (vol_level - 1) * 0.25

    def audio_generator():
        process = subprocess.Popen(
            [
                "ffmpeg",
                "-i", video_path,
                "-vn",
                "-filter:a", f"volume={ffmpeg_vol}",
                "-acodec", "libmp3lame",
                "-ab", "128k",
                "-ar", "44100",
                "-f", "mp3",
                "-loglevel", "quiet",
                "pipe:1"
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL
        )
        try:
            while True:
                chunk = process.stdout.read(4096)
                if not chunk:
                    break
                yield chunk
        finally:
            process.stdout.close()
            process.wait()

    return StreamingResponse(
        audio_generator(),
        media_type="audio/mpeg",
        headers={"Accept-Ranges": "bytes"}
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    queue = getattr(app.state, "queue", [])
    loop  = getattr(app.state, "loop", False)

    if not queue:
        await websocket.send_text("Error: No video in queue!")
        await websocket.close()
        return

    queue_index = 0

    try:
        while True:
            entry      = queue[queue_index]
            video_path = entry["video"]
            render_mode= entry["mode"]
            pixel_mode = entry.get("pixel", False)
            cols       = entry.get("cols", 200)
            rows_cfg   = entry.get("rows", 0)

            app.state.current_index = queue_index

            try:
                vid_w, vid_h = get_video_dimensions(video_path)
            except FileNotFoundError:
                await websocket.send_text(f"Error: '{video_path}' not found!")
                queue_index += 1
                if queue_index >= len(queue):
                    if loop:
                        queue_index = 0
                    else:
                        break
                continue

            if rows_cfg == 0:
                rows = calc_auto_rows(cols, vid_w, vid_h, pixel_mode)
            else:
                rows = rows_cfg

            try:
                decoder = VideoDecoder(video_path, cols, rows, skip_gray=pixel_mode)
            except FileNotFoundError:
                await websocket.send_text(f"Error: '{video_path}' not found!")
                queue_index += 1
                if queue_index >= len(queue):
                    if loop:
                        queue_index = 0
                    else:
                        break
                continue

            mapper       = AsciiMapper()
            source_fps   = decoder.fps
            MAX_FPS      = 30
            char_byte_lut= np.array([ord(c) for c in mapper._lut], dtype=np.uint8)
            qb           = {5: 0, 4: 2, 3: 3, 2: 5}.get(render_mode, 0)

            if source_fps > MAX_FPS:
                skip_n = round(source_fps / MAX_FPS)
                effective_fps = source_fps / skip_n
            else:
                skip_n = 1
                effective_fps = source_fps
            frame_t = 1.0 / effective_fps

            await websocket.send_text(f"INIT:{effective_fps}:{render_mode}:{cols}:{rows}:{int(pixel_mode)}")

            frame_buf = np.empty((rows, cols, 4), dtype=np.uint8) if render_mode > 1 else None

            import struct
            start_time = asyncio.get_event_loop().time()
            frame_index = 0

            if pixel_mode:
                pixel_send_buf = bytearray(4 + rows * cols * 3)
            elif render_mode > 1:
                ascii_send_buf = bytearray(4 + rows * cols * 4)

            try:
                while True:
                    for _ in range(skip_n - 1):
                        if not decoder.grab():
                            break

                    try:
                        gray_frame, bgr_frame = next(decoder)
                    except StopIteration:
                        break

                    if pixel_mode:
                        bgr_bytes = bgr_frame.tobytes()
                        struct.pack_into(">I", pixel_send_buf, 0, frame_index)
                        pixel_send_buf[4:] = bgr_bytes
                        await websocket.send_bytes(bytes(pixel_send_buf))
                    else:
                        indices = np.floor_divide(gray_frame, max(1, 256 // mapper._n))
                        np.clip(indices, 0, mapper._n - 1, out=indices)

                        if render_mode == 1:
                            char_matrix = mapper._lut[indices]
                            lines = [''.join(row) for row in char_matrix]
                            await websocket.send_text(f"{frame_index}\n" + '\n'.join(lines))
                        else:
                            char_codes = char_byte_lut[indices]
                            rgb = bgr_frame[:, :, ::-1]
                            if qb > 0:
                                rgb = (rgb >> qb) << qb
                            frame_buf[:, :, 0] = char_codes
                            frame_buf[:, :, 1:] = rgb
                            struct.pack_into(">I", ascii_send_buf, 0, frame_index)
                            ascii_send_buf[4:] = frame_buf.tobytes()
                            await websocket.send_bytes(bytes(ascii_send_buf))

                    elapsed = asyncio.get_event_loop().time() - start_time
                    wait = (frame_index * frame_t) - elapsed
                    if wait > 0:
                        await asyncio.sleep(wait)

                    frame_index += 1

            finally:
                decoder.release()

            queue_index += 1
            if queue_index >= len(queue):
                if loop:
                    queue_index = 0
                else:
                    break

    except (WebSocketDisconnect, ConnectionClosed):
        pass
