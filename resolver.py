"""Resolve a YouTube URL, video ID, or search query to stream URLs."""

from __future__ import annotations

import base64
import binascii
import os
import re
import shutil
import tempfile
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

import yt_dlp


_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

_YOUTUBE_URL_RE = re.compile(
    r"^(https?://)?(www\.)?(youtube\.com|youtu\.be)/",
    re.IGNORECASE,
)


class ResolverError(Exception):
    """Raised when a video cannot be resolved."""


@dataclass
class ResolvedMedia:
    title: str
    is_live: bool
    duration: Optional[float]
    video_url: str
    audio_url: Optional[str]
    video_id: str
    format_note: str
    # HTTP headers yt-dlp associated with these exact signed stream URLs.
    # They must be forwarded to ffmpeg for YouTube CDN requests to succeed.
    video_headers: dict[str, str] = field(default_factory=dict)
    audio_headers: dict[str, str] = field(default_factory=dict)


def _prepare_js_runtime() -> Optional[str]:
    """Expose the Deno runtime installed by render-build.sh to yt-dlp."""
    project_deno = Path(__file__).resolve().parent / ".deno" / "bin" / "deno"
    deno_install = Path(os.environ.get("DENO_INSTALL", str(Path.home() / ".deno")))
    candidates = [
        project_deno,
        deno_install / "bin" / "deno",
        Path.home() / ".deno" / "bin" / "deno",
    ]

    deno_path = next((p for p in candidates if p.is_file()), None)
    if deno_path is None:
        found = shutil.which("deno")
        deno_path = Path(found) if found else None

    if deno_path is None:
        return None

    bin_dir = str(deno_path.parent)
    current_path = os.environ.get("PATH", "")
    if bin_dir not in current_path.split(os.pathsep):
        os.environ["PATH"] = bin_dir + os.pathsep + current_path

    return str(deno_path)


def _ydl_opts(
    max_height: int,
    deno_path: Optional[str] = None,
    prefer_native: bool = False,
) -> dict:
    """Build yt-dlp options for ASCII or native browser video playback."""
    if prefer_native:
        fmt = (
            f"bestvideo[vcodec^=avc1][height<={max_height}]"
            f"+bestaudio"
            f"/best[ext=mp4][vcodec^=avc1][height<={max_height}]"
            f"/best[vcodec^=avc1][height<={max_height}]"
        )
    else:
        fmt = (
            f"bestvideo[protocol=https][height<={max_height}]"
            f"+bestaudio[protocol=https]"
            f"/best[protocol=https][height<={max_height}]"
            f"/bestvideo[height<={max_height}]+bestaudio"
            f"/best[height<={max_height}]"
            "/best"
        )

    opts = {
        "format": fmt,
        "quiet": True,
        "no_warnings": False,
        "extract_flat": False,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 2,
        "extractor_retries": 2,
    }
    if deno_path:
        opts["js_runtimes"] = {"deno": {"path": deno_path}}
    return opts


def _extract(url: str, max_height: int, prefer_native: bool = False) -> dict:
    """Extract video metadata and stream URLs using optional cookies."""

    cookie_path = None

    try:
        deno_path = _prepare_js_runtime()
        if not deno_path:
            import logging
            logging.getLogger("resolver").warning(
                "Deno runtime not found. YouTube extraction may fail; "
                "verify Render Build Command is 'bash render-build.sh'."
            )

        encoded = os.environ.get("YOUTUBE_COOKIES_B64", "").strip()

        if encoded:
            try:
                cookie_bytes = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ResolverError(
                    "YOUTUBE_COOKIES_B64 is invalid Base64. "
                    "Please encode cookies.txt again."
                ) from exc

            if not cookie_bytes:
                raise ResolverError("The decoded YouTube cookie file is empty.")

            with tempfile.NamedTemporaryFile(
                mode="wb", prefix="yt-cookies-", suffix=".txt", delete=False
            ) as cookie_file:
                cookie_file.write(cookie_bytes)
                cookie_path = cookie_file.name

        opts = _ydl_opts(max_height, deno_path, prefer_native)
        if cookie_path:
            opts["cookiefile"] = cookie_path

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)

        if "entries" in info:
            entries = [
                entry for entry in info["entries"]
                if entry is not None
            ]

            if not entries:
                raise ResolverError(
                    f"No results found for query: {url}"
                )

            info = entries[0]

            if not info.get("url") or not info.get("formats"):
                webpage_url = info.get("webpage_url")

                if webpage_url:
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(
                            webpage_url,
                            download=False,
                        )

        if not isinstance(info, dict):
            raise ResolverError(
                "yt-dlp returned invalid video information."
            )

        return info

    except ResolverError:
        raise

    except yt_dlp.utils.DownloadError as exc:
        raise ResolverError(str(exc)) from exc

    except Exception as exc:
        raise ResolverError(
            f"Unexpected error while resolving video: {exc}"
        ) from exc

    finally:
        if cookie_path:
            try:
                os.remove(cookie_path)
            except OSError:
                pass


