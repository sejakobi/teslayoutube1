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
