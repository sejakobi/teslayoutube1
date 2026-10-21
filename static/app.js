// ASCILINE YouTube streamer — Tesla browser frontend (Cleaned WebAudio & WebCodecs Canvas Edition).

'use strict';

// ───────── DOM Elemente ─────────
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

// ───────── Neue UI-Elemente (Search Tabs, Channels, Player Controls) ─────────
const searchTabVideos      = document.getElementById('search-tab-videos');
const searchTabChannels    = document.getElementById('search-tab-channels');
const btnLoadMore          = document.getElementById('btn-load-more');
const btnBackChannels      = document.getElementById('btn-back-channels');
const creatorChannelBar    = document.getElementById('creator-channel-bar');
const creatorChannelTitle  = document.getElementById('creator-channel-title');
const creatorChannelSubtitle = document.getElementById('creator-channel-subtitle');
const btnViewChannelVideos = document.getElementById('btn-view-channel-videos');

const playbackControls    = document.getElementById('playback-controls');
const btnPause            = document.getElementById('btn-pause');
const playbackProgress    = document.getElementById('playback-progress');
const playbackCurrentTime = document.getElementById('playback-current-time');
const playbackDuration    = document.getElementById('playback-duration');
const playbackLive        = document.getElementById('playback-live');

// ───────── State & Tarn-Player ─────────
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

// Metadaten für Fortschrittsanzeige
let nativeMediaDuration = 0;
let nativeIsLive = false;

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

// ───────── LocalStorage: Letzte Suche speichern ─────────
const LAST_SEARCH_KEY = 'asciline_last_search';

function saveLastSearch(query) {
    if (!query) return;
    try { localStorage.setItem(LAST_SEARCH_KEY, query); } catch (_) {}
}

function loadLastSearch() {
    try { return localStorage.getItem(LAST_SEARCH_KEY) || ''; } catch (_) { return ''; }
}

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

// ───────── Unsichtbares Web-Audio (Ohne <audio>-Tag) ─────────
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

                // Play/Pause Sync für WebAudio
                if (webCodecsState && webCodecsState.paused) {
                    // Audio-Pakete ignorieren, wenn pausiert
                    return; 
                }

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

// ───────── Render loop (ASCII Mode) ─────────
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
        statusFps.textContent = `FPS ${measuredFps}/${Math.round(targetFps)}  JIT ${jitter}ms`;
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

// ───────── Fortschrittsbalken & Play/Pause (Neu) ─────────
function formatPlaybackTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    seconds = Math.floor(seconds);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function updatePlaybackControls() {
    if (!playbackControls) return;
    const visible = canvasVideoMode && appState === 'playing';
    playbackControls.classList.toggle('hidden', !visible);
    if (!visible) return;

    const paused = webCodecsState ? webCodecsState.paused : false;
    btnPause.textContent = paused ? '▶' : 'Ⅱ';

    const duration = nativeMediaDuration;
    const live = nativeIsLive;
    playbackLive.classList.toggle('hidden', !live);
    playbackProgress.classList.toggle('hidden', live || duration <= 0);
    playbackCurrentTime.classList.toggle('hidden', live || duration <= 0);
    playbackDuration.classList.toggle('hidden', live || duration <= 0);
    
    // Fortschrittsbalken ist visuell, da Tesla-Stream nicht nativ spulen kann
    playbackProgress.style.pointerEvents = 'none'; 

    if (live || duration <= 0) {
        playbackCurrentTime.textContent = 'LIVE';
        playbackDuration.textContent = '';
        return;
    }

    let current = 0;
    if (webCodecsState && webCodecsState.playbackStart !== null) {
        const now = webCodecsState.paused ? webCodecsState.pauseTime : performance.now();
        current = (now - webCodecsState.playbackStart) / 1000;
    }

    current = Math.max(0, Math.min(duration, current));
    playbackCurrentTime.textContent = formatPlaybackTime(current);
    playbackDuration.textContent = formatPlaybackTime(duration);
    
    if (document.activeElement !== playbackProgress) {
        playbackProgress.value = String(Math.round((current / Math.max(1, duration)) * 1000));
    }
}

