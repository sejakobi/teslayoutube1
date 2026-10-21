// ASCILINE YouTube streamer — Tesla browser fronten.
// Pure WebCodecs Canvas + Pure WebAudio (No HTMLVideoElement / No HTMLAudioElement).

'use strict';

const queryInput          = document.getElementById('query-input');
const btnPlay             = document.getElementById('btn-play');
const btnSearch           = document.getElementById('btn-search');
const btnCloseSearch      = document.getElementById('btn-close-search');
const searchPanel         = document.getElementById('search-panel');
const searchResults       = document.getElementById('search-results');
const searchMessage       = document.getElementById('search-message');
const btnStop             = document.getElementById('btn-stop');
const presetBtns          = document.querySelectorAll('.preset-btn');
const displayModeBtns     = document.querySelectorAll('.display-mode-btn');
const presetHint          = document.getElementById('preset-hint');
const btnMute             = document.getElementById('btn-mute');
const volumeSlider        = document.getElementById('volume-slider');
const playerContainer     = document.getElementById('player-container');
const asciiPlayer         = document.getElementById('ascii-player');
const canvas              = document.getElementById('ascii-canvas');
const ctx                 = canvas.getContext('2d', { alpha: false, desynchronized: true });
const idleOverlay         = document.getElementById('idle-overlay');

// Custom Transport Controls (Play/Pause & Fortschrittsbalken ohne Media-Elemente)
const playbackControls    = document.getElementById('playback-controls');
const btnPause            = document.getElementById('btn-pause');
const playbackProgress    = document.getElementById('playback-progress');
const playbackCurrentTime = document.getElementById('playback-current-time');
const playbackDuration    = document.getElementById('playback-duration');

const statusTitle = document.getElementById('status-title');
const statusLive  = document.getElementById('status-live');
const statusState = document.getElementById('status-state');
const statusFps   = document.getElementById('status-fps');
const statusPerf  = document.getElementById('status-perf-hint');

let webCodecsState    = null;
let audioContext      = null;
let audioGainNode     = null;
let customAudioReader = null;
let activeAudioNodes  = [];
let nextAudioTime     = 0;

let appState            = 'idle'; // idle | resolving | playing | error
let ws                  = null;
let sessionId           = null;
let pollTimer           = null;
let currentPreset       = 'low';
let selectedPreset      = 'low';
let selectedDisplayMode = 'canvas';
let canvasVideoMode     = false;
let lastCanvasFrameIndex = -1;

// Wiedergabe-Zeit & Pause-Status für den Fortschrittsbalken
let mediaDurationSec  = 0;
let mediaIsLive       = false;
let seekBaseSeconds   = 0;
let isPlaybackPaused  = false;
let pauseStartedAt    = 0;
let isUserScrubbing   = false;

const WS_MAX_RETRIES = 5;
let wsRetryCount     = 0;
let wsRetryTimer     = null;

const frameBuffer       = [];
const FRAME_BUFFER_MAX  = 3;
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

let frameCount        = 0;
let measuredFps       = 0;
let lastFpsUpdate     = 0;
let fpsWindowFrames   = 0;
let fpsWindowStart    = 0;
let fpsBelowThreshold = false;
let lastPaintTime     = 0;
let maxPaintInterval  = 0;

// ───────── Hilfsfunktionen für Zeit & Fortschrittsbalken ─────────
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

function updatePlaybackControlsUI(currentSec) {
    if (!playbackControls) return;
    const show = appState === 'playing' && canvasVideoMode;
    playbackControls.classList.toggle('hidden', !show);
    if (!show) return;

    if (btnPause) {
        btnPause.textContent = isPlaybackPaused ? '▶' : 'Ⅱ';
        btnPause.setAttribute('aria-label', isPlaybackPaused ? 'Fortsetzen' : 'Pause');
    }

    if (mediaIsLive || !(mediaDurationSec > 0)) {
        if (playbackCurrentTime) playbackCurrentTime.textContent = mediaIsLive ? 'LIVE' : formatPlaybackTime(currentSec);
        if (playbackDuration) playbackDuration.textContent = '--:--';
        if (playbackProgress) playbackProgress.disabled = true;
        return;
    }

    if (playbackProgress) playbackProgress.disabled = false;
    const clamped = Math.max(0, Math.min(mediaDurationSec, currentSec));
    if (!isUserScrubbing) {
        if (playbackCurrentTime) playbackCurrentTime.textContent = formatPlaybackTime(clamped);
        if (playbackProgress) playbackProgress.value = String(Math.round((clamped / mediaDurationSec) * 1000));
    }
    if (playbackDuration) playbackDuration.textContent = formatPlaybackTime(mediaDurationSec);
}

