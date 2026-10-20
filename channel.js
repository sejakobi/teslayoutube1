(() => {
  'use strict';
  const channelId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const avatar = document.getElementById('channel-avatar');
  const name = document.getElementById('channel-name');
  const stats = document.getElementById('channel-stats');
  const description = document.getElementById('channel-description');
  const youtubeLink = document.getElementById('youtube-channel');
  const videos = document.getElementById('channel-videos');
  const message = document.getElementById('channel-message');
  const loadStatus = document.getElementById('channel-load');
  const subtitle = document.getElementById('video-subtitle');
  const sentinel = document.getElementById('channel-sentinel');
  let nextPageToken = '', loading = false, finished = false, loaded = 0;

  function showMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle('error', isError);
    message.classList.toggle('hidden', !text);
  }
  function formatCount(value) {
    const n = Number(value);
    return Number.isFinite(n) ? new Intl.NumberFormat('de-DE').format(n) : '';
  }
  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'}).format(date);
  }
  function renderVideo(item) {
    const card = document.createElement('a');
    card.className = 'video';
    card.href = item.selection ? '/watch?selection=' + encodeURIComponent(item.selection) : '#';
    if (!item.selection) card.addEventListener('click', e => e.preventDefault());
    const thumb = document.createElement('div'); thumb.className = 'thumb';
    const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.src = item.thumbnail || '';
    thumb.append(img);
    if (item.duration) { const duration = document.createElement('span'); duration.className = 'duration'; duration.textContent = item.duration; thumb.append(duration); }
    const body = document.createElement('div'); body.className = 'vbody';
    const title = document.createElement('div'); title.className = 'vtitle'; title.textContent = item.title || 'Unbekanntes Video';
    const meta = document.createElement('div'); meta.className = 'vmeta';
    const date = document.createElement('span'); date.textContent = formatDate(item.published_at);
    const views = document.createElement('span'); views.textContent = item.view_count ? formatCount(item.view_count) + ' Aufrufe' : '';
    meta.append(date, views); body.append(title, meta); card.append(thumb, body); return card;
  }
  async function loadVideos(reset = false) {
    if (loading || (!reset && (finished || !nextPageToken))) return;
    loading = true;
    loadStatus.textContent = reset ? '' : 'Weitere Videos werden geladen …';
    if (reset) { nextPageToken = ''; finished = false; loaded = 0; videos.replaceChildren(); showMessage('Videos werden geladen …'); }
    try {
      const params = new URLSearchParams({max_results:'24'});
      if (nextPageToken) params.set('page_token', nextPageToken);
      const response = await fetch('/api/channel/' + encodeURIComponent(channelId) + '/videos?' + params, {headers:{Accept:'application/json'}});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Kanalvideos konnten nicht geladen werden.');
      const items = data.results || [];
      items.forEach(item => videos.append(renderVideo(item)));
      loaded += items.length; nextPageToken = data.next_page_token || ''; finished = !nextPageToken;
      showMessage(loaded ? '' : 'Für diesen Kanal wurden keine Videos gefunden.');
      loadStatus.textContent = finished ? (loaded ? 'Alle verfügbaren Videos wurden geladen.' : '') : '';
      subtitle.textContent = loaded ? loaded + ' Videos geladen · neueste Uploads zuerst' : 'Neueste Uploads';
      if (!items.length) finished = true;
    } catch (error) {
      showMessage(error.message || 'Fehler beim Laden der Videos.', true);
      loadStatus.textContent = 'Bitte lade die Seite neu, um es erneut zu versuchen.';
      finished = true;
    } finally { loading = false; }
  }
  async function loadChannel() {
    if (!channelId) { showMessage('Ungültige Kanal-ID.', true); return; }
    try {
      const response = await fetch('/api/channel/' + encodeURIComponent(channelId), {headers:{Accept:'application/json'}});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Kanal konnte nicht geladen werden.');
      document.title = data.title + ' · ASCILINE';
      name.textContent = data.title || 'Unbekannter Kanal';
      avatar.src = data.thumbnail || ''; avatar.alt = 'Profilbild von ' + (data.title || 'Kanal');
      description.textContent = data.description || 'Für diesen Kanal ist keine Beschreibung hinterlegt.';
      youtubeLink.href = data.custom_url ? 'https://www.youtube.com/' + data.custom_url.replace(/^@/, '@') : 'https://www.youtube.com/channel/' + encodeURIComponent(channelId);
      const parts = [];
      if (!data.hidden_subscriber_count && data.subscriber_count) parts.push(formatCount(data.subscriber_count) + ' Abonnenten');
      if (data.video_count) parts.push(formatCount(data.video_count) + ' Videos insgesamt');
      parts.push('Kanal-ID: ' + channelId);
      stats.textContent = parts.join(' · ');
      await loadVideos(true);
    } catch (error) {
      name.textContent = 'Kanal nicht verfügbar';
      showMessage(error.message || 'Kanal konnte nicht geladen werden.', true);
    }
  }
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && !loading && !finished && nextPageToken) loadVideos(false);
  }, {rootMargin:'900px 0px'});
  observer.observe(sentinel);
  loadChannel();
})();
