ASCILINE – Native Canvas Playback (smooth video path)

IMPORTANT
This replaces the old Canvas JPEG-over-WebSocket path with a browser-native
video decoder. The visible picture is still drawn on the existing HTML canvas;
the hidden <video> element is only the decoder/audio source. ASCII mode keeps
its original WebSocket renderer.

REPLACE THESE FILES
Project root:
  config.py
  pipeline.py
  resolver.py
  session.py
  server.py

Inside static/:
  app.js
  index.html
  style.css

Do NOT replace:
  auth.py
  static/pin.html
  render-build.sh
  requirements.txt

Do NOT change Render environment variables, Build Command, or Start Command.
The existing Deno/yt-dlp setup and YOUTUBE_COOKIES_B64 stay as they are.

INSTALL
1. Unzip the package.
2. Replace the five .py files in the repository root.
3. Replace the three files in static/.
4. Commit the changes to GitHub.
5. Wait for Render's deployment to finish.
6. Open ASCILINE and use Ctrl+F5. Test Canvas + LOW first, then MED/HIGH.

HOW IT WORKS
- Canvas mode asks yt-dlp for browser-friendly H.264/AAC streams, preferring
  direct HTTPS sources and falling back to a progressive MP4 format.
- FFmpeg stream-copies the input into fragmented MP4; it does not re-encode
  every frame into JPEG and does not impose a low FPS cap.
- The browser decodes the stream and paints decoded frames onto the visible
  canvas using requestVideoFrameCallback where supported.
- ASCII mode retains its existing FFmpeg/WebSocket path and separate MP3 audio.
- Canvas presets cap source height at 360p / 480p / 720p for LOW / MED / HIGH.

If Canvas playback fails after deploying, inspect Render Logs for lines starting
with "native Canvas ffmpeg". The code is syntax-checked and its FFmpeg fragmented
MP4 output was tested with a local H.264/AAC sample, but live playback depends on
the formats exposed by YouTube and the codecs supported by the browser.