async function toggleCustomPause() {
    if (appState !== 'playing' || !canvasVideoMode || !webCodecsState) return;
    isPlaybackPaused = !isPlaybackPaused;

    if (isPlaybackPaused) {
        pauseStartedAt = performance.now();
        if (audioContext && audioContext.state === 'running') {
            await audioContext.suspend().catch(() => {});
        }
        setStatus('PAUSED · CANVAS', 'idle');
    } else {
        const pausedDuration = performance.now() - pauseStartedAt;
        if (webCodecsState.playbackStart !== null) {
            webCodecsState.playbackStart += pausedDuration;
        }
        if (audioContext && audioContext.state === 'suspended') {
            await audioContext.resume().catch(() => {});
        }
        setStatus('PLAYING · CANVAS / WEBCODECS', 'playing');
    }
    updatePlaybackControlsUI(seekBaseSeconds + (webCodecsState.lastPresentedTime || 0));
}

function seekCustomCanvas(targetSeconds) {
    if (appState !== 'playing' || !canvasVideoMode || !sessionId || mediaIsLive || !(mediaDurationSec > 0)) return;
    const clamped = Math.max(0, Math.min(mediaDurationSec - 1, Number(targetSeconds) || 0));
    seekBaseSeconds = clamped;
    isPlaybackPaused = false;
    updatePlaybackControlsUI(clamped);
    startNativeCanvasMedia(sessionId, canvas.width || 640, canvas.height || 360, mediaDurationSec, mediaIsLive, clamped);
}

if (btnPause) {
    btnPause.addEventListener('click', () => { void toggleCustomPause(); });
}

if (playbackProgress) {
    playbackProgress.addEventListener('input', () => {
        if (!(mediaDurationSec > 0) || mediaIsLive) return;
        isUserScrubbing = true;
        const previewSec = (Number(playbackProgress.value) / 1000) * mediaDurationSec;
        if (playbackCurrentTime) playbackCurrentTime.textContent = formatPlaybackTime(previewSec);
    });
    playbackProgress.addEventListener('change', () => {
        if (!(mediaDurationSec > 0) || mediaIsLive) return;
        const targetSec = (Number(playbackProgress.value) / 1000) * mediaDurationSec;
        isUserScrubbing = false;
        seekCustomCanvas(targetSec);
    });
}

// Klick auf das Canvas-Bild pausiert / startet die Wiedergabe ebenfalls
canvas.addEventListener('click', () => {
    if (appState === 'playing' && canvasVideoMode) {
        if (audioContext && audioContext.state === 'suspended' && !isPlaybackPaused) {
            audioContext.resume().catch(() => {});
            statusPerf.classList.add('hidden');
            return;
        }
        void toggleCustomPause();
    }
});

// ───────── Preset & Mode Auswahl ─────────
presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const p = btn.dataset.preset;
        if (p === selectedPreset) return;
        selectedPreset = p;
        presetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === p));
        if (appState === 'playing' && sessionId) {
            void doPlay(seekBaseSeconds + (webCodecsState ? webCodecsState.lastPresentedTime : 0));
        } else {
            updateConfigHint();
        }
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

// ───────── Lautstärke / Stummschaltung (Reines WebAudio) ─────────
let isMuted = false;

volumeSlider.addEventListener('input', () => {
    const volume = parseFloat(volumeSlider.value);
    if (audioGainNode) audioGainNode.gain.value = volume;
    isMuted = volume === 0;
    updateMuteBtn();
});

btnMute.addEventListener('click', () => {
    isMuted = !isMuted;
    if (audioGainNode) audioGainNode.gain.value = isMuted ? 0 : parseFloat(volumeSlider.value);
    updateMuteBtn();
});

