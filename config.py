"""Quality presets and server defaults.

Preset change requires re-Play (server restarts ffmpeg with new scale).
"""

PRESETS = {
    "low": {
        "cols": 120,
        "rows": 50,
        "fps_cap": 24,
        "mode": 2,          # 512 colors
    },
    "med": {
        "cols": 160,
        "rows": 68,
        "fps_cap": 30,
        "mode": 3,          # 32K colors
    },
    "high": {
        "cols": 200,
        "rows": 84,
        "fps_cap": 30,
        "mode": 3,          # 32K colors
    },
}

DEFAULT_PRESET = "low"

SERVER_DEFAULTS = {
    "port": 8000,
    "bind": "0.0.0.0",
    "max_source_height": 720,
}


# Canvas-mode resolutions. Each preset controls the encoded video dimensions and frame rate.
# Canvas frames are encoded by FFmpeg as MJPEG before they are sent over WebSocket.
CANVAS_PRESETS = {
    # Keep a moderate cadence and improve JPEG quality. The browser timestamps
    # Canvas frames on arrival so occasional CDN stalls do not poison the clock.
    "low":  {"width": 640,  "height": 360, "fps_cap": 20, "jpeg_quality": 70},
    "med":  {"width": 1280, "height": 720, "fps_cap": 20, "jpeg_quality": 90},
    "high": {"width": 1920, "height": 1080, "fps_cap": 20, "jpeg_quality": 92},
}
