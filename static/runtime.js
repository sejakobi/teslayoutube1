// ASCILINE YouTube streamer — Tesla browser frontend.
//
// Wire protocol (unchanged from vendor/asciline): text INIT message
// "INIT:fps:mode:cols:rows:pixel" then binary frames whose first 4 bytes
// are a big-endian frame index and whose body is mode-dependent (mode 1
// = utf-8 text; modes 2/3 = [charCode,r,g,b] per cell).

'use strict';

const queryInput      = document.getElementById('query-input');
const btnPlay         = document.getElementById('btn-play');
const btnSearch       = document.getElementById('btn-search');
const btnCloseSearch  = document.getElementById('btn-close-search');
const searchPanel     = document.getElementById('search-panel');
const searchResults   = document.getElementById('search-results');
const searchMessage   = document.getElementById('search-message');
const searchTabVideos  = document.getElementById('search-tab-videos');
const searchTabChannels = document.getElementById('search-tab-channels');
const btnLoadMore      = document.getElementById('btn-load-more');
const btnBackChannels  = document.getElementById('btn-back-channels');
const creatorChannelBar = document.getElementById('creator-channel-bar');
const creatorChannelTitle = document.getElementById('creator-channel-title');
const creatorChannelSubtitle = document.getElementById('creator-channel-subtitle');
const btnViewChannelVideos = document.getElementById('btn-view-channel-videos');
const btnStop         = document.getElementById('btn-stop');
const presetBtns      = document.querySelectorAll('.preset-btn');
const displayModeBtns = document.querySelectorAll('.display-mode-btn');
const presetHint      = document.getElementById('preset-hint');
const btnMute         = document.getElementById('btn-mute');
const volumeSlider    = document.getElementById('volume-slider');
const playerContainer = document.getElementById('player-container');
const asciiPlayer     = document.getElementById('ascii-player');
const canvas          = document.getElementById('ascii-canvas');
const ctx             = canvas.getContext('2d', { alpha: false, desynchronized: true });
const idleOverlay     = document.getElementById('idle-overlay');
const audioEl         = document.getElementById('ascii-audio');
const canvasSource     = document.getElementById('canvas-source');
const playbackControls = document.getElementById('playback-controls');
const btnPause         = document.getElementById('btn-pause');
const playbackProgress = document.getElementById('playback-progress');
const playbackCurrentTime = document.getElementById('playback-current-time');
const playbackDuration = document.getElementById('playback-duration');
const playbackLive     = document.getElementById('playback-live');

const statusTitle = document.getElementById('status-title');
const statusLive  = document.getElementById('status-live');
const statusState = document.getElementById('status-state');
const statusFps   = document.getElementById('status-fps');
const statusPerf  = document.getElementById('status-perf-hint');

let appState       = 'idle';   // idle | resolving | playing | error
let ws             = null;
let sessionId      = null;
let pollTimer      = null;
let currentPreset  = 'med';
let selectedPreset = 'med';
let selectedDisplayMode = 'canvas';
let canvasVideoMode = false;
let lastCanvasFrameIndex = -1;
let nativeVideoFrameCallback = null;
let nativeDrawRaf = null;
let nativeDrawLoopRunning = false;
let nativeLastMediaTime = -1;
let nativeFpsCount = 0;
let nativeFpsWindowStart = 0;
let nativeRenderedFps = 0;
let nativeMediaDuration = 0;
let nativeIsLive = false;
let nativeSeekOffset = 0;
let nativeSeekUsesAbsoluteTime = true;
let nativePauseAfterSeek = false;

const WS_MAX_RETRIES = 5;
let wsRetryCount     = 0;
let wsRetryTimer     = null;

// Renderer state.  Master clock is wall-clock, anchored on the first
// server frame (audio's currentTime updates in coarse ~250 ms steps which
// caused stall→batch-drop bursts on the M4).  A small lead lets the very
// first frame paint immediately instead of waiting half a second.
const frameBuffer       = [];
const FRAME_BUFFER_MAX  = 3;       // server queue is 2; 3 keeps ~125 ms of slack
const PRESENT_LEAD_MS   = 60;
let targetFps     = 24;
let renderMode    = 1;
let pixelMode     = false;
let readyToRender = false;
let gridCols = 0, gridRows = 0;
let charWidth = 0, charHeight = 0;
let xPos = null, yPos = null;
let dotImageData    = null;
let selectionBuffer = null;
let clockAnchored   = false;
let streamStartTime = 0;
const textDecoder   = new TextDecoder();
const CHAR_LUT      = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i));

// HUD: painted FPS plus worst paint-to-paint gap (JIT) and current client
// buffer depth.  JIT exposes bursts that a 1-second average would smear.
let frameCount       = 0;
let measuredFps      = 0;
let lastFpsUpdate    = 0;
let fpsWindowFrames  = 0;
let fpsWindowStart   = 0;
let fpsBelowThreshold = false;
let lastPaintTime    = 0;
let maxPaintInterval = 0;

// ───────── Preset selection UI ─────────
presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const p = btn.dataset.preset;
        if (p === selectedPreset) return;
        selectedPreset = p;
        presetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === p));
        updateConfigHint();
    });
});

displayModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = btn.dataset.displayMode;
        if (mode !== 'ascii' && mode !== 'canvas') return;
        selectedDisplayMode = mode;
        displayModeBtns.forEach(b => b.classList.toggle('active', b.dataset.displayMode === mode));
        updateConfigHint();
    });
});

function updateConfigHint() {
    if (appState === 'playing' || appState === 'resolving') {
        presetHint.textContent = 'Änderungen werden beim nächsten PLAY übernommen';
        presetHint.classList.remove('hidden');
    }
}

// ───────── Volume / mute ─────────
let isMuted = false;

volumeSlider.addEventListener('input', () => {
    const volume = parseFloat(volumeSlider.value);
    if (audioEl) audioEl.volume = volume;
    if (canvasSource) canvasSource.volume = volume;
    isMuted = volume === 0;
    if (canvasSource && canvasVideoMode) canvasSource.muted = isMuted;
    updateMuteBtn();
});

btnMute.addEventListener('click', () => {
    isMuted = !isMuted;
    if (audioEl) audioEl.muted = isMuted;
    if (canvasSource) canvasSource.muted = isMuted;
    updateMuteBtn();
});

