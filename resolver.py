
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
    # Render build and runtime environments do not always expose the same
    # HOME/PATH. Prefer a project-local Deno install created by render-build.sh,
    # then check the configured and conventional user install locations.
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


def _ydl_opts(max_height: int, deno_path: Optional[str] = None) -> dict:
    """Build yt-dlp options with default YouTube clients and a JS runtime.

    Prefer direct HTTPS formats to avoid HLS segment 403s, but keep broad
    fallbacks so videos that only expose other protocols are not rejected
    with "Requested format is not available".
    """
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
        # Use the normal/current yt-dlp YouTube client selection instead of
        # hard-coding tv/web_safari/android, which can yield no player data.
        # The EJS scripts are included by the yt-dlp[default] extra.
    }
    if deno_path:
        opts["js_runtimes"] = {"deno": {"path": deno_path}}
    return opts


def _extract(url: str, max_height: int) -> dict:
    """Extract video metadata and stream URLs using optional cookies."""

    cookie_path = None

    try:
        deno_path = _prepare_js_runtime()
        if not deno_path:
            # Do not log environment details or anything from the cookie value.
            # Continue extraction so yt-dlp can still use a runtime supplied by PATH;
            # the configured Render build script installs Deno for production.
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

            # Create a temporary cookie file. Never log its contents.
            with tempfile.NamedTemporaryFile(
                mode="wb", prefix="yt-cookies-", suffix=".txt", delete=False
            ) as cookie_file:
                cookie_file.write(cookie_bytes)
                cookie_path = cookie_file.name

        opts = _ydl_opts(max_height, deno_path)
        if cookie_path:
            opts["cookiefile"] = cookie_path

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)

        # Search results are returned inside an entries list.
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

            # Resolve the actual video if the search result contains
            # metadata only.
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
        # Delete temporary cookies even if extraction fails.
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

    # A single selected format may already contain both video and audio.
    url = info.get("url")
    if not url:
        raise ResolverError(
            "yt-dlp returned no playable URL. The video may be unavailable "
            "or YouTube may have blocked stream extraction."
        )

    return url, None, _headers_for(info, info), {}


def _pick_urls(info: dict) -> tuple[str, Optional[str]]:
    """Compatibility helper returning only URLs."""
    video_url, audio_url, _, _ = _pick_streams(info)
    return video_url, audio_url


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
        info = _extract(yt_url, max_height)

    except ResolverError as exc:
        if is_id_attempt and _is_unavailable(exc):
            info = _extract(
                f"ytsearch1:{query}",
                max_height,
            )
        else:
            raise

    video_url, audio_url, video_headers, audio_headers = _pick_streams(info)

    return ResolvedMedia(
        title=info.get("title") or "Unknown",
        is_live=bool(info.get("is_live")),
        duration=info.get("duration"),
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
