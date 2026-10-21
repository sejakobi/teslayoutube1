// ASCILINE YouTube streamer — Tesla browser frontend (Cleaned WebAudio & WebCodecs Canvas Edition).

'use strict';

const queryInput      = document.getElementById('query-input');
const btnPlay         = document.getElementById('btn-play');
const btnSearch       = document.getElementById('btn-search');
const btnCloseSearch  = document.getElementById('btn-close-search');
const searchPanel     = document.getElementById('search-panel');
const searchResults   = document.getElementById('search-results');
const searchMessage   = document.getElementById('search-message');
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

// Canvas/WebCodecs mode: Kein sichtbares oder im DOM registriertes Video- oder Audioelement mehr.
let webCodecsState = null;
let audioContext = null;
let audioGainNode = null;
let customAudioReader = null;
let nextAudioTime = 0;

const statusTitle = document.getElementById('status-title');
const statusLive  = document.getElementById('status-live');
const statusState = document.getElementById('status-state');
const statusFps   = document.getElementById('status-fps');
const statusPerf  = document.getElementById('status-perf-hint');

let appState       = 'idle';   // idle | resolving | playing | error
let ws             = null;
let sessionId      = null;
let pollTimer      = null;
let currentPreset  = 'low';
let selectedPreset = 'low';
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
let nativeSyncTimer = null;

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

// ───────── Volume / mute (Pure WebAudio) ─────────
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

// ───────── Unvisibles Web-Audio (Ohne <audio>-Tag) ─────────
function stopCustomWebAudio() {
    if (customAudioReader) {
        try { customAudioReader.cancel(); } catch (_) {}
        customAudioReader = null;
    }
    nextAudioTime = 0;
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.suspend().catch(() => {});
    }
}

