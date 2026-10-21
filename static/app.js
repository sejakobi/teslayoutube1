// ASCILINE YouTube streamer — Tesla browser frontend (Cleaned WebAudio & WebCodecs Canvas Edition).
// Features: Infinite Scroll, Channel Search, Stealth Transport Controls, Audio/Video Sync, Tesla Fix, Auto-Recovery

'use strict';

// ───────── DOM Elements ─────────
const queryInput          = document.getElementById('search-query') || document.getElementById('query-input');
const btnPlay             = document.getElementById('btn-play');
const btnSearch           = document.getElementById('search-button') || document.getElementById('btn-search');
const btnCloseSearch      = document.getElementById('btn-close-search');
const searchPanel         = document.getElementById('search-panel');
const searchResults       = document.getElementById('search-results');
const searchMessage       = document.getElementById('search-message');
const tabVideos           = document.getElementById('tab-videos');
const tabChannels         = document.getElementById('tab-channels');
const btnStop             = document.getElementById('btn-stop');
const presetBtns          = document.querySelectorAll('.preset-btn');
const displayModeBtns     = document.querySelectorAll('.display-mode-btn');
const presetHint          = document.getElementById('preset-hint');
const btnMute             = document.getElementById('btn-mute');
const volumeSlider        = document.getElementById('volume-slider');
const playerContainer     = document.getElementById('player-container');
const asciiPlayer         = document.getElementById('ascii-player');
const canvas              = document.getElementById('ascii-canvas');
// WICHTIG für Tesla (Linux/X11 Chromium 100): kein desynchronized: true verwenden, da sonst Standbild nach Frame 1!
const ctx                 = canvas.getContext('2d', { alpha: false });
const idleOverlay         = document.getElementById('idle-overlay');

// Custom Transport Controls
const playbackControls    = document.getElementById('playback-controls');
const btnPause            = document.getElementById('btn-pause');
const playbackProgress    = document.getElementById('playback-progress');
const playbackCurrentTime = document.getElementById('playback-current-time');
const playbackDuration    = document.getElementById('playback-duration');

// Channel Banner & Scroll
const channelBanner       = document.getElementById('channel-banner');
const channelAvatar       = document.getElementById('channel-banner-avatar');
const channelTitle        = document.getElementById('channel-banner-title');
const channelDesc         = document.getElementById('channel-banner-desc');
const btnCloseChannel     = document.getElementById('btn-close-channel');
const scrollSentinel      = document.getElementById('scroll-sentinel');
const scrollLoader        = document.getElementById('scroll-loader');

const statusTitle = document.getElementById('status-title');
const statusLive  = document.getElementById('status-live');
const statusState = document.getElementById('status-state');
const statusFps   = document.getElementById('status-fps');
const statusPerf  = document.getElementById('status-perf-hint');

// ───────── Global State ─────────
let webCodecsState       = null;
let audioContext         = null;
let audioGainNode        = null;
let customAudioReader    = null;
let activeAudioNodes     = [];
let nextAudioTime        = 0;
let firstAudioAnchorTime = null;
let audioRetryTimer      = null;

let appState             = 'idle'; // idle | resolving | playing | error
let ws                   = null;
let sessionId            = null;
let pollTimer            = null;
let currentPreset        = 'low';
let selectedPreset       = 'low';
let selectedDisplayMode  = 'canvas';
let canvasVideoMode      = false;
let lastCanvasFrameIndex = -1;

// Playback Time & Seek State
let mediaDurationSec  = 0;
let mediaIsLive       = false;
let seekBaseSeconds   = 0;
let isPlaybackPaused  = false;
let pauseStartedAt    = 0;
let isUserScrubbing   = false;

// Auto-Recovery State (gegen Abbrüche bei Netzunterbrechungen oder Stream-Fehlern)
const MEDIA_MAX_RETRIES = 12;
let mediaRetryCount     = 0;
let mediaRetryTimer     = null;
let lastKnownPosition   = 0;

// Search State
const STORAGE_KEY     = 'asciline_search_state_v1';
let searchRequestNo   = 0;
let currentSearchType = 'video';
let activeChannel     = null;
let nextPageToken     = '';
let isFetchingMore    = false;
let totalLoaded       = 0;

const WS_MAX_RETRIES = 5;
let wsRetryCount     = 0;
let wsRetryTimer     = null;

const frameBuffer      = [];
const FRAME_BUFFER_MAX = 3;
const PRESENT_LEAD_MS  = 60;
let targetFps          = 24;
let renderMode         = 1;
let pixelMode          = false;
let readyToRender      = false;
let gridCols = 0, gridRows = 0;
let charWidth = 0, charHeight = 0;
let xPos = null, yPos = null;
let dotImageData       = null;
let selectionBuffer    = null;
let clockAnchored      = false;
let streamStartTime    = 0;
const textDecoder      = new TextDecoder();
const CHAR_LUT         = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i));

let frameCount        = 0;
let measuredFps       = 0;
let lastFpsUpdate     = 0;
let fpsWindowFrames   = 0;
let fpsWindowStart    = 0;
let fpsBelowThreshold = false;
let lastPaintTime     = 0;
let maxPaintInterval  = 0;

