"""Map user input (video ID / YouTube URL / search query) to media URLs.

Resolution order:
  1. YouTube URL (youtube.com / youtu.be) → use directly.
  2. Bare 11-char video ID → https://www.youtube.com/watch?v=<id>.  If
     yt-dlp reports "video unavailable", fall back to search.
  3. Anything else → prefix with `ytsearch1:` and let yt-dlp pick the
     first hit.

Returns a ResolvedMedia.  Raises ResolverError on failure.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

import yt_dlp

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YOUTUBE_URL_RE = re.compile(
    r"^(https?://)?(www\.)?(youtube\.com|youtu\.be)/", re.IGNORECASE
)


class ResolverError(Exception):
    pass


@dataclass
class ResolvedMedia:
    title: str
    is_live: bool
    duration: Optional[float]        # seconds; None for live
    video_url: str                   # direct stream URL for ffmpeg
    audio_url: Optional[str]         # separate audio URL, or None if muxed
    video_id: str
    format_note: str


def _ydl_opts(max_height: int) -> dict:
    # For live streams yt-dlp picks the HLS manifest automatically when
    # the format filter matches.  Prefer split video+audio so the two
    # pipelines can be independent; accept muxed as fallback.
    fmt = (
        f"bestvideo[height<={max_height}][ext=mp4]"
        f"+bestaudio[ext=m4a]"
        f"/bestvideo[height<={max_height}]+bestaudio"
        f"/best[height<={max_height}]"
        f"/best"
    )
    return {
        "format": fmt,
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
    }


def _extract(url: str, max_height: int) -> dict:
    opts = _ydl_opts(max_height)
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except yt_dlp.utils.DownloadError as exc:
            raise ResolverError(str(exc)) from exc
    if info is None:
        raise ResolverError(f"yt-dlp returned no info for: {url}")
    # ytsearch1: wraps the result in an "entries" list.
    if "entries" in info:
        entries = list(info["entries"])
        if not entries:
            raise ResolverError(f"No results for query: {url}")
        info = entries[0]
        if info.get("url") is None and info.get("webpage_url"):
            with yt_dlp.YoutubeDL(opts) as ydl2:
                try:
                    info = ydl2.extract_info(info["webpage_url"], download=False)
                except yt_dlp.utils.DownloadError as exc:
                    raise ResolverError(str(exc)) from exc
    return info


def _pick_urls(info: dict) -> tuple[str, Optional[str]]:
    """(video_url, audio_url).  audio_url is None when video_url is muxed."""
    requested = info.get("requested_formats")
    if requested and len(requested) >= 2:
        video_fmt = next(
            (f for f in requested if f.get("vcodec") not in (None, "none")), None
        )
        audio_fmt = next(
            (f for f in requested
             if f.get("acodec") not in (None, "none")
             and f.get("vcodec") in (None, "none")),
            None,
        )
        if video_fmt and audio_fmt:
            return video_fmt["url"], audio_fmt["url"]
        if video_fmt:
            return video_fmt["url"], None

    url = info.get("url")
    if not url:
        raise ResolverError("yt-dlp returned no playable URL")
    return url, None


def _build_format_note(info: dict) -> str:
    requested = info.get("requested_formats")
    if requested:
        parts = []
        for f in requested:
            h = f.get("height")
            codec = f.get("vcodec") or f.get("acodec") or "?"
            note = f.get("format_note") or ""
            parts.append(f"{codec} {h}p {note}".strip() if h else f"{codec} {note}".strip())
        return " + ".join(parts)
    return (
        f"{info.get('format_note', '')} "
        f"{info.get('height', '')}p "
        f"{info.get('ext', '')}".strip()
    )


def _is_unavailable(err: ResolverError) -> bool:
    msg = str(err).lower()
    return any(
        kw in msg
        for kw in ("video unavailable", "this video is not available", "private video",
                   "has been removed", "not available in your country")
    )


def resolve(query: str, max_height: int = 720) -> ResolvedMedia:
    """Resolve user input to a ResolvedMedia.  Raises ResolverError."""
    query = query.strip()

    if _YOUTUBE_URL_RE.match(query):
        yt_url = query
        is_id_attempt = False
    elif _VIDEO_ID_RE.match(query):
        yt_url = f"https://www.youtube.com/watch?v={query}"
        is_id_attempt = True
    else:
        yt_url = f"ytsearch1:{query}"
        is_id_attempt = False

    try:
        info = _extract(yt_url, max_height)
    except ResolverError as exc:
        # ID-failure → retry as search.
        if is_id_attempt and _is_unavailable(exc):
            info = _extract(f"ytsearch1:{query}", max_height)
        else:
            raise

    video_url, audio_url = _pick_urls(info)

    return ResolvedMedia(
        title=info.get("title") or "Unknown",
        is_live=bool(info.get("is_live")),
        duration=info.get("duration"),
        video_url=video_url,
        audio_url=audio_url,
        video_id=info.get("id") or "",
        format_note=_build_format_note(info),
    )


# CLI test entry:  python -m resolver "<input>"
if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("Usage: python -m resolver \"<video ID | URL | search query>\"")
        sys.exit(1)

    user_input = " ".join(sys.argv[1:])
    print(f"Resolving: {user_input!r}")

    try:
        result = resolve(user_input)
    except ResolverError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(
        {
            "title": result.title,
            "video_id": result.video_id,
            "is_live": result.is_live,
            "duration": result.duration,
            "format_note": result.format_note,
            "video_url": result.video_url[:80] + "…" if len(result.video_url) > 80 else result.video_url,
            "audio_url": (
                (result.audio_url[:80] + "…" if len(result.audio_url) > 80 else result.audio_url)
                if result.audio_url else None
            ),
        },
        indent=2,
    ))
