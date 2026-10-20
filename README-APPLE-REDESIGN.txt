ASCILINE — Apple-minimalist redesign

What changed
- Reworked the separate search page into a clean, light Apple-inspired interface.
- Reworked the full-screen watch page with restrained typography, translucent controls, responsive layout, and reduced-motion support.
- Kept the existing API routes, PIN/auth middleware, search flow, selection-token flow, ASCII mode, quality presets, stop flow, status polling, and resolver intact.
- Canvas mode now uses a video-only fragmented MP4 stream at /media and an independent MP3 stream at /audio. The visible image is drawn into the Canvas; the hidden media element is used only as the browser decoder.
- Canvas audio is independently muted/volume controlled through the existing audio element.
- Added a user-gesture fallback to resume audio/video if browser autoplay policy blocks playback.
- Updated cache-busting query strings so browsers fetch the new styles and scripts.

Validation performed
- JavaScript syntax check with Node.js.
- Python compileall syntax check for the Python modules.

Deployment notes
- Replace the existing project files with this package while keeping Render environment variables (especially ASCIILINE_PIN and YOUTUBE_API_KEY).
- Set the Render start command according to the existing deployment configuration/run.sh.
- YouTube HTTP 429 responses are upstream throttling and cannot be guaranteed fixed by a UI or code redesign.
- Canvas mode still uses browser media decoding internally. The visible display is Canvas, but browser media handling is not hidden or bypassed.