// ───────── Auto-Recovery Helpers ─────────
function clearRecoveryTimers() {
    if (mediaRetryTimer !== null) {
        clearTimeout(mediaRetryTimer);
        mediaRetryTimer = null;
    }
    if (audioRetryTimer !== null) {
        clearTimeout(audioRetryTimer);
        audioRetryTimer = null;
    }
}

function getCurrentPlaybackSecond() {
    if (webCodecsState && Number.isFinite(webCodecsState.lastPresentedTime) && webCodecsState.lastPresentedTime > 0) {
        lastKnownPosition = seekBaseSeconds + webCodecsState.lastPresentedTime;
    }
    return Math.max(0, lastKnownPosition || seekBaseSeconds || 0);
}

function scheduleMediaRecovery(reason, forceNewSession = false) {
    if (appState !== 'playing' && appState !== 'resolving') return;
    if (mediaRetryTimer !== null) return; // Bereits ein Reconnect geplant

    const resumeSec = getCurrentPlaybackSecond();

    // Wenn wir bereits ganz am Ende des Videos sind, normal beenden statt Reconnect
    if (!mediaIsLive && mediaDurationSec > 0 && resumeSec >= mediaDurationSec - 2) {
        setStatus('STREAM ENDE', 'idle');
        return;
    }

    mediaRetryCount++;
    if (mediaRetryCount > MEDIA_MAX_RETRIES) {
        setError(`Verbindung nach ${MEDIA_MAX_RETRIES} Versuchen abgebrochen (${reason}). Klicke auf das Bild zum Fortsetzen.`);
        return;
    }

    const delayMs = Math.min(5000, 1000 + (mediaRetryCount - 1) * 750);
    console.warn(`[Auto-Recovery] ${reason} — Versuch ${mediaRetryCount}/${MEDIA_MAX_RETRIES} in ${delayMs}ms ab Sekunde ${resumeSec.toFixed(1)}`);
    setStatus(`RECONNECTING (${mediaRetryCount}/${MEDIA_MAX_RETRIES})…`, 'resolving');
    if (statusPerf) {
        statusPerf.textContent = `Verbindung wird wiederhergestellt (${reason})…`;
        statusPerf.classList.remove('hidden');
    }

    // Aktuellen Stream sauber anhalten, aber das letzte Bild auf dem Canvas stehen lassen!
    stopNativeCanvasSource();
    stopCustomWebAudio();

    mediaRetryTimer = setTimeout(() => {
        mediaRetryTimer = null;
        if (appState !== 'playing' && appState !== 'resolving') return;

        if (forceNewSession || !sessionId) {
            void doPlay(resumeSec, null, true);
        } else {
            void startNativeCanvasMedia(
                sessionId,
                canvas.width || 640,
                canvas.height || 360,
                mediaDurationSec,
                mediaIsLive,
                resumeSec,
                true
            );
        }
    }, delayMs);
}

// ───────── Search & Infinite Scroll Logic ─────────
function saveSearchState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            query: queryInput ? queryInput.value.trim() : '',
            searchType: currentSearchType,
            activeChannel: activeChannel,
        }));
    } catch (_) {}
}

function loadSearchState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

function updateFilterUI() {
    const isChanView = Boolean(activeChannel);
    if (tabVideos) tabVideos.classList.toggle('active', !isChanView && currentSearchType === 'video');
    if (tabChannels) tabChannels.classList.toggle('active', !isChanView && currentSearchType === 'channel');

    if (isChanView && channelBanner) {
        channelBanner.classList.remove('hidden');
        if (channelTitle) channelTitle.textContent = activeChannel.title || 'YouTube-Kanal';
        if (channelDesc) channelDesc.textContent = activeChannel.description || 'Alle öffentlichen Uploads dieses Kanals';
        if (channelAvatar && activeChannel.thumbnail) {
            channelAvatar.src = activeChannel.thumbnail;
            channelAvatar.classList.remove('hidden');
        } else if (channelAvatar) {
            channelAvatar.classList.add('hidden');
        }
        if (document.getElementById('results-title')) {
            document.getElementById('results-title').textContent = `Videos von ${activeChannel.title}`;
        }
    } else {
        if (channelBanner) channelBanner.classList.add('hidden');
        if (document.getElementById('results-title')) {
            document.getElementById('results-title').textContent = currentSearchType === 'channel' ? 'Gefundene Kanäle' : 'Suchergebnisse';
        }
    }
}

function createVideoCard(item) {
    const card = document.createElement('div');
    card.className = 'result';

    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = item.thumbnail || '';
    wrap.append(img);

    const mark = document.createElement('span');
    mark.className = 'playmark';
    mark.textContent = '▶';
    wrap.append(mark);

    const openVideo = () => {
        if (item.selection) {
            saveSearchState();
            location.href = '/watch?selection=' + encodeURIComponent(item.selection);
        }
    };
    wrap.addEventListener('click', openVideo);

    const body = document.createElement('div');
    body.className = 'result-body';

    const t = document.createElement('div');
    t.className = 'result-title';
    t.textContent = item.title || 'Unbenanntes Video';
    t.addEventListener('click', openVideo);

    const chBtn = document.createElement('button');
    chBtn.type = 'button';
    chBtn.className = 'result-channel-btn';
    chBtn.textContent = '📺 ' + (item.channel || 'Unbekannter Kanal');
    chBtn.title = 'Alle Videos dieses Kanals anzeigen';
    chBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.channel_id) {
            openChannelView({
                channel_id: item.channel_id,
                title: item.channel || 'YouTube-Kanal',
                description: '',
                thumbnail: '',
            });
        }
    });

    const meta = document.createElement('div');
    meta.className = 'result-meta';
    const m1 = document.createElement('span');
    m1.textContent = item.published_at ? new Date(item.published_at).toLocaleDateString('de-DE') : 'VIDEO';
    const m2 = document.createElement('span');
    m2.textContent = 'CANVAS STREAM ↗';
    meta.append(m1, m2);

    body.append(t, chBtn, meta);
    card.append(wrap, body);
    return card;
}