function updateMuteBtn() {
    btnMute.textContent = isMuted ? '🔇' : '🔊';
    btnMute.classList.toggle('muted', isMuted);
}

// ───────── Canvas setup ─────────
function buildCanvas(cols, rows) {
    gridCols = cols;
    gridRows = rows;

    const syncSize = (el) => {
        el.style.width    = playerContainer.clientWidth  + 'px';
        el.style.height   = playerContainer.clientHeight + 'px';
        el.style.objectFit = 'contain';
        el.style.position  = 'absolute';
        el.style.top  = '0';
        el.style.left = '0';
    };

    if (pixelMode) {
        canvas.width  = cols;
        canvas.height = rows;
        canvas.style.display = 'block';
        canvas.style.imageRendering = 'pixelated';
        dotImageData = ctx.createImageData(cols, rows);
        const d = dotImageData.data;
        for (let i = 3; i < d.length; i += 4) d[i] = 255;
        syncSize(canvas);
        asciiPlayer.style.display = 'none';
        return;
    }

    canvas.style.imageRendering = '';
    dotImageData = null;
    ctx.font = 'bold 8px Courier New';
    charWidth  = ctx.measureText('M').width;
    charHeight = 8;
    canvas.width  = cols * charWidth;
    canvas.height = rows * charHeight;
    canvas.style.display = 'block';

    selectionBuffer = new Uint8Array((cols + 1) * rows);
    for (let r = 0; r < rows; r++) selectionBuffer[r * (cols + 1) + cols] = 10;

    syncSize(canvas);

    const cw = playerContainer.clientWidth;
    const ch = playerContainer.clientHeight;
    const fs = Math.min(cw / canvas.width, ch / canvas.height);
    const ox = (cw - canvas.width  * fs) / 2;
    const oy = (ch - canvas.height * fs) / 2;

    asciiPlayer.style.width  = canvas.width  + 'px';
    asciiPlayer.style.height = canvas.height + 'px';
    asciiPlayer.style.position = 'absolute';
    asciiPlayer.style.top  = '0';
    asciiPlayer.style.left = '0';
    asciiPlayer.style.transformOrigin = 'top left';
    asciiPlayer.style.transform  = `translate(${ox}px,${oy}px) scale(${fs})`;
    asciiPlayer.style.fontSize   = '8px';
    asciiPlayer.style.lineHeight = '8px';

    ctx.font         = 'bold 8px Courier New';
    ctx.textBaseline = 'top';
    xPos = new Float32Array(cols);
    yPos = new Float32Array(rows);
    for (let c = 0; c < cols; c++) xPos[c] = c * charWidth;
    for (let r = 0; r < rows; r++) yPos[r] = r * charHeight;
}

function buildVideoCanvas(width, height) {
    canvasVideoMode = true;
    pixelMode = false;
    gridCols = 0;
    gridRows = 0;
    canvas.width = width;
    canvas.height = height;
    canvas.style.display = 'block';
    canvas.style.imageRendering = 'auto';
    canvas.style.position = 'absolute';
    canvas.style.objectFit = 'contain';
    asciiPlayer.style.display = 'none';
    asciiPlayer.textContent = '';
    layoutVideoCanvas();
}