function updateMuteBtn() {
    btnMute.textContent = isMuted ? '🔇' : '🔊';
    btnMute.classList.toggle('muted', isMuted);
}

// ───────── Unsichtbares WebAudio-Streaming (Ohne <audio>-Tag) ─────────
function stopCustomWebAudio() {
    if (customAudioReader) {
        try { customAudioReader.cancel(); } catch (_) {}
        customAudioReader = null;
    }
    for (const node of activeAudioNodes) {
        try { node.stop(); node.disconnect(); } catch (_) {}
    }
    activeAudioNodes = [];
    nextAudioTime = 0;
}

async function startHiddenWebAudio(sid, startSec = 0) {
    stopCustomWebAudio();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    if (!audioContext) {
        audioContext = new AudioCtx();
        audioGainNode = audioContext.createGain();
        audioGainNode.connect(audioContext.destination);
    }
    audioGainNode.gain.value = isMuted ? 0 : parseFloat(volumeSlider.value);
    if (audioContext.state === 'suspended' && !isPlaybackPaused) {
        await audioContext.resume().catch(() => {});
    }

    try {
        const url = `/audio?session=${encodeURIComponent(sid)}&start=${encodeURIComponent(startSec.toFixed(3))}&_=${Date.now()}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        customAudioReader = reader;
        nextAudioTime = audioContext.currentTime + 0.12;

        let leftover = new Uint8Array(0);
        const MIN_CHUNK_SIZE = 24 * 1024;

        while (customAudioReader === reader && appState === 'playing') {
            const { value, done } = await reader.read();
            if (done) break;

            const merged = new Uint8Array(leftover.length + value.length);
            merged.set(leftover, 0);
            merged.set(value, leftover.length);

            if (merged.length < MIN_CHUNK_SIZE) {
                leftover = merged;
                continue;
            }
            leftover = new Uint8Array(0);

            audioContext.decodeAudioData(merged.buffer.slice(0)).then(audioBuffer => {
                if (customAudioReader !== reader || appState !== 'playing') return;
                const src = audioContext.createBufferSource();
                src.buffer = audioBuffer;
                src.connect(audioGainNode);
                activeAudioNodes.push(src);
                src.onended = () => {
                    const idx = activeAudioNodes.indexOf(src);
                    if (idx !== -1) activeAudioNodes.splice(idx, 1);
                };

                if (nextAudioTime < audioContext.currentTime) {
                    nextAudioTime = audioContext.currentTime + 0.04;
                }
                src.start(nextAudioTime);
                nextAudioTime += audioBuffer.duration;
            }).catch(() => {});
        }
    } catch (e) {
        console.warn('WebAudio Stream beendet:', e);
    }
}

// ───────── Canvas Setup ─────────
function buildCanvas(cols, rows) {
    gridCols = cols;
    gridRows = rows;

    const syncSize = (el) => {
        el.style.width     = playerContainer.clientWidth  + 'px';
        el.style.height    = playerContainer.clientHeight + 'px';
        el.style.objectFit = 'contain';
        el.style.position  = 'absolute';
        el.style.top       = '0';
        el.style.left      = '0';
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

// ───────── ASCII Render Loop ─────────
function renderFrame(now) {
    if (appState !== 'playing' || !readyToRender) return;
    requestAnimationFrame(renderFrame);

    if (frameBuffer.length === 0) return;

    if (!clockAnchored) {
        streamStartTime = now - frameBuffer[0].time * 1000 - PRESENT_LEAD_MS;
        clockAnchored   = true;
    }
    const masterClock = (now - streamStartTime) / 1000.0;

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

// ───────── WebCodecs Video Decoder → Visible Canvas (Mit Flow-Control & Keyframe-Schutz) ─────────
function stopNativeCanvasSource() {
    const state = webCodecsState;
    webCodecsState = null;
    if (state) {
        state.stopped = true;
        if (state.raf) cancelAnimationFrame(state.raf);
        if (state.reader) state.reader.cancel().catch(() => {});
        if (state.decoder) {
            try { state.decoder.close(); } catch (_) {}
        }
        for (const frame of state.frames || []) {
            try { frame.close(); } catch (_) {}
        }
        state.frames = [];
        state.sampleQueue = [];
        if (state.file && typeof state.file.stop === 'function') {
            try { state.file.stop(); } catch (_) {}
        }
    }
}

function getMp4VideoDescription(mp4File, track) {
    const trak = mp4File.getTrackById(track.id);
    const entries = trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl &&
        trak.mdia.minf.stbl.stsd && trak.mdia.minf.stbl.stsd.entries;
    if (!entries || !entries.length) return undefined;
    const entry = entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box || !window.MP4Box || !MP4Box.DataStream) return undefined;
    const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8);
}

// Füttert den VideoDecoder kontrolliert aus der Warteschlange, damit kein Puffer-Überlauf entsteht
function pumpSampleQueue(state) {
    if (!state || state.stopped || !state.decoderConfigured || !state.decoder) return;
    if (state.decoder.state !== 'configured') return;

    while (
        state.sampleQueue.length > 0 &&
        state.decoder.decodeQueueSize < 12 &&
        state.frames.length < 24
    ) {
        const sample = state.sampleQueue.shift();
        if (!sample || !sample.data) continue;

        // WebCodecs zwingt dazu, dass das allererste Sample nach configure() ein Keyframe ist!
        if (!state.gotFirstKeyframe) {
            if (!sample.is_sync) continue;
            state.gotFirstKeyframe = true;
        }

        if (state.timestampBase === null) state.timestampBase = sample.cts;
        const timestamp = Math.round(((sample.cts - state.timestampBase) * 1e6) / state.timescale);
        const duration = Math.max(1, Math.round((sample.duration * 1e6) / state.timescale));

        try {
            state.decoder.decode(new EncodedVideoChunk({
                type: sample.is_sync ? 'key' : 'delta',
                timestamp: Math.max(0, timestamp),
                duration: duration,
                data: sample.data,
            }));
            state.sampleCount++;
        } catch (err) {
            console.warn('Video sample decode error:', err);
        }
    }
}

function startWebCodecsDrawLoop(state) {
    if (state.raf || state.stopped) return;
    const draw = (now) => {
        state.raf = 0;
        if (state.stopped || webCodecsState !== state || appState !== 'playing') return;

        // Nachschub in den Decoder schieben, sobald Platz im Frame-Puffer ist
        pumpSampleQueue(state);

        if (!isPlaybackPaused && state.frames.length > 0) {
            if (state.playbackStart === null) {
                state.playbackStart = now - (state.frames[0].timestamp / 1000);
            }
            const videoClock = (now - state.playbackStart) / 1000;

            // Falls die Uhr durch einen kurzen Hänger stark abweicht (> 1.5s), Uhr neu synchronisieren
            const firstFrameSec = state.frames[0].timestamp / 1e6;
            if (Math.abs(firstFrameSec - videoClock) > 1.5) {
                state.playbackStart = now - (state.frames[0].timestamp / 1000);
            }

            const adjustedClock = (now - state.playbackStart) / 1000;

            // Zu alte Frames verwerfen
            while (state.frames.length > 1 && state.frames[1].timestamp / 1e6 <= adjustedClock + 0.02) {
                const older = state.frames.shift();
                try { older.close(); } catch (_) {}
            }

            // Aktuellen Frame zeichnen (oder sofort den allerersten Frame zeigen!)
            if (state.frames.length > 0 && (state.drawn === 0 || state.frames[0].timestamp / 1e6 <= adjustedClock + 0.05)) {
                const frame = state.frames.shift();
                try {
                    const fw = frame.displayWidth || frame.codedWidth || 640;
                    const fh = frame.displayHeight || frame.codedHeight || 360;
                    if (canvas.width !== fw || canvas.height !== fh) {
                        canvas.width = fw;
                        canvas.height = fh;
                        layoutVideoCanvas();
                    }
                    canvas.style.display = 'block';
                    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
                    state.drawn++;
                    state.lastPresentedTime = frame.timestamp / 1e6;
                    updatePlaybackControlsUI(seekBaseSeconds + state.lastPresentedTime);
                } catch (err) {
                    console.warn('WebCodecs canvas paint failed', err);
                } finally {
                    try { frame.close(); } catch (_) {}
                }
            }

            if (!state.fpsStart) state.fpsStart = now;
            if (now - state.fpsStart >= 1000) {
                const fps = Math.round((state.drawn * 1000) / Math.max(1, now - state.fpsStart));
                statusFps.textContent = `FPS ${fps} · ${canvas.width}×${canvas.height} · WebCodecs`;
                state.drawn = 0;
                state.fpsStart = now;
            }
        }
        state.raf = requestAnimationFrame(draw);
    };
    state.raf = requestAnimationFrame(draw);
}

async function startNativeCanvasMedia(sid, fallbackWidth, fallbackHeight, durationSeconds = 0, isLive = false, startSec = 0) {
    canvasVideoMode = true;
    targetFps = 30;
    mediaDurationSec = Number(durationSeconds) || mediaDurationSec || 0;
    mediaIsLive = Boolean(isLive);
    seekBaseSeconds = Number(startSec) || 0;
    isPlaybackPaused = false;

    buildVideoCanvas(fallbackWidth || 640, fallbackHeight || 360);
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window) || !window.MP4Box) {
        setError('Dieser Browser unterstützt WebCodecs nicht vollständig.');
        return;
    }

    stopNativeCanvasSource();
    const state = {
        stopped: false,
        file: null,
        decoder: null,
        reader: null,
        raf: 0,
        frames: [],
        sampleQueue: [],
        gotFirstKeyframe: false,
        playbackStart: null,
        drawn: 0,
        fpsStart: 0,
        lastPresentedTime: 0,
        started: false,
        track: null,
        timescale: 1,
        timestampBase: null,
        sampleCount: 0,
        decoderConfigured: false,
    };
    webCodecsState = state;
    setStatus('BUFFERING · WEBCODECS', 'resolving');
    statusPerf.classList.add('hidden');
    updatePlaybackControlsUI(seekBaseSeconds);

    // Unsichtbares WebAudio ab derselben Position starten
    void startHiddenWebAudio(sid, seekBaseSeconds);

    try {
        const mediaUrl = `/media?session=${encodeURIComponent(sid)}&start=${encodeURIComponent(seekBaseSeconds.toFixed(3))}&_=${Date.now()}`;
        const response = await fetch(mediaUrl, { cache: 'no-store' });
        if (!response.ok || !response.body) throw new Error(`Videostream HTTP ${response.status}`);
        
        const mp4File = MP4Box.createFile();
        state.file = mp4File;
        mp4File.onError = (message) => {
            if (!state.stopped) setError(`MP4-Demultiplexing fehlgeschlagen: ${message}`);
        };
        mp4File.onReady = (info) => {
            if (state.stopped || webCodecsState !== state) return;
            const track = (info.videoTracks || [])[0];
            if (!track) {
                setError('Der Stream enthält keine unterstützte Videospur.');
                return;
            }
            state.track = track;
            state.timescale = track.timescale || 1;
            if (!mediaDurationSec && info.duration && info.timescale) {
                mediaDurationSec = info.duration / info.timescale;
            }
            const description = getMp4VideoDescription(mp4File, track);
            const config = {
                codec: track.codec.startsWith('avc1') ? track.codec : 'avc1.64001f',
                codedWidth: (track.video && track.video.width) || track.track_width || fallbackWidth || 640,
                codedHeight: (track.video && track.video.height) || track.track_height || fallbackHeight || 360,
            };
            if (description) config.description = description;

            const support = VideoDecoder.isConfigSupported
                ? VideoDecoder.isConfigSupported(config)
                : Promise.resolve({ supported: true, config });

            support.then((result) => {
                if (state.stopped || webCodecsState !== state) return;
                if (!result.supported) throw new Error(`Codec nicht unterstützt: ${config.codec}`);
                
                state.decoder = new VideoDecoder({
                    output(frame) {
                        if (state.stopped || webCodecsState !== state) {
                            try { frame.close(); } catch (_) {}
                            return;
                        }
                        state.frames.push(frame);
                        if (!state.started) {
                            state.started = true;
                            setStatus('PLAYING · CANVAS / WEBCODECS', 'playing');
                            idleOverlay.classList.add('hidden');
                            canvas.style.display = 'block';
                            updatePlaybackControlsUI(seekBaseSeconds);
                            startWebCodecsDrawLoop(state);
                        }
                    },
                    error(error) {
                        console.error('VideoDecoder error:', error);
                        if (!state.stopped) setError(`VideoDecoder: ${error.message || error}`);
                    },
                });

                state.decoder.configure(result.config || config);
                state.decoderConfigured = true;
                mp4File.setExtractionOptions(track.id, null, { nbSamples: 8 });
                mp4File.start();
                pumpSampleQueue(state);
            }).catch((err) => {
                if (!state.stopped) setError(`WebCodecs-Konfiguration fehlgeschlagen: ${err.message || err}`);
            });
        };

        mp4File.onSamples = (trackId, user, samples) => {
            if (state.stopped || webCodecsState !== state) return;
            for (const sample of samples) {
                state.sampleQueue.push(sample);
            }
            pumpSampleQueue(state);
            // Speicher in MP4Box freigeben, sobald Samples in unserer Queue liegen
            if (samples.length > 0) {
                const lastSample = samples[samples.length - 1];
                if (typeof mp4File.releaseUsedSamples === 'function') {
                    try { mp4File.releaseUsedSamples(trackId, lastSample.number); } catch (_) {}
                }
            }
        };

        state.reader = response.body.getReader();
        let fileStart = 0;
        while (!state.stopped) {
            // Backpressure: Wenn schon genug Frames im Puffer warten, kurz pausieren mit dem Netzwerk-Lesen!
            while (!state.stopped && (state.sampleQueue.length > 60 || state.frames.length > 20)) {
                pumpSampleQueue(state);
                await new Promise(r => setTimeout(r, 40));
            }
            if (state.stopped) break;

            const { value, done } = await state.reader.read();
            if (done) break;
            const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            buffer.fileStart = fileStart;
            fileStart += buffer.byteLength;
            mp4File.appendBuffer(buffer);
            pumpSampleQueue(state);
        }
        if (!state.stopped && state.decoder && state.decoder.state === 'configured') {
            pumpSampleQueue(state);
            try { await state.decoder.flush(); } catch (_) {}
            setStatus('STREAM ENDE', 'idle');
        }
    } catch (err) {
        if (!state.stopped) setError(`Canvas/WebCodecs: ${err.message || err}`);
    }
}

function startRenderingAndAudio(sid) {
    void startHiddenWebAudio(sid, 0);
    readyToRender = true;
    lastFpsUpdate = performance.now();
    fpsWindowStart = lastFpsUpdate;
    requestAnimationFrame(renderFrame);
}

// ───────── WebSocket (ASCII Mode) ─────────
function connectWs(sid) {
    clearFrameBuffer();
    canvasVideoMode = false;
    lastCanvasFrameIndex = -1;
    frameCount        = 0;
    measuredFps       = 0;
    fpsWindowFrames   = 0;
    fpsWindowStart    = 0;
    fpsBelowThreshold = false;
    readyToRender     = false;
    clockAnchored     = false;
    lastPaintTime     = 0;
    maxPaintInterval  = 0;
    if (playbackControls) playbackControls.classList.add('hidden');

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
            const nl  = event.data.indexOf('\n');
            const idx = parseInt(event.data.substring(0, nl));
            frameBuffer.push({ data: event.data.substring(nl + 1), time: idx / targetFps });
        } else {
            const view = new DataView(event.data);
            const idx  = view.getUint32(0, false);
            frameBuffer.push({ data: new Uint8Array(event.data, 4), time: idx / targetFps });
        }
        while (frameBuffer.length > FRAME_BUFFER_MAX) {
            const dropped = frameBuffer.shift();
            if (dropped && dropped.data && typeof ImageBitmap !== 'undefined' && dropped.data instanceof ImageBitmap) dropped.data.close();
        }
    };

    ws.onclose = (evt) => {
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

    ws.onerror = () => {};
}

// ───────── Control API ─────────
async function doPlay(resumeAtSec = 0) {
    const params = new URLSearchParams(location.search);
    const selection = params.get('selection');
    const query = queryInput ? queryInput.value.trim() : '';
    if (!selection && !query) { if (queryInput) queryInput.focus(); return; }

    presetHint.classList.add('hidden');
    stopCustomWebAudio();
    stopPoll();
    closeWs();
    clearCanvas();

    wsRetryCount = 0;
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }

    appState      = 'resolving';
    currentPreset = selectedPreset;
    setUiState('resolving');
    setStatus('RESOLVING…', 'resolving');
    statusTitle.textContent = selection ? 'ASCILINE' : query;
    statusLive.classList.add('hidden');
    statusFps.textContent = '';
    statusPerf.classList.add('hidden');

    let resp, data;
    try {
        resp = await fetch('/api/play', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(selection
                ? { selection, preset: currentPreset, display_mode: selectedDisplayMode }
                : { query, preset: currentPreset, display_mode: selectedDisplayMode }),
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

    sessionId        = data.session_id;
    appState         = 'playing';
    mediaDurationSec = Number(data.duration) || 0;
    mediaIsLive      = Boolean(data.is_live);
    setUiState('playing');
    updateTitle(data.title, data.is_live);

    idleOverlay.classList.add('hidden');
    if (selectedDisplayMode === 'canvas') {
        startNativeCanvasMedia(
            sessionId,
            data.canvas_width,
            data.canvas_height,
            mediaDurationSec,
            mediaIsLive,
            Number(resumeAtSec) || 0
        );
    } else {
        connectWs(sessionId);
    }
    startPoll();
}

async function doStop() {
    stopCustomWebAudio();
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
        if (data.duration && !mediaDurationSec) {
            mediaDurationSec = Number(data.duration) || 0;
        }
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

function setUiState(state) {
    if (btnPlay) btnPlay.disabled = false;
    if (btnStop) btnStop.disabled = !(state === 'resolving' || state === 'playing');
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
    stopCustomWebAudio();
    appState          = 'idle';
    readyToRender     = false;
    isPlaybackPaused  = false;
    seekBaseSeconds   = 0;
    clearFrameBuffer();
    stopNativeCanvasSource();
    clearCanvas();
    idleOverlay.classList.remove('hidden');
    if (playbackControls) playbackControls.classList.add('hidden');
    setUiState('idle');
    statusFps.textContent = '';
    statusPerf.classList.add('hidden');
    fpsBelowThreshold = false;
}

function clearCanvas() {
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

const flushSelectionLayer = () => {
    if (!selectionBuffer || appState !== 'playing' || renderMode === 1) return;
    asciiPlayer.textContent = textDecoder.decode(selectionBuffer);
};
asciiPlayer.addEventListener('selectstart', flushSelectionLayer);
document.addEventListener('copy', flushSelectionLayer);

if (btnPlay) btnPlay.addEventListener('click', () => { void doPlay(0); });
if (btnStop) btnStop.addEventListener('click', doStop);

window.addEventListener('resize', () => {
    if (canvasVideoMode && appState === 'playing') layoutVideoCanvas();
    else if (gridCols > 0 && appState === 'playing') buildCanvas(gridCols, gridRows);
});

// Split-page mode: /watch startet automatisch das ausgewählte Video
if (location.pathname === '/watch') {
    document.body.classList.add('watch-page');
    const params = new URLSearchParams(location.search);
    const selection = params.get('selection');
    if (btnPlay) btnPlay.classList.add('hidden');
    if (btnSearch) btnSearch.classList.add('hidden');
    if (queryInput) { queryInput.value = ''; queryInput.classList.add('hidden'); }
    if (btnStop) {
        btnStop.classList.remove('hidden');
        btnStop.addEventListener('click', () => { location.href = '/'; });
    }
    if (selection) {
        window.setTimeout(() => { void doPlay(0); }, 0);
    } else {
        const arrow = document.getElementById('idle-arrow');
        if (arrow) arrow.textContent = 'Kein Video ausgewählt – bitte zur Suche zurückkehren.';
    }
}
