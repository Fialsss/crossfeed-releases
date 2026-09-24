// Pannello Attività: follower, subscriptions, gifts, bit, raid di tutte le piattaforme collegate,
// con i comandi degli avvisi di StreamElements e della pubblicità Twitch, come il suo Activity Feed.
const token = new URLSearchParams(location.search).get('t') || '';
const $ = id => document.getElementById(id);

function post(path, data) {
  return fetch(`${path}?t=${token}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data || {}),
  }).then(r => r.json()).catch(() => ({error: 'service unreachable'}));
}

// tipi di attività: etichetta e colore come le pillole di StreamElements
const TYPES = { // pillole corte come StreamElements; colori predefiniti suoi (si cambiano nei Filtri)
  follow: ['Follow', '#46dc8e'],
  sub: ['Sub', '#f5a524'],
  resub: ['Sub', '#f5a524'],
  gift: ['Gift', '#ff4d5f'],
  community: ['Gift', '#ff4d5f'],
  cheer: ['Bit', '#4dd4ff'],
  raid: ['Raid', '#a970ff'],
  tip: ['Tip', '#ff2fa5'],
  ttgift: ['Gift', '#ff2fa5'],
  share: ['Share', '#8b8f98'],
  redeem: ['Reward', '#00c8af'],
  other: ['Event', '#8b8f98'],
};
// nomi piu' precisi solo nella scheda Filtri (nell'elenco le coppie hanno la stessa pillola, come SE)
const FILTER_LABELS = {follow: 'Follow', sub: 'Subscription', resub: 'Resubscription', gift: 'Gift Sub', community: 'Community Gift Subs',
  cheer: 'Bit (cheer)', raid: 'Raid', tip: 'Donation (tip)', ttgift: 'TikTok Gift', share: 'TikTok Share', redeem: 'Channel Points Reward'};
const PLATFORMS = {twitch: 'Twitch', tiktok: 'TikTok', youtube: 'YouTube', kick: 'Kick'};
// icona e frase per ogni tipo di evento (icone prese da Twitch)
const EVENT_ICON = {follow: 'i-ev-follow', sub: 'i-ev-sub', resub: 'i-ev-sub', gift: 'i-ev-gift', community: 'i-ev-gift',
  cheer: 'i-ev-bits', raid: 'i-ev-raid', tip: 'i-ev-tip', ttgift: 'i-ev-gift', share: 'i-ev-share', redeem: 'i-ev-points', other: 'i-ev-sub'};
const TAGS = {follow: 'FOLLOW', sub: 'SUB', resub: 'RESUB', gift: 'GIFT SUB', community: 'GIFT SUB', cheer: 'BIT', raid: 'RAID',
  tip: 'DONATION', ttgift: 'GIFT', share: 'SHARE', redeem: 'REWARD'};
function sentenceOf(it) {
  const d = it.detail || '';
  switch (it.type) {
    case 'follow': return it.platform === 'tiktok' ? 'New TikTok follower' : 'New follower';
    case 'sub': return `New subscription${d ? ' · ' + d : ''}`;
    case 'resub': return `Resubscription${d ? ' · ' + d : ''}`;
    case 'gift': return `Gifted a sub${d ? ' ' + d : ''}`;
    case 'community': return `Gifted subs to the community${d ? ' · ' + d : ''}`;
    case 'cheer': return `Sent ${d || 'bits'}`;
    case 'raid': return `Raid${d ? ' · ' + d : ''}`;
    case 'tip': return `Donation${d ? ' · ' + d : ''}`;
    case 'ttgift': return `Gift${d ? ' · ' + d : ''}`;
    case 'share': return 'Shared the live stream';
    case 'redeem': return `Redeemed ${d || 'a reward'}`;
    default: return d || 'Event';
  }
}

let config = {seConfigured: false, adLength: 60};
// preferenze del pannello (stesse voci del menù di StreamElements)
let prefs = {avatars: true, readMarkers: false, labels: false, adControls: true, font: 0};
try { prefs = Object.assign(prefs, JSON.parse(localStorage.getItem('fialss-feed-prefs') || '{}')); } catch { /* si riparte */ }
const avatars = new Map(); // login -> url immagine profilo (Twitch)
let items = []; // {key, platform, type, name, detail, time, fresh}
const seen = new Set();
try {
  items = JSON.parse(localStorage.getItem('crossfeed-feed-items') || '[]').filter(it => it && it.key && it.time);
  for (const it of items) { it.fresh = false; seen.add(it.key); }
} catch { items = []; }
let hidden = new Set();
try { hidden = new Set(JSON.parse(localStorage.getItem('fialss-feed-hidden') || '[]')); } catch { /* si riparte */ }
let filters = {types: {}, platforms: {}, min: {}, colors: {}};
try { filters = Object.assign(filters, JSON.parse(localStorage.getItem('fialss-feed-filters') || '{}')); } catch { /* si riparte */ }
const wanted = (group, key) => (filters[group] || {})[key] !== false;
const colorOf = type => (filters.colors || {})[type] || (TYPES[type] || TYPES.other)[1];
// tipi con un valore minimo, come su StreamElements (Min): months, bit, importo, gifts, diamonds
const MINIMUMS = {resub: 'months', cheer: 'bit', tip: 'amount', community: 'gifts', ttgift: 'diamonds'};
function saveFilters() { localStorage.setItem('fialss-feed-filters', JSON.stringify(filters)); }

function ago(time) {
  const s = Math.max(0, (Date.now() - time) / 1000);
  if (s < 60) return 'now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24; if (d < 30) return `${Math.floor(d)}d`;
  const mo = d / 30; if (mo < 12) return `${Math.floor(mo)}mo`;
  return `${Math.floor(d / 365)}y`;
}

window.addItemBase = addItem;
function addItem(item) {
  const key = item.key || `${item.platform}:${item.type}:${(item.name || '').toLowerCase()}:${Math.round(item.time / 60000)}`;
  if (seen.has(key) || hidden.has(key)) return;
  seen.add(key);
  item.key = key;
  if (item.fresh) { item.freshUntil = Date.now() + 8000; setTimeout(render, 8500); }
  items.push(item);
  items.sort((a, b) => b.time - a.time);
  if (items.length > 500) items.length = 500;
  render();
}

// Una sola ridisegnata per fotogramma. Storico, avatar ed eventi arrivano a raffica: ricostruire la lista
// a ogni singolo evento bloccava il pannello e faceva ripartire le animazioni delle righe nuove.
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderNow(); });
}

function renderNow() {
  const list = $('list');
  list.innerHTML = '';
  let shown = 0;
  let markerDone = false;
  for (const it of items) {
    if (!wanted('types', it.type) || !wanted('platforms', it.platform)) continue;
    if (MINIMUMS[it.type] && (it.amount || 0) < (Number((filters.min || {})[it.type]) || 0)) continue;
    shown++;
    if (prefs.readMarkers && it.read && shown > 1 && !markerDone && items.some(x => !x.read)) {
      const marker = document.createElement('li');
      marker.className = 'row is-marker';
      marker.textContent = 'Previously Seen';
      list.append(marker);
      markerDone = true;
    }
    const li = document.createElement('li');
    const fresh = it.freshUntil && it.freshUntil > Date.now();
    li.className = 'row' + (fresh ? ' is-fresh' : '') + (fresh && ['follow', 'sub', 'resub', 'gift', 'community'].includes(it.type) ? ' is-hot' : '');
    const color = colorOf(it.type);
    li.style.setProperty('--row-color', color);
    if (fresh) li.style.setProperty('--since', `-${(Date.now() - (it.freshUntil - 8000)) / 1000}s`);
    // [badge icona del tipo, o avatar con mini-icona] [nome + piattaforma / frase] [New] [tempo]
    const badge = document.createElement('span');
    badge.className = 'badge';
    const url = prefs.avatars && it.platform === 'twitch' ? avatars.get((it.name || '').toLowerCase()) : null;
    if (url) {
      badge.classList.add('has-avatar');
      const img = document.createElement('img');
      img.className = 'avatar';
      img.alt = '';
      img.src = url;
      badge.append(img);
    } else {
      if (prefs.avatars && it.platform === 'twitch') fetchAvatar(it.name);
      badge.innerHTML = `<svg><use href="#${EVENT_ICON[it.type] || 'i-ev-sub'}"/></svg>`;
    }
    const lines = document.createElement('span');
    lines.className = 'lines';
    const whoLine = document.createElement('span');
    whoLine.className = 'who';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name || '';
    // chip della piattaforma con logo e nome, nel suo colore: si vede subito da dove arriva
    const plat = document.createElement('span');
    plat.className = `plat plat--chip ${it.platform}`;
    plat.setAttribute('data-tip', `Event from ${PLATFORMS[it.platform] || it.platform}`);
    plat.innerHTML = `<svg><use href="#i-${it.platform}"/></svg><span>${PLATFORMS[it.platform] || it.platform}</span>`;
    // etichetta del tipo accanto al nome: si capisce al volo se e' sub, follow, gift, bit...
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = TAGS[it.type] || 'EVENT';
    whoLine.append(name, tag); // riga 1: sempre nome + tipo, mai a capo
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = sentenceOf(it);
    // riga 2: chip piattaforma in una cella fissa + frase (che puo' andare a capo): stessa posizione in ogni riga
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.append(sub);
    lines.append(whoLine, meta);
    // logo della piattaforma sempre nello stesso punto: angolo in basso a destra del badge
    plat.className = `corner ${it.platform}`;
    plat.innerHTML = `<svg><use href="#i-${it.platform}"/></svg>`;
    badge.append(plat);
    const slotNew = document.createElement('span');
    slotNew.className = 'slot-new';
    if (it.type === 'follow') {
      const pill = document.createElement('span');
      pill.className = 'pill pill--new';
      pill.textContent = 'New';
      slotNew.append(pill);
    }
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = ago(it.time);
    when.setAttribute('data-tip', new Date(it.time).toLocaleString('en-US'));
    const more = document.createElement('button');
    more.className = 'more';
    more.type = 'button';
    more.setAttribute('data-tip', 'More actions');
    more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
    more.onclick = event => { event.stopPropagation(); openRowMenu(more, it); };
    li.append(badge, lines, slotNew, when, more);
    list.append(li);
  }
  $('empty').hidden = shown > 0;
  saveItems();
}
setInterval(render, 60000);

// La lista resta salvata tra una sessione di OBS e l'altra (gli esempi no).
function saveItems() {
  try {
    const keep = items.filter(it => !String(it.key).startsWith('demo:')).slice(0, 300).map(({freshUntil, ...it}) => it);
    localStorage.setItem('crossfeed-feed-items', JSON.stringify(keep));
  } catch { /* spazio pieno o storage non disponibile: si continua senza salvare */ }
}

// avatar Twitch: si chiede una volta per nome, poi resta in memoria
const avatarPending = new Set();
function fetchAvatar(name) {
  const login = (name || '').toLowerCase();
  if (!login || avatarPending.has(login) || !config.account) return;
  avatarPending.add(login);
  post('/api/user', {login}).then(data => {
    const u = data && data.user && data.user.data && data.user.data[0];
    if (u && u.profile_image_url) { avatars.set(login, u.profile_image_url); render(); }
  });
}
// tutto quello che era in elenco quando si clicca diventa "letto" (segnalibri di lettura)
$('list').addEventListener('click', () => { for (const it of items) it.read = true; render(); });

// ------------------------------------------------------------ sorgenti dal vivo (stesso flusso della chat)
const stream = new EventSource(`/api/events?t=${token}`);
stream.addEventListener('config', event => {
  config = JSON.parse(event.data);
  $('ad-length').value = String(config.adLength || 60);
  for (const b of document.querySelectorAll('[data-se]')) b.classList.toggle('is-off', !config.seConfigured);
  if (config.account) loadHistory();
  // finche' Twitch non ha i permessi nuovi, follower e pubblicita' non arrivano: lo si dice
  const note = config.account && config.account.needsReauth
    ? 'Click “Reconnect” in the chat dock; new permissions are required for followers, ads, and channel point rewards.'
    : !config.account ? "Connect your Twitch account from the chat dock to see followers and ads." : '';
  $('empty').textContent = note || 'No activity yet. Follows, subscriptions, gifts, and raids will appear here.';
});
stream.addEventListener('activity', event => {
  const a = JSON.parse(event.data);
  if (a.type === 'follow')
    addItem({platform: a.platform || 'twitch', type: 'follow', name: a.name || a.login, time: a.time ? Date.parse(a.time) : Date.now(), fresh: true});
  if (a.type === 'redeem') // punti canale (TTS e altri premi): premio, costo e il testo scritto dallo spettatore
    addItem({platform: 'twitch', type: 'redeem', name: a.name || a.login, detail: `${a.reward || 'reward'}${a.cost ? ` (${a.cost})` : ''}${a.input ? ` \u00b7 \u201c${a.input}\u201d` : ''}`,
      amount: Number(a.cost) || 0, time: a.time ? Date.parse(a.time) : Date.now(), fresh: true, key: `redeem:${a.id || Math.random()}`});
});
stream.addEventListener('message-in', event => {
  const m = JSON.parse(event.data);
  const addItem = item => window.addItemBase({...item, src: m});
  const time = m.time || Date.now();
  const level = m.eventPlan === 'Prime' ? 'Prime' : `Tier ${m.eventPlan === '3000' ? 3 : m.eventPlan === '2000' ? 2 : 1}`;
  if (m.platform === 'twitch') {
    if (m.bits) addItem({platform: 'twitch', type: 'cheer', name: m.name, detail: `${m.bits} bit`, amount: m.bits, time, fresh: true, key: `cheer:${m.id}`});
    switch (m.eventId) {
      case 'sub': addItem({platform: 'twitch', type: 'sub', name: m.name, detail: level, time, fresh: true, key: `ev:${m.id}`}); break;
      case 'resub': addItem({platform: 'twitch', type: 'resub', name: m.name, detail: `${level} · ${m.eventMonths || 1} months`, amount: Number(m.eventMonths) || 1, time, fresh: true, key: `ev:${m.id}`}); break;
      case 'subgift': addItem({platform: 'twitch', type: 'gift', name: m.name, detail: `to ${m.eventRecipient || '?'} · ${level}`, time, fresh: true, key: `ev:${m.id}`}); break;
      case 'submysterygift': addItem({platform: 'twitch', type: 'community', name: m.name, detail: `${m.eventCount || 1} × ${level}`, amount: Number(m.eventCount) || 1, time, fresh: true, key: `ev:${m.id}`}); break;
      case 'raid': addItem({platform: 'twitch', type: 'raid', name: m.name, detail: `${m.eventViewers || '?'} viewers`, time, fresh: true, key: `ev:${m.id}`}); break;
    }
  } else if (m.platform === 'tiktok') {
    switch (m.eventId) {
      case 'follow': addItem({platform: 'tiktok', type: 'follow', name: m.name, time, fresh: true, key: `tt:${m.id || Math.random()}`}); break;
      case 'share': addItem({platform: 'tiktok', type: 'share', name: m.name, time, fresh: true, key: `tt:${m.id || Math.random()}`}); break;
      case 'gift': addItem({platform: 'tiktok', type: 'ttgift', name: m.name, detail: `${m.eventText || 'gift'} ×${m.eventCount || 1}${m.eventTotal && m.eventTotal !== '0' ? ` · ${m.eventTotal} diamonds` : ''}`, amount: Number(m.eventTotal) || 0, time, fresh: true, key: `tt:${m.id || Math.random()}`}); break;
    }
  }
});

// ------------------------------------------------------------ cronologia: follower Twitch (Helix) e, se collegato, l'Activity Feed di StreamElements
let historyLoaded = false;
function loadHistory() {
  if (historyLoaded) return;
  historyLoaded = true;
  post('/api/feed-history').then(data => {
    const follows = data.follows && data.follows.data;
    if (Array.isArray(follows))
      for (const f of follows) addItem({platform: 'twitch', type: 'follow', name: f.user_name || f.user_login, time: Date.parse(f.followed_at), key: `follow:${f.user_id}`});
  });
  if (config.seConfigured) {
    post('/api/se', {action: 'history'}).then(data => {
      if (!Array.isArray(data)) return;
      for (const a of data) addItem({...fromStreamElements(a), raw: a});
    });
  }
}
function fromStreamElements(a) {
  const d = a.data || {};
  const name = d.displayName || d.username || d.name || '';
  const provider = (a.provider || 'twitch').toLowerCase();
  const time = Date.parse(a.createdAt) || Date.now();
  const base = {platform: PLATFORMS[provider] ? provider : 'twitch', name, time, key: `se:${a._id}`};
  switch (a.type) {
    case 'follow': return {...base, type: 'follow'};
    case 'subscriber': return {...base, type: d.gifted ? 'gift' : d.amount > 1 ? 'resub' : 'sub', detail: d.gifted ? `from ${d.sender || '?'}` : `${d.tier ? `Tier ${d.tier === 'prime' ? 'Prime' : d.tier / 1000}` : ''}${d.amount > 1 ? ` · ${d.amount} months` : ''}`};
    case 'communityGiftPurchase': return {...base, type: 'community', detail: `${d.amount || 1} gifts`, amount: Number(d.amount) || 1};
    case 'tip': return {...base, type: 'tip', detail: `${d.amount} ${d.currency || ''}`.trim(), amount: Number(d.amount) || 0};
    case 'cheer': return {...base, type: 'cheer', detail: `${d.amount} bit`, amount: Number(d.amount) || 0};
    case 'raid': case 'host': return {...base, type: 'raid', detail: `${d.amount || '?'} viewers`};
    case 'redemption': return {...base, type: 'redeem', detail: d.redemption || d.itemName || ''};
    default: return {...base, type: 'other', detail: a.type};
  }
}

// ------------------------------------------------------------ comandi avvisi (StreamElements) come i pulsanti del suo pannello
const seState = {paused: false, muted: false};
const BELL_ICON = $('act-mute').querySelector('svg').innerHTML; // campanella di StreamElements, per tornare indietro dopo il silenzio
for (const button of document.querySelectorAll('[data-se]')) {
  button.onclick = () => {
  if (!config.seConfigured) { openSettings('The StreamElements token is required for alert controls.'); return; }
    let action = button.dataset.se;
    if (action === 'pause') action = seState.paused ? 'unpause' : 'pause';
    if (action === 'mute') action = seState.muted ? 'unmute' : 'mute';
    post('/api/se', {action}).then(result => {
      if (result.error) return toast(result.error);
      if (action === 'pause' || action === 'unpause') {
        seState.paused = action === 'pause';
        button.classList.toggle('is-active', seState.paused);
        button.querySelector('span').textContent = seState.paused ? 'Resume Alerts' : 'Pause Alerts';
      }
      if (action === 'mute' || action === 'unmute') {
        seState.muted = action === 'mute';
        button.classList.toggle('is-active', seState.muted);
        button.querySelector('span').textContent = seState.muted ? 'Unmute Alerts' : 'Mute Alerts';
        button.querySelector('svg').innerHTML = seState.muted
          ? '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"/><path d="m2 2 20 20"/><path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"/>'
          : BELL_ICON;
      }
      if (action === 'skip') toast('Alert skipped');
      if (action === 'playNext') toast('Playing the next alert');
    });
  };
}

// ------------------------------------------------------------ pubblicità Twitch: conto alla rovescia, avvio, rinvio
let adSchedule = null;
function refreshAds() {
  if (!config.account) return;
  post('/api/ads', {action: 'schedule'}).then(data => {
    adSchedule = data && data.data && data.data[0] ? data.data[0] : null;
    tickAd();
  });
}
function tickAd() {
  const button = $('act-ad');
  let label = '00:00';
  let live = false;
  if (adSchedule && adSchedule.next_ad_at) {
    const next = typeof adSchedule.next_ad_at === 'number' ? adSchedule.next_ad_at * 1000 : Date.parse(adSchedule.next_ad_at);
    const left = Math.max(0, Math.round((next - Date.now()) / 1000));
    if (left > 0) {
      live = true;
      label = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    }
  }
  $('ad-timer').textContent = label;
  $('act-snooze').classList.toggle('is-idle', !(adSchedule && Number(adSchedule.snooze_count) > 0));
  $('act-next').classList.toggle('is-idle', !(config.seConfigured && seState.paused));
  button.classList.toggle('is-live', live);
  button.title = live ? `Next automatic ad in ${label}` : 'No ad scheduled (stream offline?)';
}
setInterval(tickAd, 1000);
setInterval(refreshAds, 30000);
stream.addEventListener('config', () => setTimeout(refreshAds, 500), {once: true});

$('act-ad').onclick = () => {
  const menu = $('ad-menu');
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.innerHTML = '<div class="menu__title">Start Ad</div>';
  for (const seconds of [30, 60, 90, 120, 150, 180]) {
    const item = document.createElement('button');
    item.className = 'item';
    item.textContent = `${seconds} seconds`;
    item.onclick = () => {
      menu.hidden = true;
      post('/api/ads', {action: 'start', length: String(seconds)}).then(result => {
        toast(result.error ? `Ad failed to start: ${result.error}` : `A ${seconds} seconds ad started`);
        refreshAds();
      });
    };
    menu.append(item);
  }
  menu.hidden = false;
};
$('act-snooze').onclick = () => {
  post('/api/ads', {action: 'snooze'}).then(result => {
    if (result.error) return toast(`Replay failed: ${result.error}`);
    const left = result.data && result.data[0] ? result.data[0].snooze_count : null;
    toast(left === null ? 'Ad snoozed' : `Ad snoozed · snoozes left: ${left}`);
    refreshAds();
  });
};

// ------------------------------------------------------------ filtri: scheda scorrevole come quella di StreamElements
function switchButton(on, onChange) {
  const s = document.createElement('button');
  s.type = 'button';
  s.className = 'switch' + (on ? ' is-on' : '');
  s.setAttribute('role', 'switch');
  s.onclick = () => { const next = !s.classList.contains('is-on'); s.classList.toggle('is-on', next); onChange(next); };
  return s;
}
function filterRow(group, key, label, withMin, withColor) {
  const row = document.createElement('div');
  row.className = 'frow';
  row.append(switchButton(wanted(group, key), on => { filters[group][key] = on; saveFilters(); render(); updateClearAll(); }));
  const name = document.createElement('span');
  name.className = 'frow__label';
  name.textContent = label;
  row.append(name);
  if (withMin) {
    const box = document.createElement('label');
    box.className = 'frow__min';
    const small = document.createElement('small');
    small.textContent = 'Min';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.value = String((filters.min || {})[key] || 0);
    input.title = `Minimo (${MINIMUMS[key]})`;
    input.oninput = () => { filters.min = filters.min || {}; filters.min[key] = Number(input.value) || 0; saveFilters(); render(); };
    box.append(small, input);
    row.append(box);
  }
  if (withColor) {
    const color = document.createElement('input');
    color.type = 'color';
    color.value = colorOf(key);
    color.title = 'Color';
    color.oninput = () => { filters.colors = filters.colors || {}; filters.colors[key] = color.value; saveFilters(); render(); };
    row.append(color);
  }
  return row;
}
function buildFilters() {
  const rows = $('filter-rows');
  rows.innerHTML = '';
  for (const [key, [label]] of Object.entries(TYPES)) {
    if (key === 'other') continue;
    rows.append(filterRow('types', key, FILTER_LABELS[key] || label, !!MINIMUMS[key], true));
  }
  const divider = document.createElement('div');
  divider.className = 'frow--divider';
  rows.append(divider);
  for (const [key, label] of Object.entries(PLATFORMS)) rows.append(filterRow('platforms', key, label, false, false));
  updateClearAll();
}
function updateClearAll() {
  const anyOn = Object.keys(TYPES).some(k => k !== 'other' && wanted('types', k));
  $('filter-clear').textContent = anyOn ? 'Clear All' : 'Select All';
}
$('filter-clear').onclick = () => {
  const anyOn = Object.keys(TYPES).some(k => k !== 'other' && wanted('types', k));
  for (const k of Object.keys(TYPES)) if (k !== 'other') filters.types[k] = !anyOn;
  saveFilters();
  buildFilters();
  render();
};
$('filter').onclick = () => { buildFilters(); $('filter-sheet').hidden = false; };
$('filter-back').onclick = () => { $('filter-sheet').hidden = true; };
document.addEventListener('click', event => {
  if (!event.target.closest('#filter, #filter-menu')) $('filter-menu').hidden = true;
  if (!event.target.closest('#act-ad, #ad-menu')) $('ad-menu').hidden = true;
});

// ------------------------------------------------------------ impostazioni
function openSettings(note) {
  $('settings').hidden = false;
  $('settings-note').textContent = note || '';
  $('se-token').value = '';
  $('se-token').placeholder = config.seConfigured ? 'Token saved (paste to replace it; leave blank to keep it)' : 'Paste the JWT here';
}
function applyPrefs() {
  for (const s of document.querySelectorAll('.switch[data-pref]')) s.classList.toggle('is-on', !!prefs[s.dataset.pref]);
  // dimensione delle righe, come nella chat (70-200%); la vecchia scala a 3 scatti diventa 100/110/115%
  if (!prefs.zoom) prefs.zoom = [100, 110, 115][prefs.font] || 100;
  $('pref-font').value = String(prefs.zoom);
  $('pref-font-value').textContent = `${prefs.zoom}%`;
  document.documentElement.style.setProperty('--feed-zoom', String(prefs.zoom / 100));
  document.querySelector('.toolbar').classList.toggle('show-labels', !!prefs.labels);
  document.querySelector('.toolbar').classList.toggle('no-ads', !prefs.adControls);
  localStorage.setItem('fialss-feed-prefs', JSON.stringify(prefs));
  render();
}
for (const s of document.querySelectorAll('.switch[data-pref]'))
  s.onclick = event => { event.preventDefault(); prefs[s.dataset.pref] = !prefs[s.dataset.pref]; applyPrefs(); };
$('pref-font').oninput = () => { prefs.zoom = Number($('pref-font').value) || 100; applyPrefs(); };
$('pref-reload').onclick = () => {
  $('prefs').hidden = true;
  if (!config.seConfigured) return openSettings('The StreamElements token is required to reload overlays.');
  post('/api/se', {action: 'reload'}).then(r => toast(r.error ? r.error : 'Overlays reloaded'));
};
$('pref-se').onclick = () => { $('prefs').hidden = true; openSettings(''); };
// Prova dal vivo: il plugin spedisce eventi finti a tutti i pannelli, uno ogni 1,5 s, sullo stesso flusso di quelli veri.
$('pref-live').onclick = () => {
  $('prefs').hidden = true;
  const steps = [['follow', 'NuovoFollower'], ['sub', 'RiZing_tv'], ['cheer', 'Generoso'], ['ttfollow', 'giulia.live'],
    ['submysterygift', 'Babbo'], ['ttgift', 'marco_tt'], ['resub', 'Luna'], ['raid', 'Amico'], ['ttshare', 'sara.k'], ['subgift', 'mm_miles295']];
  toast('Live test: 10 events incoming; check the chat dock too');
  steps.forEach(([kind, name], i) => setTimeout(() => post('/api/demo', {kind, name}), 800 + i * 1500));
};
// Esempi locali di ogni tipo di riga: non toccano Twitch, TikTok o StreamElements.
$('pref-demo').onclick = () => {
  $('prefs').hidden = true;
  const now = Date.now(), m = 60000, h = 3600000, d = 86400000;
  const rows = [
    {platform: 'twitch', type: 'follow', name: 'fdd_attila71', time: now - 21 * h},
    {platform: 'tiktok', type: 'follow', name: 'giulia.live', time: now - 2 * m},
    {platform: 'twitch', type: 'sub', name: 'RiZing_tv', detail: 'Prime', time: now - 5 * m},
    {platform: 'twitch', type: 'resub', name: 'Luna', detail: 'Tier 1 · 7 months', amount: 7, time: now - 12 * m},
    {platform: 'twitch', type: 'gift', name: 'Babbo', detail: 'a Fortunato · Tier 1', time: now - 30 * m},
    {platform: 'twitch', type: 'community', name: 'mm_miles295', detail: '5 × Tier 1', amount: 5, time: now - 2 * h},
    {platform: 'twitch', type: 'cheer', name: 'Generoso', detail: '100 bit', amount: 100, time: now - 3 * h},
    {platform: 'twitch', type: 'raid', name: 'Amico', detail: '42 viewers', time: now - 26 * h},
    {platform: 'tiktok', type: 'ttgift', name: 'marco_tt', detail: 'Rose ×5 · 5 diamonds', amount: 5, time: now - 40 * m},
    {platform: 'tiktok', type: 'share', name: 'sara.k', time: now - 50 * m},
    {platform: 'twitch', type: 'tip', name: 'Sostenitore', detail: '5 EUR', amount: 5, time: now - 3 * d},
  ];
  rows.forEach((r, i) => addItem({...r, key: `demo:${i}`, fresh: i < 2}));
  toast('Samples shown only in this panel');
};
$('pref-reset').onclick = () => {
  items = [];
  seen.clear();
  historyLoaded = false;
  $('prefs').hidden = true;
  render();
  if (config.account) loadHistory();
  toast('Session reset');
};
$('gear').onclick = event => { event.stopPropagation(); $('prefs').hidden = !$('prefs').hidden; };
$('menu').onclick = () => openSettings('');
document.addEventListener('click', event => { if (!event.target.closest('#gear, #prefs')) $('prefs').hidden = true; });
applyPrefs();
$('settings-close').onclick = () => { $('settings').hidden = true; };
$('se-open').onclick = () => post('/api/open', {url: 'https://streamelements.com/dashboard/account/channels'});
$('settings-save').onclick = () => {
  const typed = $('se-token').value.trim();
  const body = {adLength: $('ad-length').value};
  body.seToken = typed || (config.seConfigured ? '__keep__' : '');
  post('/api/feed-config', body).then(result => {
    if (result.error) return toast(result.error);
    $('settings').hidden = true;
    historyLoaded = false;
  toast('Settings saved');
  });
};

let toastTimer = 0;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 3500);
}


// ------------------------------------------------------------ tooltip a tema: al posto di quelli grigi del sistema
const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
document.body.append(tip);
let tipTimer = 0;
function showTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  tip.textContent = text;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), innerWidth - w - 6);
  let top = r.top - h - 8;
  tip.classList.toggle('tip--below', top < 4);
  if (top < 4) top = r.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTip() { tip.hidden = true; clearTimeout(tipTimer); }
document.addEventListener('mouseover', event => {
  const target = event.target.closest('[title], [data-tip]');
  if (!target) return;
  if (target.hasAttribute('title')) { target.setAttribute('data-tip', target.getAttribute('title')); target.removeAttribute('title'); }
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTip(target), 350);
});
document.addEventListener('mouseout', event => { if (event.target.closest('[data-tip]')) hideTip(); });
document.addEventListener('mousedown', hideTip);
window.addEventListener('scroll', hideTip, true);


// ------------------------------------------------------------ menu della riga: "Replay Alert" e "Hide dal feed" (come StreamElements)
const rowMenu = document.createElement('div');
rowMenu.className = 'rowmenu';
rowMenu.hidden = true;
document.body.append(rowMenu);
function closeRowMenu() { rowMenu.hidden = true; }
function openRowMenu(anchor, item) {
  rowMenu.innerHTML = '';
  const replay = document.createElement('button');
  replay.type = 'button';
  replay.textContent = 'Replay Alert';
  replay.onclick = () => { closeRowMenu(); replayActivity(item); };
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'rowmenu__danger';
  hide.textContent = 'Hide from feed';
  hide.onclick = () => {
    closeRowMenu();
    hidden.add(item.key);
    localStorage.setItem('fialss-feed-hidden', JSON.stringify([...hidden].slice(-500)));
    items = items.filter(x => x.key !== item.key);
    render();
  };
  rowMenu.append(replay, hide);
  rowMenu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = rowMenu.offsetWidth, h = rowMenu.offsetHeight;
  rowMenu.style.left = `${Math.max(6, Math.min(r.right - w, innerWidth - w - 6))}px`;
  rowMenu.style.top = `${r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
}
document.addEventListener('click', event => { if (!event.target.closest('.rowmenu, .more')) closeRowMenu(); });
window.addEventListener('scroll', closeRowMenu, true);

// L'avviso viene rimandato all'overlay di StreamElements come attivita' "mock" (identico al Replay del suo feed).
function replayActivity(item) {
  if (!config.seConfigured) { openSettings('The StreamElements token is required to replay alerts.'); return; }
  // come il Replay di StreamElements: stessa attivita' con isMock e data aggiornata
  const now = new Date().toISOString();
  const activity = item.raw ? {...item.raw, isMock: true, createdAt: now, updatedAt: now} : mockActivity(item);
  if (!activity) return toast('This event cannot be replayed');
  post('/api/se', {action: 'replay', activity: JSON.stringify(activity)}).then(r => toast(r.error ? r.error : 'Alert replayed on the overlay'));
}
function mockActivity(it) {
  const m = it.src || {};
  const user = {username: (it.name || '').toLowerCase(), displayName: it.name || ''};
  const tier = m.eventPlan === 'Prime' ? 'prime' : m.eventPlan || '1000';
  const base = {provider: it.platform === 'tiktok' ? 'tiktok' : 'twitch', isMock: true, createdAt: new Date().toISOString()};
  switch (it.type) {
    case 'follow': return {...base, type: 'follow', data: {...user}};
    case 'sub': case 'resub': return {...base, type: 'subscriber', data: {...user, amount: Number(m.eventMonths) || 1, tier, message: m.text || ''}};
    case 'gift': return {...base, type: 'subscriber', data: {username: (m.eventRecipient || '').toLowerCase(), displayName: m.eventRecipient || '', amount: 1, tier, gifted: true, sender: it.name}};
    case 'community': return {...base, type: 'communityGiftPurchase', data: {...user, amount: Number(m.eventCount) || 1, tier}};
    case 'cheer': return {...base, type: 'cheer', data: {...user, amount: m.bits || it.amount || 0, message: m.text || ''}};
    case 'raid': return {...base, type: 'raid', data: {...user, amount: Number(m.eventViewers) || 0}};
    case 'tip': return {...base, type: 'tip', data: {...user, amount: it.amount || 0, currency: 'EUR'}};
    default: return null;
  }
}