if (btnPause) {
    btnPause.addEventListener('click', () => {
        if (!webCodecsState || appState !== 'playing') return;
        webCodecsState.paused = !webCodecsState.paused;

        if (webCodecsState.paused) {
            if (audioContext && audioContext.state === 'running') audioContext.suspend();
            webCodecsState.pauseTime = performance.now();
            setStatus('PAUSED', 'idle');
        } else {
            if (audioContext && audioContext.state === 'suspended') audioContext.resume();
            if (webCodecsState.pauseTime) {
                const pauseDuration = performance.now() - webCodecsState.pauseTime;
                webCodecsState.playbackStart += pauseDuration;
                webCodecsState.pauseTime = null;
            }
            setStatus('PLAYING', 'playing');
        }
        updatePlaybackControls();
    });
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
    }
    if (playbackControls) playbackControls.classList.add('hidden');
}

function startWebCodecsDrawLoop(state) {
    if (state.raf || state.stopped) return;
    const draw = (now) => {
        state.raf = 0;
        if (state.stopped || webCodecsState !== state || appState !== 'playing') return;
        
        // Pausierte Schleife: Nichts tun außer auf Fortsetzung warten
        if (state.paused) {
            updatePlaybackControls();
            state.raf = requestAnimationFrame(draw);
            return;
        }

        if (state.playbackStart === null && state.frames.length) {
            state.playbackStart = now - (state.frames[0].timestamp / 1000);
        }
        const videoClock = state.playbackStart === null ? 0 : (now - state.playbackStart) / 1000;
        
        while (state.frames.length > 1 && state.frames[1].timestamp / 1e6 <= videoClock + 0.025) {
            const older = state.frames.shift();
            try { older.close(); } catch (_) {}
        }
        
        if (state.frames.length && state.frames[0].timestamp / 1e6 <= videoClock + 0.050) {
            const frame = state.frames.shift();
            try {
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                    canvas.width = frame.displayWidth;
                    canvas.height = frame.displayHeight;
                    layoutVideoCanvas();
                }
                ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
                state.drawn++;
            } catch (err) {
                console.warn('WebCodecs canvas paint failed', err);
            } finally { try { frame.close(); } catch (_) {} }
        }
        
        if (!state.fpsStart) state.fpsStart = now;
        if (now - state.fpsStart >= 1000) {
            const fps = Math.round(state.drawn * 1000 / Math.max(1, now - state.fpsStart));
            statusFps.textContent = `FPS ${fps} · ${canvas.width}×${canvas.height} · WebCodecs`;
            statusPerf.classList.toggle('hidden', fps >= 12);
            if (fps < 12) statusPerf.textContent = 'Dekodierung kommt nicht hinterher';
            state.drawn = 0;
            state.fpsStart = now;
        }

        updatePlaybackControls();
        state.raf = requestAnimationFrame(draw);
    };
    state.raf = requestAnimationFrame(draw);
}

async function startNativeCanvasMedia(sid, fallbackWidth, fallbackHeight, duration, isLive) {
    canvasVideoMode = true;
    targetFps = 30;
    nativeMediaDuration = Number(duration) || 0;
    nativeIsLive = Boolean(isLive);
    buildVideoCanvas(fallbackWidth || 640, fallbackHeight || 360);
    
    if (!('VideoDecoder' in window) || !window.MP4Box) {
        setError('Browser unterstützt WebCodecs nicht.');
        return;
    }

    stopNativeCanvasSource();
    const state = {
        stopped: false, paused: false, pauseTime: null, file: null, decoder: null, reader: null, raf: 0,
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
            
            const config = {
                codec: track.codec,
                codedWidth: track.video && track.video.width || track.track_width || fallbackWidth || 640,
                codedHeight: track.video && track.video.height || track.track_height || fallbackHeight || 360
            };
            
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
        if (!state.stopped && state.decoder) {
            try { await state.decoder.flush(); } catch (_) {}
            setStatus('STREAM ENDE', 'idle');
        }
    } catch (err) {
        if (!state.stopped) setError(`Canvas/WebCodecs: ${err.message || err}`);
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
            // ASCII Frame
            const nl  = event.data.indexOf('\n');
            const idx = parseInt(event.data.substring(0, nl));
            frameBuffer.push({ data: event.data.substring(nl + 1), time: idx / targetFps });
        } else {
            const view = new DataView(event.data);
            const idx  = view.getUint32(0, false);
            frameBuffer.push({ data: new Uint8Array(event.data, 4), time: idx / targetFps });
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
            setError(`Stream disconnected — reconnect failed`);
            finishPlayback();
            return;
        }
        setStatus(`RECONNECTING (${wsRetryCount}/${WS_MAX_RETRIES})…`, 'resolving');
        wsRetryTimer = setTimeout(() => {
            wsRetryTimer = null;
            if (appState === 'playing' && sessionId === sid) connectWs(sid);
        }, wsRetryCount * 1000);
    };
}

