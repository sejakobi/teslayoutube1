'use strict';
const form=document.getElementById('search-form');
const input=document.getElementById('search-query');
const button=document.getElementById('search-button');
const results=document.getElementById('search-results');
const message=document.getElementById('search-message');
const title=document.getElementById('results-title');
const count=document.getElementById('results-count');
const loadMore=document.getElementById('load-more');
const pageSize=document.getElementById('page-size');
const tabs=[...document.querySelectorAll('.tab')];
let requestNo=0, searchType='video', nextPageToken='', currentQuery='', totalLoaded=0;

function setMessage(text, kind='') { message.className='message'+(kind?' '+kind:''); message.textContent=text; }
function makeCard(item) {
  const card=document.createElement(item.type==='channel'?'a':'button');
  card.className='result'+(item.type==='channel'?' channel-result':'');
  if(item.type==='channel') { card.href=item.url||('https://www.youtube.com/channel/'+encodeURIComponent(item.channel_id||'')); card.target='_blank'; card.rel='noopener noreferrer'; }
  else card.type='button';
  const wrap=document.createElement('span'); wrap.className='thumb-wrap'+(item.type==='channel'?' channel-thumb':'');
  const img=document.createElement('img'); img.loading='lazy'; img.alt=''; img.src=item.thumbnail||''; img.onerror=()=>{img.style.visibility='hidden';}; wrap.append(img);
  const mark=document.createElement('span'); mark.className='playmark'; mark.textContent=item.type==='channel'?'↗':'▶'; wrap.append(mark);
  const body=document.createElement('span'); body.className='result-body';
  const t=document.createElement('span'); t.className='result-title'; t.textContent=item.title||'Unbenannt';
  const ch=document.createElement('span'); ch.className='result-channel'; ch.textContent=item.type==='channel'?'YouTube-Kanal':(item.channel||'Unbekannter Kanal');
  body.append(t,ch);
  if(item.type==='channel'&&item.description){const d=document.createElement('span');d.className='channel-description';d.textContent=item.description;body.append(d);}
  const meta=document.createElement('span');meta.className='result-meta';
  const m1=document.createElement('span');m1.textContent=item.type==='channel'?'KANAL':'VIDEO';
  const m2=document.createElement('span');m2.textContent=item.type==='channel'?'KANAL ÖFFNEN ↗':'ABSPIELEN ↗';meta.append(m1,m2);body.append(meta);card.append(wrap,body);
  if(item.type==='video') card.addEventListener('click',()=>{if(item.selection)location.href='/watch?selection='+encodeURIComponent(item.selection);});
  return card;
}
async function runSearch({append=false}={}) {
  const q=append?currentQuery:input.value.trim(); if(!q)return;
  if(!append){currentQuery=q;nextPageToken='';totalLoaded=0;results.replaceChildren();}
  const id=append?requestNo:++requestNo;
  button.disabled=true;loadMore.disabled=true;loadMore.hidden=true;
  setMessage(append?'Weitere Ergebnisse werden geladen …':'Suche läuft …','loading');
  title.textContent=searchType==='channel'?'Kanäle':'Suchergebnisse';count.textContent='SEARCHING';
  try {
    const params=new URLSearchParams({q,search_type:searchType,max_results:pageSize.value});
    if(append&&nextPageToken)params.set('page_token',nextPageToken);
    const r=await fetch('/api/search?'+params.toString(),{headers:{'Accept':'application/json'}});const data=await r.json();
    if(id!==requestNo)return;if(!r.ok)throw new Error(data.error||`Suche fehlgeschlagen (${r.status})`);
    const items=data.results||[];nextPageToken=data.next_page_token||'';totalLoaded+=items.length;
    for(const item of items)results.append(makeCard(item));
    count.textContent=totalLoaded+' GELADEN';
    if(!totalLoaded){setMessage(searchType==='channel'?'Keine passenden Kanäle gefunden.':'Keine passenden Videos gefunden.');}
    else setMessage(searchType==='channel'?'Kanäle gefunden. Wähle einen Kanal, um ihn auf YouTube zu öffnen.':'Wähle ein Video, um die separate Canvas-Abspielseite zu öffnen.');
    loadMore.hidden=!nextPageToken;loadMore.disabled=false;
  } catch(err){if(id===requestNo){setMessage(err.message||'Die Suche ist fehlgeschlagen.');count.textContent='ERROR';loadMore.hidden=true;}}
  finally{if(id===requestNo){button.disabled=false;loadMore.disabled=false;}}
}
form.addEventListener('submit',e=>{e.preventDefault();runSearch();});
loadMore.addEventListener('click',()=>{if(nextPageToken)runSearch({append:true});});
tabs.forEach(tab=>tab.addEventListener('click',()=>{searchType=tab.dataset.type;tabs.forEach(t=>{const active=t===tab;t.classList.toggle('active',active);t.setAttribute('aria-pressed',String(active));});if(input.value.trim())runSearch();else{title.textContent=searchType==='channel'?'Kanäle':'Entdecken';setMessage(searchType==='channel'?'Suche nach Kanälen, um passende Creator zu finden.':'Gib oben einen Suchbegriff ein, um Videos zu laden.');}}));
pageSize.addEventListener('change',()=>{if(input.value.trim())runSearch();});
