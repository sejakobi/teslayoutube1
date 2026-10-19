
"""Resolve a YouTube URL, video ID, or search query to stream URLs."""

from __future__ import annotations

import base64
import binascii
import os
import re
import tempfile
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


def _ydl_opts(max_height: int, player_clients: list[str]) -> dict:
    """Build yt-dlp options for a specific YouTube player-client profile."""

    # Prefer direct HTTPS streams. YouTube's HLS/m3u8 playlists are currently
    # returning HTTP 403 for FFmpeg segment requests in this deployment.
    # The ASCII renderer does not need high source resolution, so a direct
    # progressive format is a suitable fallback when DASH/HLS is unavailable.
    fmt = (
        f"bestvideo[protocol=https][height<={max_height}]"
        f"+bestaudio[protocol=https]"
        f"/best[protocol=https][height<={max_height}]"
        f"/best[protocol=https]"
    )

    return {
        "format": fmt,
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "extractor_args": {
            "youtube": {
                "player_client": player_clients,
            }
        },
        "noplaylist": True,
        "socket_timeout": 20,
        "retries": 2,
    }


def _extract(url: str, max_height: int) -> dict:
    """Extract video metadata and stream URLs using optional cookies."""

    cookie_path = None

    try:
        encoded = os.environ.get("YOUTUBE_COOKIES_B64", "").strip()

        if encoded:
            try:
                cookie_bytes = base64.b64decode(
                    encoded,
                    validate=True,
                )
            except (binascii.Error, ValueError) as exc:
                raise ResolverError(
                    "YOUTUBE_COOKIES_B64 is invalid Base64. "
                    "Please encode cookies.txt again."
                ) from exc

            if not cookie_bytes:
                raise ResolverError(
                    "The decoded YouTube cookie file is empty."
                )

            # Create a temporary cookie file. Never log its contents.
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix="yt-cookies-",
                suffix=".txt",
                delete=False,
            ) as cookie_file:
                cookie_file.write(cookie_bytes)
                cookie_path = cookie_file.name

        # YouTube has recently changed which player clients expose playable
        # formats. Try the current default clients first, then narrow profiles
        # if yt-dlp reports that the selected format is unavailable.
        # Do not combine web_safari with the default client: that often makes
        # yt-dlp prefer an HLS playlist. The format selector above also refuses
        # m3u8/HLS protocols; these profiles are tried only when no HTTPS format
        # is available for the preceding profile.
        client_profiles = (
            ["default"],
            ["android"],
            ["tv"],
        )
        info = None
        last_download_error = None

        for profile_index, player_clients in enumerate(client_profiles):
            opts = _ydl_opts(max_height, player_clients)
            if cookie_path:
                opts["cookiefile"] = cookie_path

            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                break
            except yt_dlp.utils.DownloadError as exc:
                last_download_error = exc
                message = str(exc).lower()
                is_format_error = (
                    "requested format is not available" in message
                    or "no video formats found" in message
                    or "only images are available" in message
                )
                if not is_format_error or profile_index == len(client_profiles) - 1:
                    raise

        if info is None and last_download_error is not None:
            raise last_download_error

        if info is None:
            raise ResolverError(
                f"yt-dlp returned no information for: {url}"
            )

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
