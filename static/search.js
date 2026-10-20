(() => {
'use strict';
const form = document.getElementById('search-form');
const input = document.getElementById('search-query');
const button = document.getElementById('search-button');
const results = document.getElementById('search-results');
const message = document.getElementById('search-message');
const title = document.getElementById('results-title');
const count = document.getElementById('results-count');
const sentinel = document.getElementById('load-sentinel');
const loadStatus = document.getElementById('load-status');
const tabs = [...document.querySelectorAll('.search-tab')];
let requestNo = 0, query = '', kind = 'video', nextPageToken = '', loading = false, finished = false, totalShown = 0;

function setMessage(text, state='') { message.className = 'message' + (state ? ' ' + state : ''); message.textContent = text; }
function makeCard(item) {
  const isChannel = kind === 'channel';
  const card = document.createElement(isChannel ? 'a' : 'button');
  card.className = 'result' + (isChannel ? ' channel-result' : '');
  if (isChannel) { card.href = 'https://www.youtube.com/channel/' + encodeURIComponent(item.channel_id); card.target = '_blank'; card.rel = 'noopener noreferrer'; }
  else { card.type = 'button'; }
  const wrap = document.createElement('span'); wrap.className = 'thumb-wrap' + (isChannel ? ' channel-thumb' : '');
  const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.src = item.thumbnail || ''; wrap.append(img);
  if (!isChannel) { const mark = document.createElement('span'); mark.className = 'playmark'; mark.textContent = '▶'; wrap.append(mark); }
  const body = document.createElement('span'); body.className = 'result-body';
  const t = document.createElement('span'); t.className = 'result-title'; t.textContent = item.title || (isChannel ? 'Unbekannter Kanal' : 'Unbenanntes Video');
  const ch = document.createElement('span'); ch.className = 'result-channel'; ch.textContent = isChannel ? 'YOUTUBE-KANAL' : (item.channel || 'Unbekannter Kanal');
  body.append(t, ch);
  if (isChannel && item.description) { const desc = document.createElement('span'); desc.className = 'channel-description'; desc.textContent = item.description; body.append(desc); }
  const meta = document.createElement('span'); meta.className = 'result-meta';
  const m1 = document.createElement('span'); m1.textContent = isChannel ? 'CHANNEL' : 'VIDEO';
  const m2 = document.createElement('span'); m2.textContent = isChannel ? 'KANAL ÖFFNEN ↗' : 'ABSPIELEN ↗';
  meta.append(m1,m2); body.append(meta); card.append(wrap,body);
  if (!isChannel) card.addEventListener('click', () => { if (item.selection) location.href = '/watch?selection=' + encodeURIComponent(item.selection); });
  return card;
}
async function loadPage(reset=false) {
  if (loading || (!reset && (finished || !nextPageToken))) return;
  if (reset) { requestNo++; query = input.value.trim(); nextPageToken = ''; finished = false; totalShown = 0; results.replaceChildren(); loadStatus.textContent = ''; }
  if (!query) { setMessage('Bitte gib zuerst einen Suchbegriff ein.'); return; }
  const id = requestNo; loading = true; button.disabled = true; tabs.forEach(t => t.disabled = true);
  if (reset) { setMessage('Suche läuft …', 'loading'); title.textContent = kind === 'channel' ? 'Kanäle' : 'Videos'; count.textContent = 'SUCHE …'; }
  else loadStatus.textContent = 'Weitere Ergebnisse werden geladen …';
  try {
    const params = new URLSearchParams({q:query, search_type:kind, max_results:'24'});
    if (nextPageToken) params.set('page_token', nextPageToken);
    const response = await fetch('/api/search?' + params.toString(), {headers:{Accept:'application/json'}});
    const data = await response.json();
    if (id !== requestNo) return;
    if (!response.ok) throw new Error(data.error || `Suche fehlgeschlagen (${response.status})`);
    const items = data.results || [];
    items.forEach(item => results.append(makeCard(item)));
    totalShown += items.length; nextPageToken = data.next_page_token || ''; finished = !nextPageToken;
    count.textContent = `${totalShown} ${kind === 'channel' ? 'KANÄLE' : 'VIDEOS'}`;
    if (reset) setMessage(items.length ? (kind === 'channel' ? 'Kanäle gefunden. Scrolle nach unten, um automatisch weitere Treffer zu laden.' : 'Videos gefunden. Scrolle nach unten, um automatisch weitere Treffer zu laden.') : 'Keine Treffer gefunden. Versuche einen anderen Suchbegriff.');
    loadStatus.textContent = finished ? 'Alle von YouTube verfügbaren Suchseiten wurden geladen.' : '';
    if (!items.length && !totalShown) finished = true;
  } catch (err) {
    if (id === requestNo) { if (!totalShown) setMessage(err.message || 'Die Suche ist fehlgeschlagen.'); else loadStatus.textContent = 'Nachladen fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') + ' — scrolle erneut, um es nochmals zu versuchen.'; }
  } finally {
    if (id === requestNo) { loading = false; button.disabled = false; tabs.forEach(t => t.disabled = false); }
  }
}
form.addEventListener('submit', e => { e.preventDefault(); loadPage(true); });
tabs.forEach(tab => tab.addEventListener('click', () => { if (kind === tab.dataset.kind) return; kind = tab.dataset.kind; tabs.forEach(t => { const active = t === tab; t.classList.toggle('active', active); t.setAttribute('aria-pressed', String(active)); }); if (input.value.trim()) loadPage(true); else { results.replaceChildren(); count.textContent = 'BEREIT'; title.textContent = kind === 'channel' ? 'Kanäle' : 'Videos'; setMessage('Gib oben einen Suchbegriff ein, um ' + (kind === 'channel' ? 'Kanäle' : 'Videos') + ' zu finden.'); } }));
const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting) && query && !loading && !finished && nextPageToken) loadPage(false); }, {rootMargin:'900px 0px'});
observer.observe(sentinel);
})();