function createChannelCard(item) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'channel-card';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'channel-avatar-wrap';
    if (item.thumbnail) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = item.thumbnail;
        avatarWrap.append(img);
    }

    const body = document.createElement('div');
    body.className = 'channel-card-body';

    const name = document.createElement('div');
    name.className = 'channel-card-title';
    name.textContent = item.title || item.channel || 'Unbekannter Kanal';

    const desc = document.createElement('div');
    desc.className = 'channel-card-desc';
    desc.textContent = item.description || 'Kanal öffnen, um die neuesten Videos zu durchsuchen.';

    const cta = document.createElement('div');
    cta.className = 'channel-card-cta';
    cta.textContent = '▶ KANAL-VIDEOS ANZEIGEN';

    body.append(name, desc, cta);
    card.append(avatarWrap, body);

    card.addEventListener('click', () => {
        openChannelView({
            channel_id: item.channel_id,
            title: item.title || item.channel || 'YouTube-Kanal',
            description: item.description || '',
            thumbnail: item.thumbnail || '',
        });
    });

    return card;
}

async function runSearch({ append = false } = {}) {
    const q = queryInput ? queryInput.value.trim() : '';
    if (!q && !activeChannel) return;
    if (append && (!nextPageToken || isFetchingMore)) return;

    const id = append ? searchRequestNo : ++searchRequestNo;
    isFetchingMore = true;

    if (!append) {
        if (btnSearch) btnSearch.disabled = true;
        if (searchResults) searchResults.replaceChildren();
        nextPageToken = '';
        totalLoaded = 0;
        if (searchMessage) {
            searchMessage.className = 'message loading';
            searchMessage.textContent = activeChannel ? 'Kanalvideos werden geladen …' : 'Suche läuft …';
        }
        if (document.getElementById('results-count')) document.getElementById('results-count').textContent = 'LOADING';
        updateFilterUI();
        saveSearchState();
    } else {
        if (scrollLoader) scrollLoader.classList.remove('hidden');
    }

    try {
        const params = new URLSearchParams();
        if (activeChannel) {
            params.set('search_type', 'video');
            params.set('channel_id', activeChannel.channel_id);
            params.set('max_results', '24');
        } else {
            params.set('q', q);
            params.set('search_type', currentSearchType);
            params.set('max_results', '24');
        }
        if (append && nextPageToken) {
            params.set('page_token', nextPageToken);
        }

        const r = await fetch('/api/search?' + params.toString(), {
            headers: { 'Accept': 'application/json' },
        });
        const data = await r.json();
        if (id !== searchRequestNo) return;
        if (!r.ok) {
            if (r.status === 403) throw new Error('Bitte zuerst mit deiner PIN anmelden und erneut suchen.');
            throw new Error(data.error || `Suche fehlgeschlagen (${r.status})`);
        }

        const items = data.results || [];
        nextPageToken = data.next_page_token || '';
        totalLoaded += items.length;

        if (document.getElementById('results-count')) {
            document.getElementById('results-count').textContent = String(totalLoaded).padStart(2, '0') + ' ITEMS';
        }
        if (searchMessage) searchMessage.className = 'message';

        if (!append && !items.length) {
            if (searchMessage) searchMessage.textContent = 'Keine passenden Ergebnisse gefunden.';
            return;
        }

        if (searchMessage) {
            searchMessage.textContent = nextPageToken
                ? `${totalLoaded} Ergebnisse geladen · Scrolle nach unten für mehr`
                : `${totalLoaded} Ergebnisse geladen · Alle Ergebnisse angezeigt`;
        }

        if (searchResults) {
            for (const item of items) {
                if (item.result_type === 'channel') searchResults.append(createChannelCard(item));
                else searchResults.append(createVideoCard(item));
            }
        }
    } catch (err) {
        if (id === searchRequestNo && searchMessage) {
            searchMessage.className = 'message';
            searchMessage.textContent = err.message || 'Die Suche ist fehlgeschlagen.';
            if (document.getElementById('results-count')) document.getElementById('results-count').textContent = 'ERROR';
        }
    } finally {
        if (id === searchRequestNo) {
            if (btnSearch) btnSearch.disabled = false;
            isFetchingMore = false;
            if (scrollLoader) scrollLoader.classList.add('hidden');
        }
    }
}

function openChannelView(channelObj) {
    activeChannel = channelObj;
    updateFilterUI();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    void runSearch({ append: false });
}