async function startHiddenWebAudio(sid) {
    stopCustomWebAudio();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    if (!audioContext) {
        audioContext = new AudioCtx();
        audioGainNode = audioContext.createGain();
        audioGainNode.connect(audioContext.destination);
    }
    audioGainNode.gain.value = isMuted ? 0 : parseFloat(volumeSlider.value);
    if (audioContext.state === 'suspended') {
        await audioContext.resume().catch(() => {});
    }

    try {
        const res = await fetch(`/audio?session=${encodeURIComponent(sid)}&_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        customAudioReader = reader;
        nextAudioTime = audioContext.currentTime + 0.1;

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
                if (customAudioReader !== reader || appState === 'playing' === false) return;
                const src = audioContext.createBufferSource();
                src.buffer = audioBuffer;
                src.connect(audioGainNode);

                if (nextAudioTime < audioContext.currentTime) {
                    nextAudioTime = audioContext.currentTime + 0.05;
                }
                src.start(nextAudioTime);
                nextAudioTime += audioBuffer.duration;
            }).catch(() => {});
        }
    } catch (e) {
        console.warn('WebAudio Stream beendet:', e);
    }
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
        statusFps.textContent = `FPS ${measuredFps}/${Math.round(targetFps)}  JIT ${jitter}ms  BUF ${frameBuffer.length}`;
    }

    if (canvasVideoMode) {
        if (frame && typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) {
            lastCanvasFrameIndex = Math.max(lastCanvasFrameIndex, frameObj.index ?? -1);
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
            frame.close();
        }
        return;
    }
}

// ───────── WebCodecs video decoder → visible Canvas ─────────
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
        if (state.file && typeof state.file.stop === 'function') {
            try { state.file.stop(); } catch (_) {}
        }
    }
}

function getMp4VideoDescription(mp4File, track) {
    const trak = mp4File.getTrackById(track.id);
    const entry = trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl &&
        trak.mdia.minf.stbl.stsd && trak.mdia.minf.stbl.stsd.entries &&
        trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry && (entry.avcC || entry.hvcC || entry.vpcC || entry.av1C);
    if (!box || !window.MP4Box || !MP4Box.DataStream) return undefined;
    const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer).slice(8);
}

function startWebCodecsDrawLoop(state) {
    if (state.raf || state.stopped) return;
    const draw = (now) => {
        state.raf = 0;
        if (state.stopped || webCodecsState !== state || appState !== 'playing') return;

        // Füttere den Decoder mit neuem Material aus der Sample-Queue
        if (typeof pumpSampleQueue === 'function') {
            pumpSampleQueue(state);
        }

        if (!isPlaybackPaused) {
            if (state.playbackStart === null && state.frames.length) {
                state.playbackStart = now - (state.frames[0].timestamp / 1000);
            }
            let videoClock = state.playbackStart === null ? 0 : (now - state.playbackStart) / 1000;

            // --- AUDIO-SYNC KORREKTUR ---
            // Wenn der WebAudio-Kontext läuft, synchronisieren wir das Video sanft auf den Audiotakt
            if (audioContext && audioContext.state === 'running' && nextAudioTime > 0) {
                const estimatedAudioTime = (audioContext.currentTime - (nextAudioTime - (state.lastPresentedTime || 0)));
                const syncDiff = videoClock - estimatedAudioTime;
                // Wenn die Abweichung größer als 150 ms ist, korrigieren wir die Video-Uhr fließend
                if (Math.abs(syncDiff) > 0.15) {
                    state.playbackStart += syncDiff * 1000;
                    videoClock = (now - state.playbackStart) / 1000;
                }
            }

            const firstFrameSec = state.frames.length > 0 ? state.frames[0].timestamp / 1e6 : 0;
            if (state.frames.length > 0 && Math.abs(firstFrameSec - videoClock) > 1.5) {
                state.playbackStart = now - (state.frames[0].timestamp / 1000);
            }
            const adjustedClock = state.playbackStart === null ? 0 : (now - state.playbackStart) / 1000;

            // Zu alte Frames verwerfen
            while (state.frames.length > 1 && state.frames[1].timestamp / 1e6 <= adjustedClock + 0.02) {
                const older = state.frames.shift();
                try { older.close(); } catch (_) {}
            }

            // Aktuellen Frame zum richtigen Zeitpunkt zeichnen
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

async function startNativeCanvasMedia(sid, fallbackWidth, fallbackHeight) {
    canvasVideoMode = true;
    targetFps = 30;
    buildVideoCanvas(fallbackWidth || 640, fallbackHeight || 360);
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window) || !window.MP4Box) {
        setError('Browser unterstützt WebCodecs nicht.');
        return;
    }

    stopNativeCanvasSource();
    const state = {
        stopped: false, file: null, decoder: null, reader: null, raf: 0,
        frames: [], playbackStart: null, drawn: 0, started: false,
        track: null, timescale: 1, timestampBase: null, decoderConfigured: false
    };
    webCodecsState = state;
    setStatus('BUFFERING · WEBCODECS', 'resolving');

    // Starte den unsichtbaren WebAudio-Stream im Hintergrund
    startHiddenWebAudio(sid);

    try {
        const response = await fetch(`/media?session=${encodeURIComponent(sid)}&_=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok || !response.body) throw new Error(`Videostream HTTP ${response.status}`);
        const mp4File = MP4Box.createFile();
        state.file = mp4File;
        mp4File.onError = (message) => {
            if (!state.stopped) setError(`MP4 Fehler: ${message}`);
        };
        mp4File.onReady = (info) => {
            if (state.stopped || webCodecsState !== state) return;
            const track = (info.videoTracks || [])[0];
            if (!track) { setError('Keine Videospur gefunden.'); return; }
            state.track = track;
            state.timescale = track.timescale || 1;
            const description = getMp4VideoDescription(mp4File, track);
            const config = {
                codec: track.codec,
                codedWidth: track.video && track.video.width || track.track_width || fallbackWidth || 640,
                codedHeight: track.video && track.video.height || track.track_height || fallbackHeight || 360
            };
            if (description) config.description = description;
            
            VideoDecoder.isConfigSupported(config).then((result) => {
                if (state.stopped || webCodecsState !== state) return;
                state.decoder = new VideoDecoder({
                    output(frame) {
                        if (state.stopped || webCodecsState !== state) { frame.close(); return; }
                        state.frames.push(frame);
                        while (state.frames.length > 18) {
                            const old = state.frames.shift();
                            try { old.close(); } catch (_) {}
                        }
                        if (!state.started) {
                            state.started = true;
                            setStatus('PLAYING · CANVAS / WEBCODECS', 'playing');
                            idleOverlay.classList.add('hidden');
                            startWebCodecsDrawLoop(state);
                        }
                    },
                    error(error) {
                        if (!state.stopped) setError(`VideoDecoder: ${error.message || error}`);
                    }
                });
                state.decoder.configure(result.config || config);
                state.decoderConfigured = true;
                mp4File.setExtractionOptions(track.id, null, { nbSamples: 120 });
                mp4File.start();
            });
        };
        mp4File.onSamples = (trackId, user, samples) => {
            if (state.stopped || !state.decoderConfigured || !state.decoder) return;
            for (const sample of samples) {
                if (state.timestampBase === null) state.timestampBase = sample.cts;
                const timestamp = Math.round((sample.cts - state.timestampBase) * 1e6 / state.timescale);
                try {
                    state.decoder.decode(new EncodedVideoChunk({
                        type: sample.is_sync ? 'key' : 'delta',
                        timestamp: Math.max(0, timestamp),
                        duration: Math.max(1, Math.round(sample.duration * 1e6 / state.timescale)),
                        data: sample.data
                    }));
                } catch (err) {}
            }
        };
        state.reader = response.body.getReader();
        let fileStart = 0;
        while (!state.stopped) {
            const { value, done } = await state.reader.read();
            if (done) break;
            const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            buffer.fileStart = fileStart;
            fileStart += buffer.byteLength;
            mp4File.appendBuffer(buffer);
        }
    } catch (err) {
        if (!state.stopped) setError(`WebCodecs Fehler: ${err.message || err}`);
    }
}