// ───────── Control API ─────────
async function doPlay() {
    const params = new URLSearchParams(location.search);
    const selection = params.get('selection');
    const query = queryInput.value.trim();
    if (!selection && !query) { if (queryInput) queryInput.focus(); return; }

    saveLastSearch(query);

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
    
    if (data.video_id) {
        lookupCreatorForVideo(data.video_id);
    }

    idleOverlay.classList.add('hidden');
    if (selectedDisplayMode === 'canvas' || selection) {
        startNativeCanvasMedia(sessionId, data.canvas_width, data.canvas_height, data.duration, data.is_live);
    } else {
        connectWs(sessionId);
    }
    startPoll();
}

async function doStop() {
    clearCreatorChannel();
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

const flushSelectionLayer = () => {
    if (!selectionBuffer || appState !== 'playing' || renderMode === 1) return;
    asciiPlayer.textContent = textDecoder.decode(selectionBuffer);
};
asciiPlayer.addEventListener('selectstart', flushSelectionLayer);
document.addEventListener('copy', flushSelectionLayer);


// ───────── YouTube Data API Search & Creator Channel ─────────
let searchRequestId = 0;
let currentSearchType = 'video';
let searchNextPageToken = '';
let searchItemCount = 0;
let activeSearchParams = { q: '', search_type: 'video' };
let searchView = 'search'; 
let savedChannelSearchQuery = '';
let activeChannel = null;
let currentCreator = null;
let pendingSearchCreator = null;

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
    if (creatorChannelSubtitle) creatorChannelSubtitle.textContent = 'Videos dieses Kanals durchsuchen';
    creatorChannelBar.classList.remove('hidden');
}

async function lookupCreatorForVideo(videoId) {
    if (!videoId) return;
    try {
        const response = await fetch('/api/video-info?video_id=' + encodeURIComponent(videoId), { cache: 'no-store' });
        const data = await response.json();
        if (appState !== 'playing' || !response.ok) return;
        showCreatorChannel(data);
    } catch (_) {}
}

function updateSearchChrome() {
    const heading = document.getElementById('search-heading');
    const tabs = document.getElementById('search-tabs');
    const channelMode = searchView === 'channel';
    if (heading) heading.textContent = channelMode ? `KANALVIDEOS · ${activeChannel?.title || 'YouTube-Kanal'}` : (currentSearchType === 'channel' ? 'KANÄLE' : 'YOUTUBE-SUCHERGEBNISSE');
    if (tabs) tabs.classList.toggle('hidden', channelMode);
    if (btnBackChannels) btnBackChannels.classList.toggle('hidden', !channelMode || !savedChannelSearchQuery);
    if (searchTabVideos) searchTabVideos.classList.toggle('active', !channelMode && currentSearchType === 'video');
    if (searchTabChannels) searchTabChannels.classList.toggle('active', !channelMode && currentSearchType === 'channel');
    if (btnLoadMore) btnLoadMore.textContent = channelMode ? 'MEHR VIDEOS LADEN' : 'MEHR ERGEBNISSE LADEN';
}

