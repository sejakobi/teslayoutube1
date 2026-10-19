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
# The backend JPEG-encodes frames before sending them through the WebSocket to keep bandwidth reasonable.
CANVAS_PRESETS = {
    "low":  {"width": 640,  "height": 360, "fps_cap": 20, "jpeg_quality": 76},
    "med":  {"width": 854,  "height": 480, "fps_cap": 24, "jpeg_quality": 80},
    "high": {"width": 1280, "height": 720, "fps_cap": 30, "jpeg_quality": 82},
}
