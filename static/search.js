'use strict';
const form = document.getElementById('search-form'),
      input = document.getElementById('search-query'),
      button = document.getElementById('search-button'),
      results = document.getElementById('search-results'),
      message = document.getElementById('search-message'),
      title = document.getElementById('results-title'),
      count = document.getElementById('results-count');

let requestNo = 0;
let currentQuery = '';
let nextPageToken = '';
let isLoading = false;
let totalCount = 0;

// Hilfsfunktion zum Rendern der Videokarten
function renderItems(items) {
    for (const item of items) {
        const card = document.createElement('button');
        card.className = 'result';
        card.type = 'button';
        
        const wrap = document.createElement('span');
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
        
        const body = document.createElement('span');
        body.className = 'result-body';
        
        const t = document.createElement('span');
        t.className = 'result-title';
        t.textContent = item.title || 'Unbenanntes Video';
        
        const ch = document.createElement('span');
        ch.className='result-channel';
        ch.textContent = item.channel || 'Unbekannter Kanal';
        
        const meta = document.createElement('span');
        meta.className = 'result-meta';
        const m1 = document.createElement('span');
        m1.textContent = 'VIDEO';
        const m2 = document.createElement('span');
        m2.textContent = 'OPEN ↗';
        meta.append(m1, m2);
        
        body.append(t, ch, meta);
        card.append(wrap, body);
        
        card.addEventListener('click', () => {
            if (item.selection) location.href = '/watch?selection=' + encodeURIComponent(item.selection);
        });
        
        results.append(card);
    }
}

async function fetchResults(isLoadMore = false) {
    if (isLoading) return;
    isLoading = true;

    const id = requestNo;
    const q = currentQuery;
    const tokenParam = isLoadMore && nextPageToken ? `&pageToken=${encodeURIComponent(nextPageToken)}` : '';

    if (!isLoadMore) {
        button.disabled = true;
        results.replaceChildren();
        message.className = 'message loading';
        message.textContent = 'Suche läuft …';
        title.textContent = 'Suchergebnisse';
        count.textContent = 'SEARCHING';
        totalCount = 0;
    } else {
        message.className = 'message loading';
        message.textContent = 'Weitere Videos werden geladen …';
    }

    try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}${tokenParam}`, {
            headers: { 'Accept': 'application/json' }
        });
        const data = await r.json();
        
        if (id !== requestNo) return;
        if (!r.ok) throw new Error(data.error || `Suche fehlgeschlagen (${r.status})`);

        const items = data.results || [];
        nextPageToken = data.nextPageToken || '';
        totalCount += items.length;

        count.textContent = String(totalCount).padStart(2, '0') + ' ITEMS';
        message.className = 'message';

        if (!items.length && !isLoadMore) {
            message.textContent = 'Keine passenden Videos gefunden. Versuche einen anderen Suchbegriff.';
            isLoading = false;
            return;
        }

        if (!items.length && isLoadMore) {
            message.textContent = 'Alle Ergebnisse wurden geladen.';
            isLoading = false;
            return;
        }

        renderItems(items);
        message.textContent = nextPageToken ? 'Scrolle nach unten für weitere Ergebnisse.' : 'Alle Ergebnisse geladen.';
    } catch (err) {
        if (id === requestNo) {
            message.className = 'message';
            message.textContent = err.message || 'Die Suche ist fehlgeschlagen.';
            if (!isLoadMore) count.textContent = 'ERROR';
        }
    } finally {
        if (id === requestNo) {
            button.disabled = false;
            isLoading = false;
        }
    }
}

// Formular-Absenden (Neue Suche)
form.addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    
    requestNo++;
    currentQuery = q;
    nextPageToken = '';
    fetchResults(false);
});

// Automatisches Nachladen beim Scrollen (Infinite Scroll über IntersectionObserver)
const sentinel = document.createElement('div');
sentinel.style.height = '20px';
document.body.appendChild(sentinel); // oder an einen passenden Container anhängen

const observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && nextPageToken && !isLoading && currentQuery) {
        fetchResults(true);
    }
}, { rootMargin: '200px' }); // Lädt nach, bevor man ganz unten ist

observer.observe(sentinel);