def _headers_for(fmt: Optional[dict], info: dict) -> dict[str, str]:
    """Get non-secret request headers attached to a chosen yt-dlp format."""
    raw = (fmt or {}).get("http_headers") or info.get("http_headers") or {}
    if not isinstance(raw, dict):
        return {}
    return {
        str(key): str(value)
        for key, value in raw.items()
        if key is not None and value is not None and str(key).strip()
    }


def _pick_streams(
    info: dict,
) -> tuple[str, Optional[str], dict[str, str], dict[str, str]]:
    """Return stream URLs and their matching HTTP headers."""

    requested = info.get("requested_formats")

    if requested and len(requested) >= 2:
        video_fmt = next(
            (
                item for item in requested
                if item.get("vcodec") not in (None, "none")
            ),
            None,
        )
        audio_fmt = next(
            (
                item for item in requested
                if item.get("acodec") not in (None, "none")
                and item.get("vcodec") in (None, "none")
            ),
            None,
        )

        if video_fmt and audio_fmt:
            video_url = video_fmt.get("url")
            audio_url = audio_fmt.get("url")
            if video_url and audio_url:
                return (
                    video_url,
                    audio_url,
                    _headers_for(video_fmt, info),
                    _headers_for(audio_fmt, info),
                )

        if video_fmt and video_fmt.get("url"):
            return (
                video_fmt["url"],
                None,
                _headers_for(video_fmt, info),
                {},
            )

    url = info.get("url")
    if not url:
        raise ResolverError(
            "yt-dlp returned no playable URL. The video may be unavailable "
            "or YouTube may have blocked stream extraction."
        )

    return url, None, _headers_for(info, info), {}


def _build_format_note(info: dict) -> str:
    """Build a readable description of the selected format."""

    requested = info.get("requested_formats")

    if requested:
        parts = []

        for item in requested:
            height = item.get("height")
            codec = (
                item.get("vcodec")
                or item.get("acodec")
                or "?"
            )
            note = item.get("format_note") or ""

            if height:
                parts.append(
                    f"{codec} {height}p {note}".strip()
                )
            else:
                parts.append(
                    f"{codec} {note}".strip()
                )

        return " + ".join(parts)

    return (
        f"{info.get('format_note', '')} "
        f"{info.get('height', '')}p "
        f"{info.get('ext', '')}"
    ).strip()


def _is_unavailable(err: ResolverError) -> bool:
    """Check whether a video-ID failure may justify a search fallback."""

    msg = str(err).lower()

    return any(
        keyword in msg
        for keyword in (
            "video unavailable",
            "this video is not available",
            "private video",
            "has been removed",
            "not available in your country",
        )
    )


def resolve(
    query: str,
    max_height: int = 720,
    *,
    prefer_native: bool = False,
) -> ResolvedMedia:
    """Resolve a YouTube ID, URL, or search query."""

    query = query.strip()

    if not query:
        raise ResolverError(
            "Please enter a YouTube URL or search query."
        )

    if _YOUTUBE_URL_RE.match(query):
        yt_url = query
        is_id_attempt = False

    elif _VIDEO_ID_RE.fullmatch(query):
        yt_url = f"https://www.youtube.com/watch?v={query}"
        is_id_attempt = True

    else:
        yt_url = f"ytsearch1:{query}"
        is_id_attempt = False

    try:
        info = _extract(yt_url, max_height, prefer_native)

    except ResolverError as exc:
        if is_id_attempt and _is_unavailable(exc):
            info = _extract(
                f"ytsearch1:{query}",
                max_height,
                prefer_native,
            )
        else:
            raise

    video_url, audio_url, video_headers, audio_headers = _pick_streams(info)

    # Safe duration extraction for the progress bar
    duration = info.get("duration")
    if not duration and info.get("approx_duration_ms"):
        duration = info.get("approx_duration_ms") / 1000.0

    return ResolvedMedia(
        title=info.get("title") or "Unknown",
        is_live=bool(info.get("is_live")),
        duration=duration,
        video_url=video_url,
        audio_url=audio_url,
        video_id=info.get("id") or "",
        format_note=_build_format_note(info),
        video_headers=video_headers,
        audio_headers=audio_headers,
    )


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 2:
        print(
            'Usage: python -m resolver '
            '"<video ID | URL | search query>"'
        )
        sys.exit(1)

    user_input = " ".join(sys.argv[1:])
    print(f"Resolving: {user_input!r}")

    try:
        result = resolve(user_input)

    except ResolverError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    print(
        json.dumps(
            {
                "title": result.title,
                "video_id": result.video_id,
                "is_live": result.is_live,
                "duration": result.duration,
                "format_note": result.format_note,
                "video_url": (
                    result.video_url[:80] + "…"
                    if len(result.video_url) > 80
                    else result.video_url
                ),
                "audio_url": (
                    result.audio_url[:80] + "…"
                    if result.audio_url
                    and len(result.audio_url) > 80
                    else result.audio_url
                ),
            },
            indent=2,
        )
    )