// ───────── WebSocket (ASCII Mode) ─────────
function connectWs(sid) {
    clearFrameBuffer();
    canvasVideoMode = false;
    readyToRender = false;
    
    startHiddenWebAudio(sid);

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
            if (event.data.startsWith('CANVAS_INIT:') || event.data.startsWith('INIT:')) {
                wsRetryCount = 0;
                const p = event.data.split(':');
                targetFps = parseFloat(p[1]);
                if (event.data.startsWith('CANVAS_INIT:')) {
                    buildVideoCanvas(parseInt(p[2], 10), parseInt(p[3], 10));
                } else {
                    renderMode = parseInt(p[2]);
                    pixelMode = (p.length > 5 && parseInt(p[5]) === 1);
                    buildCanvas(parseInt(p[3]), parseInt(p[4]));
                }
                setStatus('PLAYING', 'playing');
                idleOverlay.classList.add('hidden');
                readyToRender = true;
                requestAnimationFrame(renderFrame);
                return;
            }
        }
    };
}

// ───────── Control API ─────────
async function doPlay() {
    const params = new URLSearchParams(location.search);
    const selection = params.get('selection');
    const query = queryInput.value.trim();
    if (!selection && !query) { if (queryInput) queryInput.focus(); return; }

    stopCustomWebAudio();
    stopPoll();
    closeWs();
    clearCanvas();

    appState      = 'resolving';
    currentPreset = selectedPreset;
    setUiState('resolving');
    setStatus('RESOLVING…', 'resolving');
    statusTitle.textContent = selection ? 'ASCILINE' : query;

    let resp, data;
    try {
        resp = await fetch('/api/play', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(selection ? { selection, preset: currentPreset, display_mode: "canvas" } : { query, preset: currentPreset, display_mode: selectedDisplayMode }),
        });
        data = await resp.json();
    } catch (err) {
        setError('Netzwerkfehler — ' + err.message);
        setUiState('idle');
        return;
    }
    if (!resp.ok) {
        setError(data.error || `Serverfehler ${resp.status}`);
        setUiState('idle');
        return;
    }

    sessionId = data.session_id;
    appState  = 'playing';
    setUiState('playing');
    updateTitle(data.title, data.is_live);
    
    idleOverlay.classList.add('hidden');
    if (selectedDisplayMode === 'canvas' || selection) {
        startNativeCanvasMedia(sessionId, data.canvas_width, data.canvas_height);
    } else {
        connectWs(sessionId);
    }
    startPoll();
}