function makeSearchCard(item) {
    const isChannel = item.result_type === 'channel';
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'search-result' + (isChannel ? ' search-result-channel' : '');
    card.setAttribute('aria-label', isChannel ? `Kanal öffnen: ${item.title}` : `Abspielen: ${item.title}`);

    const image = document.createElement('img');
    image.className = 'search-thumbnail'; image.alt = ''; image.loading = 'lazy';
    image.src = item.thumbnail || ''; image.hidden = !item.thumbnail;

    const details = document.createElement('span'); details.className = 'search-details';
    const title = document.createElement('span'); title.className = 'search-title'; title.textContent = item.title || 'Unbekannt';
    const channel = document.createElement('span'); channel.className = 'search-channel'; channel.textContent = isChannel ? '▶ KANAL ÖFFNEN' : (item.channel || '');
    
    details.append(title, channel); card.append(image, details);
    
    card.addEventListener('click', () => {
        if (isChannel) {
            openChannel(item);
            return;
        }
        pendingSearchCreator = item.channel_id ? { channel_id: item.channel_id, title: item.channel } : null;
        queryInput.value = item.video_id || item.selection;
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
        searchMessage.textContent = 'Suche läuft …';
    } else if (btnLoadMore) {
        btnLoadMore.disabled = true;
        btnLoadMore.textContent = 'LÄDT …';
    }

    if (btnSearch) btnSearch.disabled = true;
    try {
        const urlParams = new URLSearchParams();
        if (params.q) urlParams.set('q', params.q);
        urlParams.set('search_type', params.search_type || 'video');
        if (params.channel_id) urlParams.set('channel_id', params.channel_id);
        if (params.uploads_playlist_id) urlParams.set('uploads_playlist_id', params.uploads_playlist_id);
        if (tokenForRequest) urlParams.set('page_token', tokenForRequest);

        const response = await fetch('/api/search?' + urlParams.toString());
        const data = await response.json();
        if (requestId !== searchRequestId) return;
        if (!response.ok) throw new Error(data.error || `Suche fehlgeschlagen (${response.status}).`);

        if (params.channel_id && data.uploads_playlist_id) {
            activeSearchParams = { ...activeSearchParams, uploads_playlist_id: data.uploads_playlist_id };
        }
        const results = data.results || [];
        if (!append && !results.length) {
            searchMessage.textContent = 'Keine Ergebnisse gefunden.';
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
        searchMessage.textContent = `${searchItemCount} Ergebnisse angezeigt`;
    } catch (error) {
        if (requestId === searchRequestId) {
            searchMessage.textContent = error.message || 'Die Suche ist fehlgeschlagen.';
            if (btnLoadMore) btnLoadMore.classList.toggle('hidden', !searchNextPageToken);
        }
    } finally {
        if (requestId === searchRequestId) {
            if (btnSearch) btnSearch.disabled = false;
            if (btnLoadMore) btnLoadMore.disabled = false;
        }
    }
}

function doSearch(type = currentSearchType) {
    const query = queryInput.value.trim();
    if (!query) { queryInput.focus(); return; }
    saveLastSearch(query);
    currentSearchType = type;
    searchView = 'search';
    activeChannel = null;
    if (type === 'channel') savedChannelSearchQuery = query;
    updateSearchChrome();
    searchPanel.classList.remove('hidden');
    return executeSearch({ q: query, search_type: type });
}

function openChannel(channel, { fromCurrentVideo = false } = {}) {
    if (!fromCurrentVideo && searchView === 'search' && currentSearchType === 'channel') {
        savedChannelSearchQuery = queryInput.value.trim() || savedChannelSearchQuery;
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
    updateSearchChrome();
    return executeSearch({ q: savedChannelSearchQuery, search_type: 'channel' });
}

// ───────── Event Wiring ─────────
btnPlay.addEventListener('click', doPlay);
btnSearch.addEventListener('click', () => doSearch(currentSearchType));
if (btnCloseSearch) btnCloseSearch.addEventListener('click', () => searchPanel.classList.add('hidden'));
btnStop.addEventListener('click', doStop);
queryInput.addEventListener('keydown', (e) => { 
    if (e.key === 'Enter') { e.preventDefault(); doSearch(currentSearchType); } 
});

if (searchTabVideos) searchTabVideos.addEventListener('click', () => doSearch('video'));
if (searchTabChannels) searchTabChannels.addEventListener('click', () => doSearch('channel'));
if (btnLoadMore) btnLoadMore.addEventListener('click', () => executeSearch(activeSearchParams, { append: true }));
if (btnBackChannels) btnBackChannels.addEventListener('click', backToChannelSearch);
if (btnViewChannelVideos) btnViewChannelVideos.addEventListener('click', () => {
    if (currentCreator && currentCreator.channel_id) openChannel(currentCreator, { fromCurrentVideo: true });
});

window.addEventListener('resize', () => {
    if (canvasVideoMode && appState === 'playing') layoutVideoCanvas();
    else if (gridCols > 0 && appState === 'playing') buildCanvas(gridCols, gridRows);
});

// Initialization
if (location.pathname === '/') {
    const last = loadLastSearch();
    if (last && !queryInput.value) queryInput.value = last;
} else if (location.pathname === '/watch') {
    document.body.classList.add('watch-page');
    const params = new URLSearchParams(location.search);
    const selection = params.get('selection');
    if (btnStop) btnStop.addEventListener('click', () => location.href = '/');
    if (selection) window.setTimeout(() => doPlay(), 100);
}