// ───────── Custom Transport Controls (Play/Pause & Seek) ─────────
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
    const show = (appState === 'playing' || appState === 'resolving') && canvasVideoMode;
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
    updatePlaybackControlsUI(getCurrentPlaybackSecond());
}

function seekCustomCanvas(targetSeconds) {
    if ((appState !== 'playing' && appState !== 'error') || !canvasVideoMode || !sessionId || mediaIsLive || !(mediaDurationSec > 0)) return;
    clearRecoveryTimers();
    mediaRetryCount = 0;
    appState = 'playing';
    const clamped = Math.max(0, Math.min(mediaDurationSec - 1, Number(targetSeconds) || 0));
    seekBaseSeconds = clamped;
    lastKnownPosition = clamped;
    isPlaybackPaused = false;
    updatePlaybackControlsUI(clamped);
    void startNativeCanvasMedia(sessionId, canvas.width || 640, canvas.height || 360, mediaDurationSec, mediaIsLive, clamped, true);
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

// ───────── Preset & Mode Selection ─────────
presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const p = btn.dataset.preset;
        if (p === selectedPreset) return;
        selectedPreset = p;
        presetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === p));
        if ((appState === 'playing' || appState === 'error') && sessionId) {
            clearRecoveryTimers();
            mediaRetryCount = 0;
            void doPlay(getCurrentPlaybackSecond(), null, true);
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
    if (presetHint && (appState === 'playing' || appState === 'resolving')) {
        presetHint.textContent = 'Änderungen werden beim nächsten PLAY übernommen';
        presetHint.classList.remove('hidden');
    }
}

// ───────── Volume / Mute ─────────
let isMuted = false;

if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
        const volume = parseFloat(volumeSlider.value);
        if (audioGainNode) audioGainNode.gain.value = volume;
        isMuted = volume === 0;
        updateMuteBtn();
    });
}

if (btnMute) {
    btnMute.addEventListener('click', () => {
        isMuted = !isMuted;
        if (audioGainNode) audioGainNode.gain.value = isMuted ? 0 : parseFloat(volumeSlider ? volumeSlider.value : 1);
        updateMuteBtn();
    });
}

function updateMuteBtn() {
    if (btnMute) {
        btnMute.textContent = isMuted ? '🔇' : '🔊';
        btnMute.classList.toggle('muted', isMuted);
    }
}

