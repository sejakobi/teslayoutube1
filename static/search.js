'use strict';

const form              = document.getElementById('search-form');
const input             = document.getElementById('search-query');
const button            = document.getElementById('search-button');
const tabVideos         = document.getElementById('tab-videos');
const tabChannels       = document.getElementById('tab-channels');
const results           = document.getElementById('search-results');
const message           = document.getElementById('search-message');
const title             = document.getElementById('results-title');
const count             = document.getElementById('results-count');
const channelBanner     = document.getElementById('channel-banner');
const channelAvatar     = document.getElementById('channel-banner-avatar');
const channelTitle      = document.getElementById('channel-banner-title');
const channelDesc       = document.getElementById('channel-banner-desc');
const btnCloseChannel   = document.getElementById('btn-close-channel');
const scrollSentinel    = document.getElementById('scroll-sentinel');
const scrollLoader      = document.getElementById('scroll-loader');

const STORAGE_KEY = 'asciline_search_state_v1';

let requestNo         = 0;
let currentSearchType = 'video'; // 'video' | 'channel'
let activeChannel     = null;    // { channel_id, title, description, thumbnail }
let nextPageToken     = '';
let isFetchingMore    = false;
let totalLoaded       = 0;

function saveSearchState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      query: input.value.trim(),
      searchType: currentSearchType,
      activeChannel: activeChannel,
    }));
  } catch (_) {}
}

function loadSearchState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function updateFilterUI() {
  const isChanView = Boolean(activeChannel);
  tabVideos.classList.toggle('active', !isChanView && currentSearchType === 'video');
  tabChannels.classList.toggle('active', !isChanView && currentSearchType === 'channel');

  if (isChanView) {
    channelBanner.classList.remove('hidden');
    channelTitle.textContent = activeChannel.title || 'YouTube-Kanal';
    channelDesc.textContent = activeChannel.description || 'Alle öffentlichen Uploads dieses Kanals';
    if (activeChannel.thumbnail) {
      channelAvatar.src = activeChannel.thumbnail;
      channelAvatar.classList.remove('hidden');
    } else {
      channelAvatar.classList.add('hidden');
    }
    title.textContent = `Videos von ${activeChannel.title}`;
  } else {
    channelBanner.classList.add('hidden');
    title.textContent = currentSearchType === 'channel' ? 'Gefundene Kanäle' : 'Suchergebnisse';
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
  const q = input.value.trim();
  if (!q && !activeChannel) return;
  if (append && (!nextPageToken || isFetchingMore)) return;

  const id = append ? requestNo : ++requestNo;
  isFetchingMore = true;

  if (!append) {
    button.disabled = true;
    results.replaceChildren();
    nextPageToken = '';
    totalLoaded = 0;
    message.className = 'message loading';
    message.textContent = activeChannel ? 'Kanalvideos werden geladen …' : 'Suche läuft …';
    count.textContent = 'LOADING';
    updateFilterUI();
    saveSearchState();
  } else {
    scrollLoader.classList.remove('hidden');
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
    if (id !== requestNo) return;
    if (!r.ok) throw new Error(data.error || `Suche fehlgeschlagen (${r.status})`);

    const items = data.results || [];
    nextPageToken = data.next_page_token || '';
    totalLoaded += items.length;

    count.textContent = String(totalLoaded).padStart(2, '0') + ' ITEMS';
    message.className = 'message';

    if (!append && !items.length) {
      message.textContent = 'Keine passenden Ergebnisse gefunden.';
      return;
    }

    message.textContent = nextPageToken
      ? `${totalLoaded} Ergebnisse geladen · Scrolle nach unten für mehr`
      : `${totalLoaded} Ergebnisse geladen · Alle Ergebnisse angezeigt`;

    for (const item of items) {
      if (item.result_type === 'channel') {
        results.append(createChannelCard(item));
      } else {
        results.append(createVideoCard(item));
      }
    }
  } catch (err) {
    if (id === requestNo) {
      message.className = 'message';
      message.textContent = err.message || 'Die Suche ist fehlgeschlagen.';
      count.textContent = 'ERROR';
    }
  } finally {
    if (id === requestNo) {
      button.disabled = false;
      isFetchingMore = false;
      scrollLoader.classList.add('hidden');
    }
  }
}

function openChannelView(channelObj) {
  activeChannel = channelObj;
  updateFilterUI();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  void runSearch({ append: false });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  activeChannel = null;
  void runSearch({ append: false });
});

tabVideos.addEventListener('click', () => {
  if (currentSearchType === 'video' && !activeChannel) return;
  currentSearchType = 'video';
  activeChannel = null;
  updateFilterUI();
  if (input.value.trim()) void runSearch({ append: false });
});

tabChannels.addEventListener('click', () => {
  if (currentSearchType === 'channel' && !activeChannel) return;
  currentSearchType = 'channel';
  activeChannel = null;
  updateFilterUI();
  if (input.value.trim()) void runSearch({ append: false });
});

btnCloseChannel.addEventListener('click', () => {
  activeChannel = null;
  updateFilterUI();
  if (input.value.trim()) void runSearch({ append: false });
});

// Automatischer Infinite-Scroll-Observer
if ('IntersectionObserver' in window && scrollSentinel) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && nextPageToken && !isFetchingMore) {
        void runSearch({ append: true });
      }
    }
  }, { rootMargin: '450px' });
  observer.observe(scrollSentinel);
}

// Letzte Suche beim Öffnen der Seite automatisch wiederherstellen
window.addEventListener('DOMContentLoaded', () => {
  const saved = loadSearchState();
  if (!saved) return;
  if (saved.query) input.value = saved.query;
  if (saved.searchType === 'channel' || saved.searchType === 'video') {
    currentSearchType = saved.searchType;
  }
  if (saved.activeChannel && saved.activeChannel.channel_id) {
    activeChannel = saved.activeChannel;
    updateFilterUI();
    void runSearch({ append: false });
  } else if (saved.query) {
    updateFilterUI();
    void runSearch({ append: false });
  }
});