async function doStop() {
    stopCustomWebAudio();
    stopPoll();
    try { await fetch('/api/stop', { method: 'POST' }); } catch (_) {}
    closeWs();
    finishPlayback();
    setStatus('IDLE', 'idle');
    statusTitle.textContent = '';
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
        if (data.state === 'error') {
            setError(data.error || 'Stream-Fehler');
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
    setUiState('idle');
    idleOverlay.classList.remove('hidden');
}

function updateTitle(title, isLive) {
    if (title) statusTitle.textContent = title;
    statusLive.classList.toggle('hidden', !isLive);
}

function finishPlayback() {
    stopCustomWebAudio();
    appState           = 'idle';
    readyToRender      = false;
    clearFrameBuffer();
    stopNativeCanvasSource();
    clearCanvas();
    idleOverlay.classList.remove('hidden');
    setUiState('idle');
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

// ───────── YouTube Suche ─────────
let searchRequestId = 0;

async function doSearch() {
    const query = queryInput.value.trim();
    if (!query) { queryInput.focus(); return; }
    const requestId = ++searchRequestId;
    searchPanel.classList.remove('hidden');
    searchResults.replaceChildren();
    searchMessage.textContent = 'Suche läuft …';
    btnSearch.disabled = true;
    try {
        const response = await fetch('/api/search?q=' + encodeURIComponent(query));
        const data = await response.json();
        if (requestId !== searchRequestId) return;
        if (!response.ok) throw new Error(data.error || `Suche fehlgeschlagen (${response.status}).`);
        const results = data.results || [];
        if (!results.length) { searchMessage.textContent = 'Keine Videos gefunden.'; return; }
        searchMessage.textContent = `${results.length} Ergebnisse`;
        for (const video of results) {
            const card = document.createElement('button');
            card.type = 'button'; card.className = 'search-result';
            const image = document.createElement('img');
            image.className = 'search-thumbnail'; image.alt = ''; image.loading = 'lazy';
            image.src = video.thumbnail || ''; image.hidden = !video.thumbnail;
            const details = document.createElement('span'); details.className = 'search-details';
            const title = document.createElement('span'); title.className = 'search-title'; title.textContent = video.title;
            const channel = document.createElement('span'); channel.className = 'search-channel'; channel.textContent = video.channel || '';
            details.append(title, channel); card.append(image, details);
            card.addEventListener('click', () => { location.href = '/watch?selection=' + encodeURIComponent(video.selection); });
            searchResults.append(card);
        }
    } catch (error) {
        if (requestId === searchRequestId) searchMessage.textContent = error.message || 'Suche fehlgeschlagen.';
    } finally { if (requestId === searchRequestId) btnSearch.disabled = false; }
}

btnPlay.addEventListener('click', doPlay);
btnSearch.addEventListener('click', doSearch);
if (btnCloseSearch) btnCloseSearch.addEventListener('click', () => searchPanel.classList.add('hidden'));
btnStop.addEventListener('click', doStop);
queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

if (location.pathname === '/watch') {
  document.body.classList.add('watch-page');
  const params = new URLSearchParams(location.search);
  const selection = params.get('selection');
  if (btnPlay) btnPlay.classList.add('hidden');
  if (btnSearch) btnSearch.classList.add('hidden');
  if (queryInput) { queryInput.value = ''; queryInput.classList.add('hidden'); }
  if (btnStop) { btnStop.classList.remove('hidden'); btnStop.addEventListener('click', () => { location.href = '/'; }); }
  if (selection) {
    window.setTimeout(() => { void doPlay(); }, 0);
  }
}