// ───────── Unsichtbares Web-Audio (Mit Auto-Reconnect) ─────────
function stopCustomWebAudio() {
    if (audioRetryTimer !== null) {
        clearTimeout(audioRetryTimer);
        audioRetryTimer = null;
    }
    if (customAudioReader) {
        try { customAudioReader.cancel(); } catch (_) {}
        customAudioReader = null;
    }
    for (const node of activeAudioNodes) {
        try { node.stop(); node.disconnect(); } catch (_) {}
    }
    activeAudioNodes = [];
    nextAudioTime = 0;
    firstAudioAnchorTime = null;
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.suspend().catch(() => {});
    }
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
    audioGainNode.gain.value = isMuted ? 0 : parseFloat(volumeSlider ? volumeSlider.value : 1);
    if (audioContext.state === 'suspended' && !isPlaybackPaused) {
        await audioContext.resume().catch(() => {});
    }

    let reader = null;
    try {
        const url = `/audio?session=${encodeURIComponent(sid)}&start=${encodeURIComponent(startSec.toFixed(3))}&_=${Date.now()}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok || !res.body) throw new Error(`Audio HTTP ${res.status}`);
        reader = res.body.getReader();
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
                if (firstAudioAnchorTime === null) {
                    firstAudioAnchorTime = nextAudioTime;
                }
                src.start(nextAudioTime);
                nextAudioTime += audioBuffer.duration;
            }).catch(() => {});
        }

        // Falls der Audio-Stream vorzeitig endet, während das Video noch läuft -> Audio neu verbinden!
        if (customAudioReader === reader && appState === 'playing' && sessionId === sid) {
            const curSec = getCurrentPlaybackSecond();
            if (mediaIsLive || !(mediaDurationSec > 0) || curSec < mediaDurationSec - 4) {
                audioRetryTimer = setTimeout(() => {
                    audioRetryTimer = null;
                    if (appState === 'playing' && sessionId === sid) {
                        void startHiddenWebAudio(sid, getCurrentPlaybackSecond());
                    }
                }, 1500);
            }
        }
    } catch (e) {
        console.warn('WebAudio Stream unterbrochen, starte Reconnect:', e);
        if (customAudioReader === reader && appState === 'playing' && sessionId === sid) {
            audioRetryTimer = setTimeout(() => {
                audioRetryTimer = null;
                if (appState === 'playing' && sessionId === sid) {
                    void startHiddenWebAudio(sid, getCurrentPlaybackSecond());
                }
            }, 1500);
        }
    }
}

// ───────── Canvas Setup ─────────
function buildCanvas(cols, rows) {
    gridCols = cols;
    gridRows = rows;
    const syncSize = (el) => {
        if (!playerContainer) return;
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
        if (asciiPlayer) asciiPlayer.style.display = 'none';
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

    if (asciiPlayer && playerContainer) {
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
    }

    ctx.font         = 'bold 8px Courier New';
    ctx.textBaseline = 'top';
    xPos = new Float32Array(cols);
    yPos = new Float32Array(rows);
    for (let c = 0; c < cols; c++) xPos[c] = c * charWidth;
    for (let r = 0; r < rows; r++) yPos[r] = r * charHeight;
}

function buildVideoCanvas(width, height, preserveDimensions = false) {
    canvasVideoMode = true;
    pixelMode = false;
    gridCols = 0;
    gridRows = 0;
    if (!preserveDimensions || !canvas.width || !canvas.height) {
        canvas.width = width;
        canvas.height = height;
    }
    canvas.style.display = 'block';
    canvas.style.imageRendering = 'auto';
    canvas.style.position = 'absolute';
    canvas.style.objectFit = 'contain';
    if (asciiPlayer) {
        asciiPlayer.style.display = 'none';
        asciiPlayer.textContent = '';
    }
    layoutVideoCanvas();
}

function layoutVideoCanvas() {
    if (!canvasVideoMode || !canvas.width || !canvas.height || !playerContainer) return;
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

// ───────── WebCodecs Video Decoder → Visible Canvas ─────────
function stopNativeCanvasSource() {
    const state = webCodecsState;
    webCodecsState = null;
    if (state) {
        state.stopped = true;
        if (state.raf) clearInterval(state.raf);
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
    const entry = trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl &&
        trak.mdia.minf.stbl.stsd && trak.mdia.minf.stbl.stsd.entries &&
        trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry && (entry.avcC || entry.hvcC || entry.vpcC || entry.av1C);
    if (!box || !window.MP4Box || !MP4Box.DataStream) return undefined;
    const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer).slice(8);
}

function pumpSampleQueue(state) {
    if (!state || state.stopped || !state.decoderConfigured || !state.decoder) return;
    if (state.decoder.state !== 'configured') return;

    while (
        state.sampleQueue.length > 0 &&
        (state.frames.length + state.decoder.decodeQueueSize) < 8
    ) {
        const sample = state.sampleQueue.shift();
        if (!sample || !sample.data) continue;

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

    state.raf = setInterval(() => {
        const now = performance.now();
        if (state.stopped || webCodecsState !== state || appState !== 'playing') {
            clearInterval(state.raf);
            return;
        }

        pumpSampleQueue(state);

        if (!isPlaybackPaused && state.frames.length > 0) {
            if (state.playbackStart === null) {
                state.playbackStart = now - (state.frames[0].timestamp / 1000);
            }
            let videoClock = (now - state.playbackStart) / 1000;

            if (audioContext && audioContext.state === 'running' && firstAudioAnchorTime !== null) {
                const audioClock = audioContext.currentTime - firstAudioAnchorTime;
                if (audioClock > 0.5) {
                    const syncDiff = videoClock - audioClock;
                    if (Math.abs(syncDiff) > 0.25 && Math.abs(syncDiff) < 3.0) {
                        state.playbackStart += syncDiff * 50;
                        videoClock = (now - state.playbackStart) / 1000;
                    }
                }
            }

            while (state.frames.length > 1 && (state.frames[1].timestamp / 1e6) <= videoClock + 0.015) {
                const older = state.frames.shift();
                try { older.close(); } catch (_) {}
            }

            if (state.frames.length > 0 && (state.drawn === 0 || (state.frames[0].timestamp / 1e6) <= videoClock + 0.035)) {
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
                    state.totalDrawn++;
                    state.lastPresentedTime = frame.timestamp / 1e6;
                    lastKnownPosition = seekBaseSeconds + state.lastPresentedTime;
                    updatePlaybackControlsUI(lastKnownPosition);

                    // Sobald der Stream wieder stabil 25 Frames gezeichnet hat -> Fehlerzähler zurücksetzen!
                    if (state.totalDrawn >= 25 && mediaRetryCount > 0) {
                        mediaRetryCount = 0;
                        if (statusPerf) statusPerf.classList.add('hidden');
                    }
                } catch (err) {
                    console.warn('WebCodecs canvas paint failed', err);
                } finally {
                    try { frame.close(); } catch (_) {}
                }
                pumpSampleQueue(state);
            }

            if (!state.fpsStart) state.fpsStart = now;
            if (now - state.fpsStart >= 1000) {
                const fps = Math.round((state.drawn * 1000) / Math.max(1, now - state.fpsStart));
                if (statusFps) statusFps.textContent = `FPS ${fps} · ${canvas.width}×${canvas.height} · WebCodecs`;
                state.drawn = 0;
                state.fpsStart = now;
            }
        }
    }, 16);
}

async function startNativeCanvasMedia(sid, fallbackWidth, fallbackHeight, durationSeconds = 0, isLive = false, startSec = 0, isRecovery = false) {
    clearRecoveryTimers();
    canvasVideoMode = true;
    targetFps = 30;
    mediaDurationSec = Number(durationSeconds) || mediaDurationSec || 0;
    mediaIsLive = Boolean(isLive);
    seekBaseSeconds = Number(startSec) || 0;
    lastKnownPosition = seekBaseSeconds;
    isPlaybackPaused = false;

    buildVideoCanvas(fallbackWidth || 640, fallbackHeight || 360, isRecovery);
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window) || !window.MP4Box) {
        setError('Browser unterstützt WebCodecs nicht.');
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
        totalDrawn: 0,
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
    if (!isRecovery) {
        setStatus('BUFFERING · WEBCODECS', 'resolving');
        if (statusPerf) statusPerf.classList.add('hidden');
    }
    updatePlaybackControlsUI(seekBaseSeconds);

    void startHiddenWebAudio(sid, seekBaseSeconds);

    try {
        const mediaUrl = `/media?session=${encodeURIComponent(sid)}&start=${encodeURIComponent(seekBaseSeconds.toFixed(3))}&_=${Date.now()}`;
        const response = await fetch(mediaUrl, { cache: 'no-store' });
        if (!response.ok || !response.body) {
            // Bei 404 ist die Session auf dem Server abgelaufen -> Neue Session anfordern!
            const needNewSession = response.status === 404 || response.status === 409;
            scheduleMediaRecovery(`HTTP ${response.status}`, needNewSession);
            return;
        }

        const mp4File = MP4Box.createFile();
        state.file = mp4File;
        mp4File.onError = (message) => {
            if (!state.stopped) {
                scheduleMediaRecovery(`MP4-Stream (${message})`, false);
            }
        };
        mp4File.onReady = (info) => {
            if (state.stopped || webCodecsState !== state) return;
            const track = (info.videoTracks || [])[0];
            if (!track) {
                scheduleMediaRecovery('Keine Videospur', true);
                return;
            }
            state.track = track;
            state.timescale = track.timescale || 1;
            if (!mediaDurationSec && info.duration && info.timescale) {
                mediaDurationSec = info.duration / info.timescale;
            }
            const description = getMp4VideoDescription(mp4File, track);
            const config = {
                codec: track.codec,
                codedWidth: (track.video && track.video.width) || track.track_width || fallbackWidth || 640,
                codedHeight: (track.video && track.video.height) || track.track_height || fallbackHeight || 360,
            };
            if (description) config.description = description;

            const support = VideoDecoder.isConfigSupported
                ? VideoDecoder.isConfigSupported(config)
                : Promise.resolve({ supported: true, config });

            support.then((result) => {
                if (state.stopped || webCodecsState !== state) return;
                if (!result.supported) {
                    scheduleMediaRecovery(`Codec (${config.codec})`, true);
                    return;
                }

                state.decoder = new VideoDecoder({
                    output(frame) {
                        if (state.stopped || webCodecsState !== state) {
                            try { frame.close(); } catch (_) {}
                            return;
                        }
                        state.frames.push(frame);
                        state.frames.sort((a, b) => a.timestamp - b.timestamp);
                        if (!state.started) {
                            state.started = true;
                            appState = 'playing';
                            setStatus('PLAYING · CANVAS / WEBCODECS', 'playing');
                            if (idleOverlay) idleOverlay.classList.add('hidden');
                            canvas.style.display = 'block';
                            updatePlaybackControlsUI(seekBaseSeconds);
                            startWebCodecsDrawLoop(state);
                        }
                    },
                    error(error) {
                        console.warn('VideoDecoder error, triggering auto-recovery:', error);
                        if (!state.stopped && webCodecsState === state) {
                            scheduleMediaRecovery('Decoder-Resync', false);
                        }
                    },
                });

                state.decoder.configure(result.config || config);
                state.decoderConfigured = true;
                mp4File.setExtractionOptions(track.id, null, { nbSamples: 8 });
                mp4File.start();
                pumpSampleQueue(state);
            }).catch((err) => {
                if (!state.stopped) {
                    scheduleMediaRecovery(`WebCodecs (${err.message || err})`, false);
                }
            });
        };

        mp4File.onSamples = (trackId, user, samples) => {
            if (state.stopped || webCodecsState !== state) return;
            for (const sample of samples) {
                if (!sample || !sample.data || !sample.data.byteLength) continue;
                const copy = new Uint8Array(sample.data.byteLength);
                copy.set(new Uint8Array(sample.data.buffer, sample.data.byteOffset, sample.data.byteLength));
                state.sampleQueue.push({
                    is_sync: Boolean(sample.is_sync),
                    cts: sample.cts,
                    duration: sample.duration,
                    data: copy,
                });
            }
            if (samples.length > 0 && typeof mp4File.releaseUsedSamples === 'function') {
                const lastSample = samples[samples.length - 1];
                try { mp4File.releaseUsedSamples(trackId, lastSample.number); } catch (_) {}
            }
            pumpSampleQueue(state);
        };

        state.reader = response.body.getReader();
        let fileStart = 0;
        while (!state.stopped) {
            while (!state.stopped && state.sampleQueue.length > 90) {
                pumpSampleQueue(state);
                await new Promise(r => setTimeout(r, 35));
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

        if (!state.stopped && webCodecsState === state) {
            // Warte kurz, bis die restlichen gepufferten Samples gezeichnet wurden
            let waitLoops = 0;
            while (!state.stopped && (state.sampleQueue.length > 0 || state.frames.length > 0) && waitLoops < 60) {
                pumpSampleQueue(state);
                await new Promise(r => setTimeout(r, 50));
                waitLoops++;
            }
            if (state.stopped || webCodecsState !== state) return;

            const reachedSec = getCurrentPlaybackSecond();
            const isPrematureDrop = mediaIsLive || !state.started || (mediaDurationSec > 0 && reachedSec < mediaDurationSec - 5);

            if (isPrematureDrop) {
                scheduleMediaRecovery('Stream-Unterbrechung', false);
                return;
            }

            if (state.decoder && state.decoder.state === 'configured') {
                try { await state.decoder.flush(); } catch (_) {}
            }
            setStatus('STREAM ENDE', 'idle');
        }
    } catch (err) {
        if (!state.stopped && webCodecsState === state) {
            scheduleMediaRecovery(`Netzwerk (${err.message || 'Stream'})`, false);
        }
    }
}

// ───────── Control API ─────────
async function doPlay(resumeAtSec = 0, directSelection = null, isRecovery = false) {
    const params = new URLSearchParams(location.search);
    const selection = directSelection || params.get('selection');
    const query = (queryInput && queryInput.value) ? queryInput.value.trim() : '';
    if (!selection && !query) {
        if (queryInput) queryInput.focus();
        return;
    }

    clearRecoveryTimers();
    if (!isRecovery) {
        mediaRetryCount = 0;
        lastKnownPosition = Number(resumeAtSec) || 0;
    }

    if (presetHint) presetHint.classList.add('hidden');
    stopCustomWebAudio();
    stopPoll();
    closeWs();

    if (!isRecovery) {
        clearCanvas();
    } else {
        stopNativeCanvasSource();
    }

    wsRetryCount = 0;
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }

    appState      = 'resolving';
    currentPreset = selectedPreset;
    setUiState('resolving');
    setStatus(isRecovery ? `RECONNECTING (${mediaRetryCount}/${MEDIA_MAX_RETRIES})…` : 'RESOLVING…', 'resolving');
    if (statusTitle && !isRecovery) statusTitle.textContent = selection ? 'ASCILINE' : query;
    if (statusLive && !isRecovery) statusLive.classList.add('hidden');
    if (statusFps && !isRecovery) statusFps.textContent = '';
    if (statusPerf && !isRecovery) statusPerf.classList.add('hidden');

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
        if (appState === 'resolving' || appState === 'playing') {
            scheduleMediaRecovery('Server nicht erreichbar', true);
            return;
        }
        setError('Network error — ' + err.message);
        setUiState('idle');
        return;
    }
    if (!resp.ok) {
        if (isRecovery && mediaRetryCount < MEDIA_MAX_RETRIES) {
            scheduleMediaRecovery(`Server HTTP ${resp.status}`, true);
            return;
        }
        setError(data.error || `Server error ${resp.status}`);
        setUiState('idle');
        return;
    }

    sessionId        = data.session_id;
    appState         = 'playing';
    mediaDurationSec = Number(data.duration) || mediaDurationSec || 0;
    mediaIsLive      = Boolean(data.is_live);
    setUiState('playing');
    updateTitle(data.title, data.is_live);

    if (idleOverlay) idleOverlay.classList.add('hidden');
    if (selectedDisplayMode === 'canvas' || selection) {
        void startNativeCanvasMedia(
            sessionId,
            data.canvas_width,
            data.canvas_height,
            mediaDurationSec,
            mediaIsLive,
            Number(resumeAtSec) || 0,
            isRecovery
        );
    } else {
        connectWs(sessionId);
    }
    startPoll();
}

async function doStop() {
    clearRecoveryTimers();
    mediaRetryCount = 0;
    lastKnownPosition = 0;
    stopCustomWebAudio();
    stopPoll();
    wsRetryCount = 0;
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    try { await fetch('/api/stop', { method: 'POST' }); } catch (_) {}
    closeWs();
    finishPlayback();
    setStatus('IDLE', 'idle');
    if (statusTitle) statusTitle.textContent = '';
    if (statusLive) statusLive.classList.add('hidden');
    if (presetHint) presetHint.classList.add('hidden');
}

function startPoll() {
    stopPoll();
    pollTimer = setInterval(async () => {
        if (appState !== 'playing') { stopPoll(); return; }
        let data;
        try {
            const r = await fetch('/api/status');
            data = await r.json();
        } catch (_) {
            // Kurze Netzunterbrechung beim Status-Poll ignorieren
            return;
        }
        if (data.title) updateTitle(data.title, data.is_live);
        if (data.duration && !mediaDurationSec) {
            mediaDurationSec = Number(data.duration) || 0;
        }
        if (data.state === 'error') {
            // Nicht hart abbrechen, sondern automatisch ab der letzten Sekunde neu verbinden!
            scheduleMediaRecovery(data.error || 'Session-Resync', true);
        }
    }, 3000);
}

function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function setUiState(state) {
    if (btnPlay) btnPlay.disabled = false;
    if (btnStop) btnStop.disabled = !(state === 'resolving' || state === 'playing');
}

function setStatus(label, stateClass) {
    if (statusState) {
        statusState.textContent = label;
        statusState.className   = 'status-segment status-state';
        if (stateClass) statusState.classList.add('state-' + stateClass);
    }
}

function setError(msg) {
    clearRecoveryTimers();
    appState = 'error';
    if (statusTitle) statusTitle.textContent = '⚠ ' + msg;
    setStatus('ERROR', 'error');
    if (statusLive) statusLive.classList.add('hidden');
    if (statusFps) statusFps.textContent = '';
    if (statusPerf) statusPerf.classList.add('hidden');
    setUiState('idle');
    // Falls noch kein einziges Bild gezeichnet wurde, zeige das Idle-Overlay
    if (idleOverlay && (!webCodecsState || !webCodecsState.started)) {
        idleOverlay.classList.remove('hidden');
    }
}

function updateTitle(title, isLive) {
    if (statusTitle && title) statusTitle.textContent = title;
    if (statusLive) statusLive.classList.toggle('hidden', !isLive);
}

function finishPlayback() {
    clearRecoveryTimers();
    stopCustomWebAudio();
    appState          = 'idle';
    readyToRender     = false;
    isPlaybackPaused  = false;
    seekBaseSeconds   = 0;
    lastKnownPosition = 0;
    clearFrameBuffer();
    stopNativeCanvasSource();
    clearCanvas();
    if (idleOverlay) idleOverlay.classList.remove('hidden');
    if (playbackControls) playbackControls.classList.add('hidden');
    setUiState('idle');
    if (statusFps) statusFps.textContent = '';
    if (statusPerf) statusPerf.classList.add('hidden');
    fpsBelowThreshold = false;
}

function clearCanvas() {
    stopNativeCanvasSource();
    canvasVideoMode = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display      = 'none';
    if (asciiPlayer) {
        asciiPlayer.textContent   = '';
        asciiPlayer.style.display = 'none';
    }
}

function closeWs() {
    if (!ws) return;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (_) {}
    ws = null;
}

// ───────── ASCII Fallback Rendering ─────────
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
        if (statusFps) statusFps.textContent = `FPS ${measuredFps}/${Math.round(targetFps)}  JIT ${jitter}ms  BUF ${frameBuffer.length}`;
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
        if (asciiPlayer) {
            asciiPlayer.style.display = 'block';
            asciiPlayer.style.color   = '#fff';
            asciiPlayer.textContent   = frame;
        }
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
    if (asciiPlayer) {
        asciiPlayer.style.display = 'block';
        asciiPlayer.style.color   = 'transparent';
    }
}

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
                if (idleOverlay) idleOverlay.classList.add('hidden');

                void startHiddenWebAudio(sid, 0);
                readyToRender = true;
                lastFpsUpdate = performance.now();
                fpsWindowStart = lastFpsUpdate;
                requestAnimationFrame(renderFrame);
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

const flushSelectionLayer = () => {
    if (!selectionBuffer || appState !== 'playing' || renderMode === 1) return;
    if (asciiPlayer) asciiPlayer.textContent = textDecoder.decode(selectionBuffer);
};
if (asciiPlayer) asciiPlayer.addEventListener('selectstart', flushSelectionLayer);
document.addEventListener('copy', flushSelectionLayer);

if (btnPlay) btnPlay.addEventListener('click', () => { void doPlay(0); });
if (btnStop) btnStop.addEventListener('click', doStop);

window.addEventListener('resize', () => {
    if (canvasVideoMode && appState === 'playing') layoutVideoCanvas();
    else if (gridCols > 0 && appState === 'playing') buildCanvas(gridCols, gridRows);
});

canvas.addEventListener('click', () => {
    // Falls nach 12 Fehlversuchen doch mal in den Error-State gewechselt wurde: Klick setzt sofort fort!
    if (appState === 'error' && canvasVideoMode) {
        mediaRetryCount = 0;
        appState = 'playing';
        void doPlay(getCurrentPlaybackSecond(), null, true);
        return;
    }
    if (appState === 'playing' && canvasVideoMode) {
        if (audioContext && audioContext.state === 'suspended' && !isPlaybackPaused) {
            audioContext.resume().catch(() => {});
            if (statusPerf) statusPerf.classList.add('hidden');
            return;
        }
        void toggleCustomPause();
    }
});

// Wenn das Fahrzeug/Browser die Netzwerkverbindung wiederherstellt, sofort Reconnect anstoßen
window.addEventListener('online', () => {
    if ((appState === 'playing' || appState === 'error') && canvasVideoMode) {
        mediaRetryCount = 0;
        if (mediaRetryTimer !== null) {
            clearTimeout(mediaRetryTimer);
            mediaRetryTimer = null;
        }
        appState = 'playing';
        scheduleMediaRecovery('Netzwerk wieder da', false);
    }
});

// Split-page mode: /watch startet automatisch das ausgewählte Video
if (location.pathname === '/watch') {
    document.body.classList.add('watch-page');
    const params = new URLSearchParams(location.search);
    const selection = params.get('selection');
    if (btnPlay) btnPlay.classList.add('hidden');

    const qs = document.getElementById('btn-search');
    if (qs) qs.classList.add('hidden');
    if (queryInput) { queryInput.value = ''; queryInput.classList.add('hidden'); }

    if (btnStop) {
        btnStop.classList.remove('hidden');
        btnStop.addEventListener('click', () => { location.href = '/'; });
    }
    if (selection) {
        window.setTimeout(() => { void doPlay(0, selection); }, 50);
    } else {
        const arrow = document.getElementById('idle-arrow');
        if (arrow) arrow.textContent = 'Kein Video ausgewählt – bitte zur Suche zurückkehren.';
    }
}