function layoutVideoCanvas() {
    if (!canvasVideoMode || !canvas.width || !canvas.height) return;
    const cw = playerContainer.clientWidth;
    const ch = playerContainer.clientHeight;
    const scale = Math.min(cw / canvas.width, ch / canvas.height);
    const w = Math.max(1, Math.floor(canvas.width * scale));
    const h = Math.max(1, Math.floor(canvas.height * scale));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${Math.floor((cw - w) / 2)}px`;
    canvas.style.top = `${Math.floor((ch - h) / 2)}px`;
}

function clearFrameBuffer() {
    for (const item of frameBuffer) {
        if (item && item.data && typeof ImageBitmap !== 'undefined' && item.data instanceof ImageBitmap) {
            item.data.close();
        }
    }
    frameBuffer.length = 0;
}

// ───────── Render loop ─────────
function renderFrame(now) {
    if (appState !== 'playing' || !readyToRender) return;
    requestAnimationFrame(renderFrame);

    if (frameBuffer.length === 0) return;

    if (!clockAnchored) {
        streamStartTime = now - frameBuffer[0].time * 1000 - PRESENT_LEAD_MS;
        clockAnchored   = true;
    }
    const masterClock = (now - streamStartTime) / 1000.0;

    // Drop frames that fell visibly behind (>100 ms) so a tab that was
    // backgrounded for a moment doesn't replay a backlog on resume.
    while (frameBuffer.length > 1 && frameBuffer[0].time < masterClock - 0.1) {
        const stale = frameBuffer.shift();
        if (stale && stale.data && typeof ImageBitmap !== 'undefined' && stale.data instanceof ImageBitmap) stale.data.close();
    }
    if (frameBuffer[0].time > masterClock + 0.05) return;

    const frameObj = frameBuffer.shift();
    const frame    = frameObj.data;

    frameCount++;
    if (lastPaintTime > 0) {
        const gap = now - lastPaintTime;
        if (gap > maxPaintInterval) maxPaintInterval = gap;
    }
    lastPaintTime = now;

    if (now - lastFpsUpdate >= 1000) {
        measuredFps      = frameCount;
        frameCount       = 0;
        lastFpsUpdate    = now;
        const jitter     = Math.round(maxPaintInterval);
        maxPaintInterval = 0;
        statusFps.textContent =
            `FPS ${measuredFps}/${Math.round(targetFps)}  ` +
            `JIT ${jitter}ms  BUF ${frameBuffer.length}`;
    }

    fpsWindowFrames++;
    if (now - fpsWindowStart >= 5000) {
        const windowFps = fpsWindowFrames / 5;
        fpsBelowThreshold = windowFps < targetFps * 0.70;
        statusPerf.classList.toggle('hidden', !fpsBelowThreshold);
        fpsWindowFrames = 0;
        fpsWindowStart  = now;
    }

    if (canvasVideoMode) {
        if (frame && typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) {
            lastCanvasFrameIndex = Math.max(lastCanvasFrameIndex, frameObj.index ?? -1);
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
            frame.close();
        }
        return;
    }

    if (renderMode === 1) {
        asciiPlayer.style.display = 'block';
        asciiPlayer.style.color   = '#fff';
        asciiPlayer.textContent   = frame;
        return;
    }
    if (pixelMode) {
        const view = frame;
        const data = dotImageData.data;
        for (let src = 0, dst = 0; src < view.length; src += 3, dst += 4) {
            data[dst]     = view[src + 2];
            data[dst + 1] = view[src + 1];
            data[dst + 2] = view[src];
        }
        ctx.putImageData(dotImageData, 0, 0);
        return;
    }

    // Color ASCII path: per-cell fillText with a same-color run optim.
    // Selection buffer is kept in memory every frame; the transparent <pre>'s
    // textContent is built on demand in the selectstart/copy handlers so the
    // paint loop never triggers a layout reflow.
    const view   = frame;
    const buf    = selectionBuffer;
    const stride = gridCols + 1;
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font         = 'bold 8px Courier New';
    ctx.textBaseline = 'top';
    let col = 0, row = 0, prevPacked = -1;
    for (let idx = 0; idx < view.length; idx += 4) {
        const ch = view[idx];
        const r  = view[idx + 1];
        const g  = view[idx + 2];
        const b  = view[idx + 3];
        const packed = (r << 16) | (g << 8) | b;
        if (packed !== prevPacked) {
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            prevPacked = packed;
        }
        ctx.fillText(CHAR_LUT[ch], xPos[col], yPos[row]);
        buf[row * stride + col] = ch;
        col++;
        if (col >= gridCols) { col = 0; row++; }
    }
    asciiPlayer.style.display = 'block';
    asciiPlayer.style.color   = 'transparent';
}

// ───────── Native video decoder → visible Canvas ─────────
// Canvas mode intentionally does not transfer individual JPEG frames. The
// browser decodes one fragmented-MP4 stream and Canvas paints presented frames.
function formatPlaybackTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

function getNativePlaybackTime() {
    if (!canvasSource) return nativeSeekOffset;
    const raw = Number(canvasSource.currentTime) || 0;
    // Some streaming MP4 implementations normalize a seeked segment to zero;
    // others preserve the source timestamp. The draw loop detects which form
    // this browser actually receives on the first frame after a seek.
    if (nativeSeekOffset > 0 && !nativeSeekUsesAbsoluteTime) return nativeSeekOffset + raw;
    if (nativeSeekOffset > 0 && nativeSeekUsesAbsoluteTime === null) return nativeSeekOffset + raw;
    return raw;
}

function updatePlaybackControls() {
    if (!playbackControls) return;
    const visible = canvasVideoMode && appState === 'playing';
    playbackControls.classList.toggle('hidden', !visible);
    if (!visible) return;

    const paused = !canvasSource || canvasSource.paused;
    btnPause.textContent = paused ? '▶' : 'Ⅱ';
    btnPause.setAttribute('aria-label', paused ? 'Fortsetzen' : 'Pause');
    btnPause.title = paused ? 'Fortsetzen' : 'Pause';

    const browserDuration = canvasSource && Number.isFinite(canvasSource.duration) && canvasSource.duration > 0
        ? canvasSource.duration : 0;
    const duration = nativeMediaDuration > 0 ? nativeMediaDuration : browserDuration;
    const live = nativeIsLive;
    playbackLive.classList.toggle('hidden', !live);
    playbackProgress.classList.toggle('hidden', live || !(duration > 0));
    playbackCurrentTime.classList.toggle('hidden', live || !(duration > 0));
    playbackDuration.classList.toggle('hidden', live || !(duration > 0));
    playbackProgress.disabled = live || !(duration > 0);

    if (live || !(duration > 0)) {
        playbackCurrentTime.textContent = 'LIVE';
        playbackDuration.textContent = '';
        return;
    }

    const current = Math.min(duration, getNativePlaybackTime());
    playbackCurrentTime.textContent = formatPlaybackTime(current);
    playbackDuration.textContent = formatPlaybackTime(duration);
    if (document.activeElement !== playbackProgress) {
        playbackProgress.value = String(Math.round((current / duration) * 1000));
    }
}

async function toggleNativePause() {
    if (!canvasVideoMode || !canvasSource || appState !== 'playing') return;
    if (canvasSource.paused) {
        try {
            await canvasSource.play();
        } catch (err) {
            statusPerf.textContent = `Fortsetzen nicht möglich: ${err && err.name || 'Fehler'}`;
            statusPerf.classList.remove('hidden');
        }
    } else {
        canvasSource.pause();
    }
    updatePlaybackControls();
}

async function seekNativeCanvas(seconds) {
    if (!canvasVideoMode || !canvasSource || !sessionId || nativeIsLive || !(nativeMediaDuration > 0)) return;
    const target = Math.max(0, Math.min(nativeMediaDuration - 0.5, Number(seconds) || 0));
    const wasPaused = canvasSource.paused;
    nativeSeekOffset = target;
    nativeSeekUsesAbsoluteTime = null;
    nativePauseAfterSeek = wasPaused;
    nativeLastMediaTime = -1;
    nativeDrawLoopRunning = false;
    if (nativeDrawRaf !== null) {
        cancelAnimationFrame(nativeDrawRaf);
        nativeDrawRaf = null;
    }
    if (nativeVideoFrameCallback !== null && typeof canvasSource.cancelVideoFrameCallback === 'function') {
        try { canvasSource.cancelVideoFrameCallback(nativeVideoFrameCallback); } catch (_) {}
        nativeVideoFrameCallback = null;
    }

    canvasSource.pause();
    const newSrc = `/media?session=${encodeURIComponent(sessionId)}&start=${encodeURIComponent(target.toFixed(3))}&_=${Date.now()}`;
    canvasSource.src = newSrc;
    canvasSource.load();
    // Start the new stream so its first frame can be decoded. If playback was
    // paused, nativeCanvasDrawLoop pauses again immediately after painting it.
    try {
        await canvasSource.play();
    } catch (err) {
        nativePauseAfterSeek = false;
        statusPerf.textContent = `Sprung fehlgeschlagen: ${err && err.name || 'Streamfehler'}`;
        statusPerf.classList.remove('hidden');
    }
    updatePlaybackControls();
}

if (btnPause) btnPause.addEventListener('click', toggleNativePause);
if (playbackProgress) {
    playbackProgress.addEventListener('input', () => {
        if (nativeMediaDuration > 0 && !nativeIsLive) {
            const previewTime = nativeMediaDuration * (Number(playbackProgress.value) / 1000);
            playbackCurrentTime.textContent = formatPlaybackTime(previewTime);
        }
    });
    playbackProgress.addEventListener('change', () => {
        if (nativeMediaDuration > 0 && !nativeIsLive) {
            seekNativeCanvas(nativeMediaDuration * (Number(playbackProgress.value) / 1000));
        }
    });
}

function stopNativeCanvasSource() {
    nativeDrawLoopRunning = false;
    if (nativeDrawRaf !== null) {
        cancelAnimationFrame(nativeDrawRaf);
        nativeDrawRaf = null;
    }
    if (canvasSource && nativeVideoFrameCallback !== null &&
        typeof canvasSource.cancelVideoFrameCallback === 'function') {
        try { canvasSource.cancelVideoFrameCallback(nativeVideoFrameCallback); } catch (_) {}
    }
    nativeVideoFrameCallback = null;
    nativeLastMediaTime = -1;
    nativeFpsCount = 0;
    nativeFpsWindowStart = 0;
    if (canvasSource) {
        canvasSource.onloadedmetadata = null;
        canvasSource.onplaying = null;
        canvasSource.onwaiting = null;
        canvasSource.onended = null;
        canvasSource.onerror = null;
        canvasSource.onpause = null;
        canvasSource.ontimeupdate = null;
        canvasSource.ondurationchange = null;
        canvasSource.onseeked = null;
        try { canvasSource.pause(); } catch (_) {}
        canvasSource.removeAttribute('src');
        try { canvasSource.load(); } catch (_) {}
    }
    nativeMediaDuration = 0;
    nativeIsLive = false;
    nativeSeekOffset = 0;
    nativeSeekUsesAbsoluteTime = true;
    nativePauseAfterSeek = false;
    if (playbackControls) playbackControls.classList.add('hidden');
}

function nativeCanvasDrawLoop(now) {
    if (!nativeDrawLoopRunning || appState !== 'playing' || !canvasVideoMode || !canvasSource || canvasSource.paused) {
        nativeDrawLoopRunning = false;
        return;
    }

    if (canvasSource.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && canvas.width && canvas.height) {
        const mediaTime = canvasSource.currentTime;
        // The RAF fallback may run at 60 Hz even for a 25/30 FPS source. Draw
        // only when the decoded video time advances; rVFC is already frame-led.
        if (mediaTime !== nativeLastMediaTime) {
            try {
                ctx.drawImage(canvasSource, 0, 0, canvas.width, canvas.height);
                if (nativeSeekUsesAbsoluteTime === null) {
                    nativeSeekUsesAbsoluteTime = nativeSeekOffset > 0 && mediaTime >= Math.max(0.5, nativeSeekOffset * 0.5);
                }
                nativeLastMediaTime = mediaTime;
                nativeFpsCount++;
                if (nativePauseAfterSeek) {
                    nativePauseAfterSeek = false;
                    canvasSource.pause();
                }
            } catch (err) {
                console.warn('Native Canvas draw failed:', err);
            }
        }
    }

    if (!nativeFpsWindowStart) nativeFpsWindowStart = now;
    const elapsed = now - nativeFpsWindowStart;
    if (elapsed >= 1000) {
        nativeRenderedFps = Math.round(nativeFpsCount * 1000 / elapsed);
        statusFps.textContent = `FPS ${nativeRenderedFps} · ${canvas.width}×${canvas.height}`;
        const tooSlow = nativeRenderedFps < Math.max(12, targetFps * 0.65);
        statusPerf.classList.toggle('hidden', !tooSlow);
        if (tooSlow) statusPerf.textContent = 'Video-Stream wird gebremst';
        nativeFpsCount = 0;
        nativeFpsWindowStart = now;
    }

    if (typeof canvasSource.requestVideoFrameCallback === 'function') {
        nativeVideoFrameCallback = canvasSource.requestVideoFrameCallback(nativeCanvasDrawLoop);
    } else {
        nativeDrawRaf = requestAnimationFrame(nativeCanvasDrawLoop);
    }
}

function ensureNativeCanvasDrawLoop() {
    if (nativeDrawLoopRunning || !canvasSource || !canvasVideoMode) return;
    nativeDrawLoopRunning = true;
    if (typeof canvasSource.requestVideoFrameCallback === 'function') {
        nativeVideoFrameCallback = canvasSource.requestVideoFrameCallback(nativeCanvasDrawLoop);
    } else {
        nativeDrawRaf = requestAnimationFrame(nativeCanvasDrawLoop);
    }
}

function startNativeCanvasMedia(sid, fallbackWidth, fallbackHeight, durationSeconds, isLive) {
    if (!canvasSource) {
        setError('Canvas-Videoelement fehlt. Bitte static/index.html prüfen.');
        return;
    }

    canvasVideoMode = true;
    targetFps = 30; // display stats reflect the decoded source cadence, not a server JPEG cap.
    buildVideoCanvas(fallbackWidth || 640, fallbackHeight || 360);
    nativeLastMediaTime = -1;
    nativeFpsCount = 0;
    nativeFpsWindowStart = 0;
    nativeMediaDuration = Number.isFinite(Number(durationSeconds)) ? Math.max(0, Number(durationSeconds)) : 0;
    nativeIsLive = Boolean(isLive);
    nativeSeekOffset = 0;
    nativeSeekUsesAbsoluteTime = true;
    nativePauseAfterSeek = false;

    canvasSource.playsInline = true;
    canvasSource.controls = false;
    canvasSource.preload = 'auto';
    canvasSource.muted = isMuted;
    canvasSource.volume = parseFloat(volumeSlider.value);

    canvasSource.onloadedmetadata = () => {
        if (appState !== 'playing' || !canvasVideoMode) return;
        // Preserve the actual source dimensions for sharp Canvas output. CSS
        // scales the canvas to the player viewport without reducing its pixels.
        if (canvasSource.videoWidth > 0 && canvasSource.videoHeight > 0) {
            canvas.width = canvasSource.videoWidth;
            canvas.height = canvasSource.videoHeight;
        }
        layoutVideoCanvas();
    };
    canvasSource.onplaying = () => {
        if (appState !== 'playing' || !canvasVideoMode) return;
        setStatus('PLAYING · CANVAS', 'playing');
        nativeFpsWindowStart = 0;
        updatePlaybackControls();
        ensureNativeCanvasDrawLoop();
    };
    canvasSource.onwaiting = () => {
        if (appState === 'playing' && canvasVideoMode) {
            setStatus('BUFFERING · CANVAS', 'resolving');
        }
    };
    canvasSource.onended = () => {
        if (appState === 'playing' && canvasVideoMode) {
            setStatus('ENDED', 'idle');
            finishPlayback();
        }
    };
    canvasSource.onpause = () => {
        if (appState === 'playing' && canvasVideoMode && !canvasSource.ended) {
            // A paused HTMLMediaElement may stop issuing video-frame callbacks.
            // Clear the loop flag so onplaying can always restart drawing.
            nativeDrawLoopRunning = false;
            if (nativeDrawRaf !== null) {
                cancelAnimationFrame(nativeDrawRaf);
                nativeDrawRaf = null;
            }
            if (nativeVideoFrameCallback !== null && typeof canvasSource.cancelVideoFrameCallback === 'function') {
                try { canvasSource.cancelVideoFrameCallback(nativeVideoFrameCallback); } catch (_) {}
                nativeVideoFrameCallback = null;
            }
            if (!nativePauseAfterSeek) setStatus('PAUSED · CANVAS', 'idle');
            updatePlaybackControls();
        }
    };
    canvasSource.ontimeupdate = updatePlaybackControls;
    canvasSource.ondurationchange = updatePlaybackControls;
    canvasSource.onseeked = updatePlaybackControls;
    canvasSource.onerror = () => {
        if (appState !== 'playing' || !canvasVideoMode) return;
        const code = canvasSource.error ? canvasSource.error.code : 0;
        const reason = ({
            1: 'Laden abgebrochen',
            2: 'Netzwerkfehler',
            3: 'Videodecodierung fehlgeschlagen',
            4: 'Streamformat nicht unterstützt'
        })[code] || 'unbekannter Videofehler';
        setError(`Canvas-Stream: ${reason} (Code ${code}). Render-Logs prüfen.`);
    };

    setStatus('BUFFERING · CANVAS', 'resolving');
    canvasSource.src = `/media?session=${encodeURIComponent(sid)}&start=0&_=${Date.now()}`;
    canvasSource.load();
    updatePlaybackControls();
    canvasSource.play().catch((err) => {
        if (appState !== 'playing' || !canvasVideoMode) return;
        if (err && err.name === 'NotAllowedError') {
            statusPerf.textContent = 'Klicke auf das Bild, um die Wiedergabe zu starten';
            statusPerf.classList.remove('hidden');
        } else {
            statusPerf.textContent = `Video: ${err && err.name || 'Wiedergabefehler'}`;
            statusPerf.classList.remove('hidden');
        }
    });
}

// Some browsers require another direct user gesture after stream resolution.
canvas.addEventListener('click', () => {
    if (canvasVideoMode && canvasSource && canvasSource.paused && appState === 'playing') {
        canvasSource.play().catch(() => {});
    }
});

function startRenderingAndAudio(sid) {
    if (audioEl) {
        audioEl.pause();
        audioEl.src = `/audio?session=${encodeURIComponent(sid)}&_=${Date.now()}`;
        audioEl.muted = isMuted;
        audioEl.volume = parseFloat(volumeSlider.value);
        audioEl.load();
        audioEl.play().catch((err) => {
            statusPerf.textContent = `audio: ${err && err.name || 'error'}`;
            statusPerf.classList.remove('hidden');
        });
    }
    readyToRender = true;
    lastFpsUpdate = performance.now();
    fpsWindowStart = lastFpsUpdate;
    requestAnimationFrame(renderFrame);
}

// ───────── WebSocket ─────────
function connectWs(sid) {
    clearFrameBuffer();
    canvasVideoMode = false;
    lastCanvasFrameIndex = -1;
    frameCount         = 0;
    measuredFps        = 0;
    fpsWindowFrames    = 0;
    fpsWindowStart     = 0;
    fpsBelowThreshold  = false;
    readyToRender      = false;
    clockAnchored      = false;
    lastPaintTime      = 0;
    maxPaintInterval   = 0;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/video?session=${encodeURIComponent(sid)}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => setStatus('BUFFERING', 'resolving');

    ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
            if (event.data.startsWith('Error:')) {
                setError(event.data.replace(/^Error:\s*/, ''));
                closeWs();
                return;
            }
            if (event.data.startsWith('CANVAS_INIT:')) {
                wsRetryCount = 0;
                const p = event.data.split(':');
                targetFps = parseFloat(p[1]);
                const width = parseInt(p[2], 10);
                const height = parseInt(p[3], 10);
                renderMode = 0;
                pixelMode = false;
                buildVideoCanvas(width, height);

                setStatus('PLAYING · CANVAS', 'playing');
                idleOverlay.classList.add('hidden');
                startRenderingAndAudio(sid);
                return;
            } else if (event.data.startsWith('INIT:')) {
                wsRetryCount = 0;
                const p = event.data.split(':');
                targetFps  = parseFloat(p[1]);
                renderMode = parseInt(p[2]);
                pixelMode  = (p.length > 5 && parseInt(p[5]) === 1);
                canvasVideoMode = false;
                buildCanvas(parseInt(p[3]), parseInt(p[4]));

                setStatus('PLAYING · ASCII', 'playing');
                idleOverlay.classList.add('hidden');

                startRenderingAndAudio(sid);
                return;
            }
            // Mode-1 text frame: "<idx>\n<frame text>".
            const nl  = event.data.indexOf('\n');
            const idx = parseInt(event.data.substring(0, nl));
            frameBuffer.push({ data: event.data.substring(nl + 1), time: idx / targetFps });
        } else {
            const view = new DataView(event.data);
            const idx  = view.getUint32(0, false);
            if (canvasVideoMode) {
                if (idx <= lastCanvasFrameIndex) return;
                const jpeg = event.data.slice(4);
                createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' })).then(bitmap => {
                    if (appState !== 'playing' || !canvasVideoMode || idx <= lastCanvasFrameIndex) {
                        bitmap.close();
                        return;
                    }
                    frameBuffer.push({ data: bitmap, time: idx / targetFps, index: idx });
                    frameBuffer.sort((a, b) => a.index - b.index);
                    while (frameBuffer.length > FRAME_BUFFER_MAX) {
                        const dropped = frameBuffer.shift();
                        if (dropped && dropped.data instanceof ImageBitmap) dropped.data.close();
                    }
                }).catch(err => {
                    console.warn('Canvas frame decode failed:', err);
                });
                return;
            }
            frameBuffer.push({ data: new Uint8Array(event.data, 4), time: idx / targetFps });
        }
        while (frameBuffer.length > FRAME_BUFFER_MAX) {
            const dropped = frameBuffer.shift();
            if (dropped && dropped.data && typeof ImageBitmap !== 'undefined' && dropped.data instanceof ImageBitmap) dropped.data.close();
        }
    };

    ws.onclose = (evt) => {
        // 1000 = normal close from our own stop/replace; 4003 = auth rejected.
        if (appState !== 'playing' || evt.code === 1000 || evt.code === 4003) {
            if (appState === 'playing') {
                setStatus('ENDED', 'idle');
                finishPlayback();
            }
            return;
        }

        wsRetryCount++;
        if (wsRetryCount > WS_MAX_RETRIES) {
            setError(`Stream disconnected — reconnect failed after ${WS_MAX_RETRIES} attempts`);
            finishPlayback();
            return;
        }
        const delay = wsRetryCount * 1000;
        setStatus(`RECONNECTING (${wsRetryCount}/${WS_MAX_RETRIES})…`, 'resolving');
        wsRetryTimer = setTimeout(() => {
            wsRetryTimer = null;
            if (appState === 'playing' && sessionId === sid) connectWs(sid);
        }, delay);
    };

    ws.onerror = () => { /* onclose drives reconnect */ };
}

// ───────── Control API ─────────
async function doPlay() {
    const query = queryInput.value.trim();
    if (!query) { queryInput.focus(); return; }

    const creatorHint = pendingSearchCreator;
    pendingSearchCreator = null;
    const thisCreatorLookupSequence = ++creatorLookupSequence;
    clearCreatorChannel();
    presetHint.classList.add('hidden');
    stopPoll();
    closeWs();
    if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); }
    clearCanvas();

    wsRetryCount = 0;
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }

    appState      = 'resolving';
    currentPreset = selectedPreset;
    setUiState('resolving');
    setStatus('RESOLVING…', 'resolving');
    statusTitle.textContent = query;
    statusLive.classList.add('hidden');
    statusFps.textContent = '';
    statusPerf.classList.add('hidden');

    let resp, data;
    try {
        resp = await fetch('/api/play', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ query, preset: currentPreset, display_mode: selectedDisplayMode }),
        });
        data = await resp.json();
    } catch (err) {
        setError('Network error — ' + err.message);
        setUiState('idle');
        return;
    }
    if (!resp.ok) {
        setError(data.error || `Server error ${resp.status}`);
        setUiState('idle');
        return;
    }

    sessionId = data.session_id;
    appState  = 'playing';
    setUiState('playing');
    updateTitle(data.title, data.is_live);
    if (creatorHint && creatorHint.channel_id) {
        showCreatorChannel(creatorHint);
    } else if (data.video_id) {
        void lookupCreatorForVideo(data.video_id, thisCreatorLookupSequence);
    }
    if (selectedDisplayMode === 'canvas') {
        idleOverlay.classList.add('hidden');
        startNativeCanvasMedia(sessionId, data.canvas_width, data.canvas_height, data.duration, data.is_live);
    } else {
        connectWs(sessionId);
    }
    startPoll();
}

async function doStop() {
    creatorLookupSequence++;
    pendingSearchCreator = null;
    clearCreatorChannel();
    stopPoll();
    wsRetryCount = 0;
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    try { await fetch('/api/stop', { method: 'POST' }); } catch (_) {}
    closeWs();
    finishPlayback();
    setStatus('IDLE', 'idle');
    statusTitle.textContent = '';
    statusLive.classList.add('hidden');
    presetHint.classList.add('hidden');
}

// ───────── Status polling ─────────
function startPoll() {
    stopPoll();
    pollTimer = setInterval(async () => {
        if (appState !== 'playing') { stopPoll(); return; }
        let data;
        try {
            const r = await fetch('/api/status');
            data = await r.json();
        } catch (_) { return; }
        if (data.title) updateTitle(data.title, data.is_live);
        if (data.state === 'error') {
            setError(data.error || 'Stream error');
            closeWs();
            finishPlayback();
            stopPoll();
        }
    }, 2000);
}

function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ───────── UI helpers ─────────
function setUiState(state) {
    btnPlay.disabled = false;
    btnStop.disabled = !(state === 'resolving' || state === 'playing');
}

function setStatus(label, stateClass) {
    statusState.textContent = label;
    statusState.className   = 'status-segment status-state';
    if (stateClass) statusState.classList.add('state-' + stateClass);
}

function setError(msg) {
    appState = 'error';
    statusTitle.textContent = '⚠ ' + msg;
    setStatus('ERROR', 'error');
    statusLive.classList.add('hidden');
    statusFps.textContent = '';
    statusPerf.classList.add('hidden');
    setUiState('idle');
    idleOverlay.classList.remove('hidden');
}

function updateTitle(title, isLive) {
    if (title) statusTitle.textContent = title;
    statusLive.classList.toggle('hidden', !isLive);
}

function finishPlayback() {
    creatorLookupSequence++;
    clearCreatorChannel();
    appState           = 'idle';
    readyToRender      = false;
    clearFrameBuffer();
    if (audioEl) { audioEl.pause(); audioEl.src = ''; }
    stopNativeCanvasSource();
    clearCanvas();
    idleOverlay.classList.remove('hidden');
    setUiState('idle');
    statusFps.textContent = '';
    statusPerf.classList.add('hidden');
    fpsBelowThreshold = false;
}

function clearCanvas() {
    // Also stop an active native media request before a new Play/Stop.
    stopNativeCanvasSource();
    canvasVideoMode = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display      = 'none';
    asciiPlayer.textContent   = '';
    asciiPlayer.style.display = 'none';
}

function closeWs() {
    if (!ws) return;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (_) {}
    ws = null;
}

// ───────── Selection / copy ─────────
// The transparent <pre> exists so users can drag-select and copy the ASCII
// frame.  Materializing its textContent on every paint forces a layout
// reflow per frame; instead, we materialize only when the user actually
// starts a selection or fires a copy.
const flushSelectionLayer = () => {
    if (!selectionBuffer || appState !== 'playing' || renderMode === 1) return;
    asciiPlayer.textContent = textDecoder.decode(selectionBuffer);
};
asciiPlayer.addEventListener('selectstart', flushSelectionLayer);
document.addEventListener('copy', flushSelectionLayer);

// ───────── YouTube Data API search and channel browsing ─────────
let searchRequestId = 0;
let currentSearchType = 'video';
let searchNextPageToken = '';
let searchItemCount = 0;
let activeSearchParams = { q: '', search_type: 'video' };
let searchView = 'search'; // search | channel
let savedChannelSearchQuery = '';
let activeChannel = null;
let currentCreator = null;
let pendingSearchCreator = null;
let creatorLookupSequence = 0;
let canReturnToChannelSearch = false;

function clearCreatorChannel() {
    currentCreator = null;
    if (creatorChannelBar) creatorChannelBar.classList.add('hidden');
}

function showCreatorChannel(channel) {
    if (!channel || !channel.channel_id || !creatorChannelBar) return;
    currentCreator = {
        channel_id: channel.channel_id,
        title: channel.title || channel.channel_title || channel.channel || 'YouTube-Kanal',
        thumbnail: channel.thumbnail || ''
    };
    if (creatorChannelTitle) creatorChannelTitle.textContent = currentCreator.title;
    if (creatorChannelSubtitle) creatorChannelSubtitle.textContent = 'Alle verfügbaren öffentlichen Videos dieses Kanals durchsuchen';
    creatorChannelBar.classList.remove('hidden');
}

async function lookupCreatorForVideo(videoId, requestSequence) {
    if (!videoId) return;
    try {
        const response = await fetch('/api/video-info?video_id=' + encodeURIComponent(videoId), { cache: 'no-store' });
        const data = await response.json();
        if (requestSequence !== creatorLookupSequence || appState !== 'playing' || !response.ok) return;
        showCreatorChannel(data);
    } catch (_) {
        // A creator button is a convenience feature. Playback must continue even
        // if the YouTube Data API metadata lookup fails or reaches its quota.
    }
}

function updateSearchChrome() {
    const heading = document.getElementById('search-heading');
    const tabs = document.getElementById('search-tabs');
    const channelMode = searchView === 'channel';
    if (heading) heading.textContent = channelMode ? `KANALVIDEOS · ${activeChannel?.title || 'YouTube-Kanal'}` : (currentSearchType === 'channel' ? 'KANÄLE / CREATOR' : 'YOUTUBE-SUCHERGEBNISSE');
    if (tabs) tabs.classList.toggle('hidden', channelMode);
    if (btnBackChannels) btnBackChannels.classList.toggle('hidden', !channelMode || !canReturnToChannelSearch);
    if (searchTabVideos) searchTabVideos.classList.toggle('active', !channelMode && currentSearchType === 'video');
    if (searchTabChannels) searchTabChannels.classList.toggle('active', !channelMode && currentSearchType === 'channel');
    if (btnLoadMore) btnLoadMore.textContent = channelMode ? 'MEHR VIDEOS LADEN' : 'MEHR ERGEBNISSE LADEN';
}

function makeSearchCard(item) {
    const isChannel = item.result_type === 'channel';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'search-result' + (isChannel ? ' search-result-channel' : '');
    card.setAttribute('aria-label', isChannel ? `Kanal öffnen: ${item.title}` : `Abspielen: ${item.title}`);

    const image = document.createElement('img');
    image.className = 'search-thumbnail' + (isChannel ? ' search-channel-thumbnail' : '');
    image.alt = '';
    image.loading = 'lazy';
    image.src = item.thumbnail || '';
    image.hidden = !item.thumbnail;

    const details = document.createElement('span');
    details.className = 'search-details';
    const title = document.createElement('span');
    title.className = 'search-result-title';
    title.textContent = item.title || (isChannel ? 'Unbekannter Kanal' : 'Unbekanntes Video');
    const metadata = document.createElement('span');
    metadata.className = 'search-channel';
    metadata.textContent = isChannel ? '▶ KANAL ÖFFNEN · Videos durchsuchen' : (item.channel || 'Unbekannter Kanal');
    details.append(title, metadata);

    if (isChannel && item.description) {
        const description = document.createElement('span');
        description.className = 'search-description';
        description.textContent = item.description;
        details.append(description);
    } else if (!isChannel && item.published_at) {
        const published = document.createElement('span');
        published.className = 'search-published';
        const date = new Date(item.published_at);
        published.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('de-DE');
        details.append(published);
    }

    card.append(image, details);
    card.addEventListener('click', () => {
        if (isChannel) {
            openChannel(item);
            return;
        }
        pendingSearchCreator = item.channel_id ? {
            channel_id: item.channel_id,
            title: item.channel || 'YouTube-Kanal',
            thumbnail: ''
        } : null;
        queryInput.value = item.video_id;
        searchPanel.classList.add('hidden');
        doPlay();
    });
    return card;
}

async function executeSearch(params, { append = false } = {}) {
    if (append && (!searchNextPageToken || (btnLoadMore && btnLoadMore.disabled))) return;
    const requestId = ++searchRequestId;
    const tokenForRequest = append ? searchNextPageToken : '';
    if (!append) {
        activeSearchParams = { ...params };
        searchResults.replaceChildren();
        searchNextPageToken = '';
        searchItemCount = 0;
        if (btnLoadMore) btnLoadMore.classList.add('hidden');
        searchMessage.textContent = searchView === 'channel' ? 'Kanalvideos werden geladen …' : 'Suche läuft …';
    } else if (btnLoadMore) {
        btnLoadMore.disabled = true;
        btnLoadMore.textContent = 'LÄDT …';
    }

    if (btnSearch) btnSearch.disabled = true;
    try {
        const urlParams = new URLSearchParams();
        if (params.q) urlParams.set('q', params.q);
        urlParams.set('search_type', params.search_type || 'video');
        urlParams.set('max_results', params.channel_id ? '50' : '25');
        if (params.channel_id) urlParams.set('channel_id', params.channel_id);
        if (params.uploads_playlist_id) urlParams.set('uploads_playlist_id', params.uploads_playlist_id);
        if (params.order) urlParams.set('order', params.order);
        if (tokenForRequest) urlParams.set('page_token', tokenForRequest);

        const response = await fetch('/api/search?' + urlParams.toString());
        const data = await response.json();
        if (requestId !== searchRequestId) return;
        if (!response.ok) {
            if (response.status === 403) throw new Error('Bitte zuerst mit deiner PIN anmelden und erneut suchen.');
            throw new Error(data.error || `Suche fehlgeschlagen (${response.status}).`);
        }

        if (params.channel_id && data.uploads_playlist_id) {
            activeSearchParams = { ...activeSearchParams, uploads_playlist_id: data.uploads_playlist_id };
        }
        const results = data.results || [];
        if (!append && !results.length) {
            searchMessage.textContent = searchView === 'channel' ? 'Für diesen Kanal wurden keine Videos gefunden.' : 'Keine Ergebnisse gefunden.';
            if (btnLoadMore) btnLoadMore.classList.add('hidden');
            return;
        }
        for (const item of results) searchResults.append(makeSearchCard(item));
        searchItemCount += results.length;
        searchNextPageToken = data.next_page_token || '';
        if (btnLoadMore) {
            btnLoadMore.classList.toggle('hidden', !searchNextPageToken);
            btnLoadMore.disabled = false;
        }

        const kindLabel = searchView === 'channel' ? 'Kanalvideos' : (currentSearchType === 'channel' ? 'Kanäle' : 'Videos');
        const total = Number(data.total_results || 0);
        const totalText = total > 0 ? ` von ca. ${total.toLocaleString('de-DE')}` : '';
        searchMessage.textContent = `${searchItemCount}${totalText} ${kindLabel} angezeigt` + (searchNextPageToken ? ' · weitere Ergebnisse verfügbar' : ' · Ende der Ergebnisse');
    } catch (error) {
        if (requestId === searchRequestId) {
            searchMessage.textContent = error.message || 'Die Suche ist fehlgeschlagen.';
            if (btnLoadMore) btnLoadMore.classList.toggle('hidden', !searchNextPageToken);
        }
    } finally {
        if (requestId === searchRequestId) {
            if (btnSearch) btnSearch.disabled = false;
            if (btnLoadMore) {
                btnLoadMore.disabled = false;
                if (btnLoadMore.classList.contains('hidden')) btnLoadMore.textContent = searchView === 'channel' ? 'MEHR VIDEOS LADEN' : 'MEHR ERGEBNISSE LADEN';
                else btnLoadMore.textContent = searchView === 'channel' ? 'MEHR VIDEOS LADEN' : 'MEHR ERGEBNISSE LADEN';
            }
        }
    }
}

function doSearch(type = currentSearchType) {
    const query = queryInput.value.trim();
    if (!query) { queryInput.focus(); return; }
    currentSearchType = type;
    searchView = 'search';
    activeChannel = null;
    canReturnToChannelSearch = false;
    if (type === 'channel') savedChannelSearchQuery = query;
    updateSearchChrome();
    searchPanel.classList.remove('hidden');
    return executeSearch({ q: query, search_type: type });
}

function openChannel(channel, { fromCurrentVideo = false } = {}) {
    if (!fromCurrentVideo && searchView === 'search' && currentSearchType === 'channel') {
        savedChannelSearchQuery = queryInput.value.trim() || savedChannelSearchQuery;
        canReturnToChannelSearch = Boolean(savedChannelSearchQuery);
    } else {
        canReturnToChannelSearch = false;
    }
    if (fromCurrentVideo && channel.title) queryInput.value = channel.title;
    activeChannel = channel;
    searchView = 'channel';
    currentSearchType = 'video';
    updateSearchChrome();
    searchPanel.classList.remove('hidden');
    searchPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return executeSearch({ q: '', search_type: 'video', channel_id: channel.channel_id, order: 'date' });
}

function backToChannelSearch() {
    if (!savedChannelSearchQuery) return;
    queryInput.value = savedChannelSearchQuery;
    currentSearchType = 'channel';
    searchView = 'search';
    activeChannel = null;
    canReturnToChannelSearch = false;
    updateSearchChrome();
    return executeSearch({ q: savedChannelSearchQuery, search_type: 'channel' });
}

function loadMoreSearchResults() {
    if (!activeSearchParams || !searchNextPageToken) return;
    return executeSearch(activeSearchParams, { append: true });
}

// ───────── Wiring ─────────
btnPlay.addEventListener('click', doPlay);
btnSearch.addEventListener('click', () => doSearch(currentSearchType));
if (btnCloseSearch) btnCloseSearch.addEventListener('click', () => searchPanel.classList.add('hidden'));
btnStop.addEventListener('click', doStop);
queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(currentSearchType); } });
if (searchTabVideos) searchTabVideos.addEventListener('click', () => doSearch('video'));
if (searchTabChannels) searchTabChannels.addEventListener('click', () => doSearch('channel'));
if (btnLoadMore) btnLoadMore.addEventListener('click', loadMoreSearchResults);
if (btnBackChannels) btnBackChannels.addEventListener('click', backToChannelSearch);
if (btnViewChannelVideos) btnViewChannelVideos.addEventListener('click', () => {
    if (currentCreator && currentCreator.channel_id) openChannel(currentCreator, { fromCurrentVideo: true });
});

window.addEventListener('resize', () => {
    if (canvasVideoMode && appState === 'playing') layoutVideoCanvas();
    else if (gridCols > 0 && appState === 'playing') buildCanvas(gridCols, gridRows);
});
