ASCILINE — WebCodecs Canvas playback (PC browser)

Canvas mode has been changed from JPEG frames over WebSocket / hidden HTML video
playback to a WebCodecs video decoder:

1. /media streams fragmented MP4 from the existing FFmpeg stream-copy remux.
2. MP4Box.js demultiplexes the fragmented MP4 in the browser.
3. VideoDecoder decodes H.264-compatible samples into VideoFrame objects.
4. Frames are scheduled and drawn to the visible canvas using an independent
   monotonic video clock; audio is only best-effort synchronized and cannot
   freeze video presentation if its currentTime stalls.
5. The separate audio stream is routed through Web Audio gain when supported.

The served player page no longer contains an HTML <video> element. MP4Box.js is
loaded from jsDelivr, so the client needs access to that CDN unless the script is
vendored locally. This build uses a separate audio stream rather than decoding
AAC samples through AudioDecoder; synchronization is best-effort and should be
validated with real YouTube streams in Chrome/Edge. The project was syntax-checked,
but live playback has not been tested in the deployed Render environment.

Deploy: commit the updated static/app.js, static/watch.html and session.py.
Hard-refresh the browser after Render finishes deploying. If video fails, check
Console for MP4Box/WebCodecs errors and Render logs for FFmpeg errors.
