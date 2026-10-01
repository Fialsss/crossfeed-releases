// Pannello della chat. Riceve i messaggi dal plugin via SSE e gli rimanda le azioni via POST.
// Il testo degli utenti non viene mai interpretato come HTML.
const token = new URLSearchParams(location.search).get('t') || '';
const $ = id => document.getElementById(id);

let filter = 'all';
let paused = false;
let account = null;

const messages = $('messages');

// La casella è un riquadro modificabile, non un <input>: così può contenere le emote vere,
// animate comprese, come quella di Twitch.
const box = $('text');

function boxText() {
  let out = '';
  for (const node of box.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
    else if (node.tagName === 'IMG') out += ' ' + (node.dataset.name || '') + ' ';
    else if (node.tagName === 'BR') out += ' ';
    else out += node.textContent || '';
  }
  return out.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function boxClear() {
  box.innerHTML = '';
}

function boxEnabled(on) {
  box.contentEditable = on ? 'true' : 'false';
  box.classList.toggle('is-disabled', !on);
  box.dataset.placeholder = on ? 'Send a message' : 'Connect your Twitch account to send messages';
}

function boxInsert(node) {
  box.focus();
  const selection = window.getSelection();
  let range;
  if (selection.rangeCount && box.contains(selection.anchorNode)) {
    range = selection.getRangeAt(0);
    range.deleteContents();
  } else {
    range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
  }
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  box.dispatchEvent(new Event('input'));
}

// Testo che precede il cursore: serve ai suggerimenti di comandi e nomi.
function textBeforeCaret() {
  const selection = window.getSelection();
  if (!selection.rangeCount || !box.contains(selection.anchorNode)) return boxText();
  const range = selection.getRangeAt(0).cloneRange();
  range.setStart(box, 0);
  return range.toString();
}


function atBottom() {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 24;
}

function scrollDown() {
  messages.scrollTop = messages.scrollHeight;
}

// "Chat paused due to scroll" come su Twitch: salendo la chat si ferma, il pulsante la riporta in fondo.
messages.addEventListener('scroll', () => {
  paused = options.pause === 'scroll' && !atBottom();
  $('resume').hidden = !paused;
});
// "Mod Icons: On hover": the tools bar (mod icons + reply) opens outside the hovered line, above it or below it,
// on the side where it covers no text of the neighbouring line; above when both are free or both are busy, below
// when there is no room above (first line at the top). Never over the hovered message, cards included.
const TOOLS_ZONE = {width: 170, height: 36}; // 4 icons + reply button, measured from the right edge (CSS px)
// Chat Size zooms the lines (CSS zoom). Chromium before 128 (CEF 103 in OBS 30, CEF 127 in OBS 31/32) returns the
// rects of zoomed elements divided by the zoom, newer Chromium returns them as drawn: drawn() gives the drawn rect.
const zoomProbe = document.body.appendChild(el('div'));
zoomProbe.style.cssText = 'zoom: 2; width: 10px; position: absolute';
const OLD_ZOOM = zoomProbe.getBoundingClientRect().width === 10;
zoomProbe.remove();
function drawn(r) {
  const k = OLD_ZOOM ? options.zoom / 100 : 1;
  return {left: r.left * k, right: r.right * k, top: r.top * k, bottom: r.bottom * k, width: r.width * k, height: r.height * k};
}
function textRects(node) {
  const rects = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!text.data.trim()) continue;
    range.selectNodeContents(text);
    for (const r of range.getClientRects()) rects.push(drawn(r));
  }
  for (const media of node.querySelectorAll('img, svg')) rects.push(drawn(media.getBoundingClientRect()));
  return rects;
}
function placeTools(line) {
  const anchor = line.querySelector('.reply-button, .mod-icons:not(.is-empty)')?.parentElement;
  if (!anchor || !view.classList.contains('modicons-hover')) return;
  const box = drawn(line.getBoundingClientRect()), at = drawn(anchor.getBoundingClientRect()), list = messages.getBoundingClientRect();
  if (!at.width) return; // riga nascosta (messaggio eliminato in "Brief"): niente barra
  const z = options.zoom / 100, zoneW = TOOLS_ZONE.width * z, zoneH = TOOLS_ZONE.height * z; // tutto in px disegnati
  const left = at.right + 10 * z - zoneW;
  const busy = (neighbour, top, bottom) => !!neighbour && textRects(neighbour).some(r =>
    r.width && r.bottom > top && r.top < bottom && r.right > left);
  const roomAbove = box.top - zoneH >= list.top, roomBelow = box.bottom + zoneH <= list.bottom;
  const freeAbove = roomAbove && !busy(line.previousElementSibling, box.top - zoneH, box.top);
  const freeBelow = roomBelow && !busy(line.nextElementSibling, box.bottom, box.bottom + zoneH);
  const below = !roomAbove || (!freeAbove && freeBelow);
  line.classList.toggle('tools-below', below);
  // the bar hangs from the row that holds it: shift it to the edge of the whole line (card headers stay visible)
  line.style.setProperty('--tools-shift', `${Math.round((below ? box.bottom - at.bottom : at.top - box.top) / z)}px`); // CSS px, dentro lo zoom
}
// Fumetti delle icone (moderazione e Rispondi): uno solo, scuro come la barra, sempre dentro al pannello e dal lato
// opposto al messaggio (sopra se la barra si apre sopra, sotto se si apre sotto). Compare dopo 300 ms, come su Twitch.
const tip = el('div', 'tip');
tip.hidden = true;
document.body.append(tip);
let tipTarget = null, tipTimer = 0;
function hideTip() { clearTimeout(tipTimer); tipTarget = null; tip.hidden = true; }
function showTip(target) {
  tip.textContent = target.getAttribute('aria-label');
  tip.hidden = false;
  const r = drawn(target.getBoundingClientRect()), w = tip.offsetWidth, h = tip.offsetHeight; // il fumetto sta fuori dallo zoom
  const below = view.classList.contains('modicons-hover') && !!target.closest('.tools-below');
  let top = below ? r.bottom + 6 : r.top - h - 6;
  if (top < 4) top = r.bottom + 6;
  else if (top + h > innerHeight - 4) top = r.top - h - 6;
  const left = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), innerWidth - w - 4);
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}
document.addEventListener('mouseover', event => {
  const target = event.target.closest('.mod-icon, .reply-button');
  if (target === tipTarget) return;
  hideTip();
  if (!target) return;
  tipTarget = target;
  tipTimer = setTimeout(() => showTip(target), 300);
});
document.addEventListener('mousedown', hideTip);
messages.addEventListener('scroll', hideTip);
// La barra è della riga con is-tools. Andando verso la barra si passa sopra alla riga vicina: finché il mouse si
// avvicina alla barra, la barra resta dov'è (come i menu a tendina fatti bene); se va altrove, segue la riga nuova
// dopo 80 ms, o dopo 250 ms se il mouse si ferma sulla riga vicina.
let toolsLine = null, toolsNext = null, toolsTimer = 0, toolsDist = Infinity;
function setToolsLine(line) {
  clearTimeout(toolsTimer);
  toolsNext = null;
  toolsDist = Infinity;
  if (line === toolsLine) return;
  toolsLine?.classList.remove('is-tools');
  toolsLine = line;
  if (line) { placeTools(line); line.classList.add('is-tools'); }
}
function barDistance(x, y) {
  const rects = [...toolsLine.querySelectorAll('.mod-icons:not(.is-empty), .reply-button')]
    .map(part => drawn(part.getBoundingClientRect())).filter(r => r.width);
  if (!rects.length) return Infinity;
  const left = Math.min(...rects.map(r => r.left)), right = Math.max(...rects.map(r => r.right));
  const top = Math.min(...rects.map(r => r.top)), bottom = Math.max(...rects.map(r => r.bottom));
  return Math.hypot(Math.max(left - x, 0, x - right), Math.max(top - y, 0, y - bottom));
}
messages.addEventListener('mousemove', event => {
  const line = event.target.closest('#messages > .chat-line');
  if (!toolsLine?.isConnected || !view.classList.contains('modicons-hover')) return setToolsLine(line);
  if (toolsLine.contains(event.target)) return setToolsLine(toolsLine); // sulla sua riga o sulla sua barra
  const dist = barDistance(event.clientX, event.clientY);
  const heading = dist < toolsDist;
  toolsDist = dist;
  if (line === toolsNext && !heading) return; // il cambio è già in corso
  toolsNext = line;
  clearTimeout(toolsTimer);
  toolsTimer = setTimeout(() => setToolsLine(line), heading ? 250 : 80);
});
messages.addEventListener('mouseleave', () => { clearTimeout(toolsTimer); toolsTimer = setTimeout(() => setToolsLine(null), 250); });
$('resume').onclick = () => { paused = false; $('resume').hidden = true; scrollDown(); };

function sourceIcon(platform) {
  const span = document.createElement('span');
  span.className = `chat-line__source ${platform}`;
  span.title = platform === 'twitch' ? 'Twitch' : 'TikTok';
  span.innerHTML = `<svg><use href="#i-${platform}"/></svg>`;
  return span;
}

// pulsante Rispondi che compare passando sopra al messaggio, come su Twitch
function replyButton(m) {
  const reply = el('button', 'reply-button');
  reply.setAttribute('aria-label', 'Click to reply');
  reply.innerHTML = '<svg><use href="#i-reply"/></svg>';
  reply.onclick = event => {
    event.stopPropagation();
    if (m.replyParentId || threads.has(m.id)) openThread(m);
    else startReply(m);
  };
  return reply;
}

function badgeImage(badge) {
  const img = document.createElement('img');
  img.className = 'chat-badge';
  img.src = badge.url;
  // badge di Twitch: come la sua chat, le versioni 2x e 4x per gli schermi ad alta densità
  if (/^https:\/\/static-cdn\.jtvnw\.net\/.*\/1$/.test(badge.url || ''))
    img.srcset = `${badge.url} 1x, ${badge.url.slice(0, -1)}2 2x, ${badge.url.slice(0, -1)}3 4x`;
  img.alt = badge.title || '';
  img.title = badge.title || '';
  return img;
}

// Orario come Twitch: solo ore e minuti nel formato della lingua, senza AM/PM ("23:06", "1:07").
// Cifre latine sempre: con quelle arabe o persiane l'espressione non troverebbe l'ora.
const TIME = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: 'numeric', numberingSystem: 'latn'});
function timeText(time) {
  return (TIME.format(new Date(time || Date.now())).match(/[0-2]?[0-9][:.][0-5][0-9]/) || [''])[0];
}

// "Readable Name Colors" di Twitch (tema scuro): i colori troppo scuri si schiariscono in Lab
// finché il contrasto con lo sfondo arriva a 4.5 (#8A2BE2 -> #b454ff, #0000FF -> #8b58ff).
function readable(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return hex;
  const lin = c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fi = t => t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787;
  const gam = c => (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c) * 255;
  const bg = lum([15, 14, 17]);
  let c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  if (c.every(v => v < 36)) return '#7a7a7a';
  for (let i = 50; i >= 0 && (Math.max(lum(c), bg) + 0.05) / (Math.min(lum(c), bg) + 0.05) < 4.5; i--) {
    const [R, G, B] = c.map(lin);
    const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
    const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
    const L = (116 * y - 16) * 1.1, a = 500 * (x - y), b = 200 * (y - z);
    const Y = (L + 16) / 116, X = fi(a / 500 + Y) * 0.95047, Z = fi(Y - b / 200) * 1.08883, Yl = fi(Y);
    c = [X * 3.2406 + Yl * -1.5372 + Z * -0.4986, X * -0.9689 + Yl * 1.8758 + Z * 0.0415, X * 0.0557 + Yl * -0.2040 + Z * 1.0570]
      .map(v => Math.min(255, Math.max(0, gam(v))));
  }
  return '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// Chi su Twitch non ha scelto un colore ne riceve uno della tavolozza di Twitch. Stessa scelta del plugin
// (somma dei byte del nome), così la riga costruita qui e i messaggi veri della stessa persona coincidono.
const TWITCH_COLORS = ['#ff0000', '#0000ff', '#008000', '#b22222', '#ff7f50', '#9acd32', '#ff4500', '#2e8b57',
                       '#daa520', '#d2691e', '#5f9ea0', '#1e90ff', '#ff69b4', '#8a2be2', '#00ff7f'];
function nameColor(m) {
  if (m.color) return m.color;
  if (m.platform !== 'twitch') return '#efeff1';
  return TWITCH_COLORS[new TextEncoder().encode(m.name || '').reduce((sum, byte) => sum + byte, 0) % 15];
}

function authorSpan(m) {
  const author = document.createElement('span');
  author.className = 'chat-author';
  author.dataset.color = nameColor(m);
  author.style.color = options.readable ? readable(author.dataset.color) : author.dataset.color;
  author.textContent = m.name;
  return author;
}

// Inizio di ogni riga messaggio, sempre gli stessi tre pezzi: orario, icone moderatore (solo quelle che servono;
// con "On hover" stanno nella barra che compare fuori dalla riga), badge + nome.
// Icona della piattaforma su ogni riga (Twitch viola, TikTok bianca): in una chat mista dice da dove arriva.
function linePrefix(m, name) {
  const time = document.createElement('span');
  time.className = 'chat-line__timestamp';
  time.textContent = timeText(m.time);
  const who = document.createElement('span');
  if (!name) who.className = 'chat-line__username-container';
  who.append(sourceIcon(m.platform));
  who.append(...(m.badges || []).map(badgeImage), name || authorSpan(m));
  return [time, modIcons(m), who];
}

// Bits: "Cheer100" diventa il cheermote animato col numero nel colore del livello, come su Twitch.
const CHEER_TIERS = [[10000, '#f43021'], [5000, '#0099fe'], [1000, '#1db2a5'], [100, '#9c3ee8'], [1, '#979797']];
function cheermote(amount, alt) {
  const [tier, color] = CHEER_TIERS.find(([min]) => amount >= min) || CHEER_TIERS.at(-1);
  const wrap = el('span');
  wrap.style.whiteSpace = 'nowrap';
  const img = el('img', 'chat-emote');
  img.src = `https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/${tier}/1.gif`;
  img.alt = alt;
  const strong = el('strong', '', String(amount));
  strong.style.color = color;
  wrap.append(img, strong);
  return wrap;
}
// ponytail: solo il prefisso "Cheer"; gli altri (Corgo100, quelli del canale) vorrebbero la lista Helix
// /bits/cheermotes. Se nel testo non c'è un Cheer, i bits si vedono comunque in fondo al messaggio.
function cheermotes(body, bits) {
  let found = 0;
  for (const node of [...body.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const parts = node.nodeValue.split(/(?<!\S)(cheer[1-9]\d*)(?!\S)/i);
    if (parts.length === 1) continue;
    found += (parts.length - 1) / 2;
    node.replaceWith(...parts.map((part, i) => i % 2 === 0 ? part : cheermote(Number(part.slice(5)), part)));
  }
  if (!found) body.append(' ', cheermote(bits, `Cheer${bits}`));
}

// Link nel testo come su Twitch (link-fragment viola): si aprono nel browser, mai dentro al pannello.
function linkify(body) {
  for (const node of [...body.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const parts = node.nodeValue.split(/((?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,!?;:)\]'])/i);
    if (parts.length === 1) continue;
    node.replaceWith(...parts.map((part, i) => {
      if (i % 2 === 0) return part;
      const link = el('a', 'link-fragment', part);
      link.href = /^https?:/i.test(part) ? part : `https://${part}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        openLink(link.href);
      };
      return link;
    }));
  }
}
// i link di Twitch passano dal plugin (browser predefinito), gli altri da una finestra nuova
function openLink(url) {
  post('/api/open', {url}).then(r => { if (r.error) window.open(url, '_blank', 'noopener'); });
}

// Sostituisce le emote nel testo lavorando per code point, come fa Twitch con i suoi indici.
function messageBody(m) {
  const body = document.createElement('span');
  body.className = 'chat-line__message';
  let points = Array.from(m.text || '');
  let emotes = (m.emotes || []).slice().sort((a, b) => a.start - b.start);
  // nelle risposte Twitch non mostra il "@nome " iniziale che IRC mette nel testo (le emote si spostano con lui)
  const lead = m.replyTo ? Array.from(`@${m.replyTo} `) : [];
  if (lead.length && points.slice(0, lead.length).join('').toLowerCase() === lead.join('').toLowerCase()) {
    points = points.slice(lead.length);
    emotes = emotes.map(e => ({...e, start: e.start - lead.length, end: e.end - lead.length}));
  }
  let position = 0;
  for (const emote of emotes) {
    if (emote.start < position || emote.end >= points.length) continue;
    body.append(document.createTextNode(points.slice(position, emote.start).join('')));
    const img = document.createElement('img');
    img.className = 'chat-emote';
    img.src = emote.url;
    // emote Twitch: 1.0 come src e le versioni 2x/4x nello srcset, come la sua chat
    const size = /^(https:\/\/static-cdn\.jtvnw\.net\/emoticons\/.*\/)[123]\.0$/.exec(emote.url || '');
    if (size) {
      img.src = size[1] + '1.0';
      img.srcset = `${size[1]}1.0 1x, ${size[1]}2.0 2x, ${size[1]}3.0 4x`;
    }
    img.alt = points.slice(emote.start, emote.end + 1).join('');
    img.title = img.alt;
    // riquadro 28x28 come il pulsante-emote di Twitch (sfondo al passaggio, riga barrata se eliminata)
    const button = el('span', 'chat-emote-button');
    button.append(el('span'));
    button.firstChild.append(img);
    body.append(button);
    position = emote.end + 1;
  }
  body.append(document.createTextNode(points.slice(position).join('')));
  if (m.bits) cheermotes(body, m.bits);
  linkify(body);
  boldMentions(body, m);
  return body;
}

// @nome come nella chat di Twitch: chi ti nomina ti mette nella "pillola" bianca,
// nei tuoi messaggi i nomi degli altri stanno nella pillola grigia.
function boldMentions(body, m) {
  const me = ((account && account.login) || $('twitch-channel').value || '').toLowerCase();
  const fromMe = !!me && (m.name || '').toLowerCase() === me;
  for (const node of [...body.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue.includes('@')) continue;
    const parts = node.nodeValue.split(/(@[A-Za-z0-9_]+)/);
    if (parts.length === 1) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (/^@[A-Za-z0-9_]+$/.test(part)) {
        const strong = document.createElement('span');
        strong.className = 'chat-line__mention' + (part.slice(1).toLowerCase() === me ? ' is-me' : fromMe ? ' is-sender' : '');
        strong.textContent = part;
        fragment.append(strong);
      } else if (part) {
        fragment.append(document.createTextNode(part));
      }
    }
    node.replaceWith(fragment);
  }
}

// Icone moderatore davanti al nome, come Twitch: ban (unban se è bannato o in timeout), timeout 10 min, avverti,
// elimina, subito dopo l'orario. Sui propri messaggi solo elimina; niente su chi non si può moderare (l'emittente,
// e i moderatori se non sei l'emittente). Ogni icona ha la sua colonna fissa: quelle che mancano (tutte, su TikTok)
// lasciano il posto vuoto, così i nomi restano in colonna e i cestini in fila.
const bannedUsers = new Set(); // userId bannati o in timeout visti da questo pannello: le loro righe mostrano Unban
function modIcons(m) {
  const wrap = document.createElement('span');
  wrap.className = 'mod-icons';
  let tools = [];
  if (account && m.platform === 'twitch' && m.id !== 'local') {
    const me = (account.login || '').toLowerCase();
    const owner = me === ($('twitch-channel').value || '').trim().toLowerCase();
    const role = (m.badges || []).map(b => `${b.title || ''} ${b.url || ''}`).join(' ');
    const login = (m.login || m.name || '').toLowerCase();
    // senza id (testo di un premio il cui messaggio non è arrivato in chat) su Twitch non c'è niente da eliminare:
    // il cestino toglie la riga solo da questa chat. Lo stesso sui messaggi già eliminati (markDeleted).
    const del = ['delete', 'i-trash', m.id ? 'Delete message' : 'Remove from chat'];
    if (login === me) tools = [del];
    else if (!/broadcaster|streamer/i.test(role) && (owner || !/moderat/i.test(role)))
      tools = [bannedUsers.has(m.userId) ? ['unban', 'i-unban', `Unban ${login}`] : ['ban', 'i-ban', `Ban ${login}`],
               ['timeout', 'i-timeout', `Timeout ${login}`], ['warn', 'i-warn', `Warn ${login}`], del];
  }
  tools = tools.filter(Boolean);
  if (!tools.length) wrap.classList.add('is-empty');
  for (const [action, icon, title] of tools) {
    const button = document.createElement('button');
    button.className = 'mod-icon';
    button.dataset.action = action;
    button.setAttribute('aria-label', title);
    button.innerHTML = `<svg><use href="#${icon}"/></svg>`;
    button.onclick = event => {
      event.stopPropagation();
      const line = button.closest('#messages > .chat-line');
      if (action === 'delete' && (!m.id || line?.classList.contains('is-deleted'))) {
        hideTip();
        line?.remove();
        setToolsLine(null);
        return;
      }
      if (m.demo) {
        hideTip();
        if (action === 'delete' && line) markDeleted(line, `(Deleted by ${account?.login || 'you'})`, 1);
        systemLine(`Sample message: "${title}" was not sent to Twitch.`);
        return;
      }
      noteRecentMod();
      post('/api/moderate', {action, platform: m.platform, id: m.id, userId: m.userId, name: m.name}).then(result => {
        if (result.error) return systemLine(`Action failed: ${result.error}`);
        if (action === 'unban') { bannedUsers.delete(m.userId); refreshModIcons(m.userId); }
      });
    };
    wrap.append(button);
  }
  return wrap;
}
// Dopo un ban/timeout (o un unban dal pannello) le righe di quella persona rifanno le icone: Ban <-> Unban.
function refreshModIcons(userId) {
  if (!userId) return;
  for (const line of messages.querySelectorAll(`.chat-line[data-user-id="${CSS.escape(userId)}"]`)) {
    const m = messageIndex.get(line.dataset.id);
    const icons = line.querySelector('.mod-icons');
    if (!m || !icons) continue;
    const fresh = modIcons(m);
    icons.replaceWith(fresh);
    if (line.classList.contains('is-deleted'))
      for (const trash of fresh.querySelectorAll('[data-action="delete"]')) trash.setAttribute('aria-label', 'Remove from chat');
  }
}

// Frasi degli eventi, parola per parola come la chat di Twitch.
function eventSentence(m) {
  const level = 'Tier ' + (m.eventPlan === '2000' ? '2' : m.eventPlan === '3000' ? '3' : '1');
  const plan = m.eventPlan === 'Prime' ? [' with ', {plan: 'Prime'}] : [' at ' + level];
  const channel = ($('twitch-channel').value || 'this channel').trim();
  const months = parseInt(m.eventMonths || '1', 10) || 1;
  // icona come Twitch: corona Prime, stella animata per Tier 2 e 3, stella semplice per Tier 1
  const star = {Prime: 'i-prime', 2000: 'tier-2', 3000: 'tier-3'}[m.eventPlan] || 'i-star';
  switch (m.eventId) {
    case 'sub':
      return {icon: star, parts: [{b: 'Subscribed'}, ...plan, '.']};
    case 'resub':
      return {icon: star, parts: [{b: 'Subscribed'}, ...plan, ". They've subscribed for ",
        {b: `${months} ${months === 1 ? 'month' : 'months'}`}, '!']};
    case 'subgift': {
      const total = parseInt(m.eventTotal || '0', 10);
      return {icon: 'i-gift', inlineName: true, parts: [`gifted a ${level} Sub to `, {b: m.eventRecipient || 'someone'}, '!',
        total > 1 ? ` They've given ${total} Gift Subs in the channel!` : '']};
    }
    case 'submysterygift': {
      const count = parseInt(m.eventCount || '1', 10) || 1;
      const total = parseInt(m.eventTotal || '0', 10);
      const tail = total > count ? ` They've gifted a total of ${total} in the channel!` : " It's their first Gift Sub in the channel!";
      return {icon: 'mystery', kind: 'is-mystery', parts: [`is gifting ${count} ${level} ${count === 1 ? 'Sub' : 'Subs'} to ${channel}'s community.${tail}`]};
    }
    case 'giftpaidupgrade':
    case 'anongiftpaidupgrade':
      return {icon: 'i-star', parts: ['is continuing the Gift Sub they got!']};
    case 'raid':
      return {icon: 'i-raid', inlineName: true, kind: 'is-raid', parts: ['is raiding with a party of ', {b: m.eventViewers || 'several'}, '.']};
    case 'unraid':
      return {icon: 'i-raid', parts: ['cancelled the raid.']};
    case 'announcement':
      return {icon: 'i-megaphone', title: 'Announcement', parts: []};
    case 'gift': // gift TikTok, con la stessa card del regalo di sub di Twitch
      return {icon: 'i-gift', inlineName: true, parts: ['sent ',{b: `${m.eventCount || 1} × ${m.eventText || 'gift'}`},
        m.eventTotal && m.eventTotal !== '0' ? ` (${m.eventTotal} diamonds)` : '']};
    case 'bitsbadgetier':
      return {icon: 'i-bits', parts: ['unlocked a new Bits badge!']};
    default:
      // evento che non conosciamo: la frase originale di Twitch così com'è
      return {icon: 'i-star', title: '', parts: [m.eventText || m.eventId]};
  }
}

// Icona delle card: glifo dello sprite, la stella animata di Twitch per Tier 2 e 3 (stessa struttura e
// animazione della sua), o l'immagine del regalo misterioso dal CDN di Twitch come i badge.
function eventIcon(name) {
  if (name === 'mystery') return '<img alt="" src="https://static-cdn.jtvnw.net/subs-image-assets/gift-illus.png">';
  const tier = /^tier-([23])$/.exec(name);
  if (!tier) return `<svg><use href="#${name}"/></svg>`;
  const star = `<path d="${document.querySelector('#i-star path').getAttribute('d')}"/>`;
  const swipes = [1, 2, 3].map(n => `<rect class="animated-tier-star__swipe animated-tier-star__swipe--${n}" fill="url(#swipe-gradient)"/>`);
  return `<svg class="animated-tier-star animated-tier-star--tier-${tier[1]}" viewBox="0 0 24 24">` +
    '<defs><linearGradient x1="0%" x2="100%" y1="0%" y2="100%" id="swipe-gradient"><stop offset="0%" stop-color="#9146ff"/>' +
    `<stop offset="100%" stop-color="#d1b3ff"/></linearGradient><clipPath id="star-mask">${star}</clipPath></defs>` +
    `<g class="animated-tier-star__star">${star}</g><g clip-path="url(#star-mask)"><g class="animated-tier-star__swipe-mask">` +
    `<g class="animated-tier-star__swipe-group">${swipes.join('')}</g></g></g></svg>`;
}

function visible(m) {
  return filter === 'all' || m.platform === filter;
}

const chatters = new Map(); // nome -> ultima volta che ha scritto, per i suggerimenti con @

// Like TikTok: arrivano a raffica (TikTok raggruppa i tocchi). Una riga per persona che si aggiorna
// finche' continua a toccare, invece di riempire la chat.
const likeLines = new Map(); // utente -> {line, count, at}
const likeKey = m => m.userId || m.name;
function likeText(count) { // " liked the LIVE ♥ ×12"
  const text = el('span', 'chat-line__event', ' liked the LIVE');
  text.append(svgIcon('i-heart'), count > 1 ? `×${count}` : '');
  return text;
}
function mergeLike(m) {
  const open = likeLines.get(likeKey(m));
  if (!open || !open.line.isConnected || Date.now() - open.at > 60000) return false;
  open.count += parseInt(m.eventCount || '1', 10) || 1;
  open.at = Date.now();
  open.line.querySelector('.chat-line__timestamp').textContent = timeText(m.time);
  open.line.querySelector('.chat-line__event').replaceWith(likeText(open.count));
  return true;
}

function appendParts(text, parts) {
  for (const part of parts) {
    if (typeof part === 'string') { text.append(document.createTextNode(part)); continue; }
    const span = document.createElement(part.plan ? 'span' : 'b');
    if (part.plan) span.className = 'plan';
    span.textContent = part.b || part.plan;
    text.append(span);
  }
}

// Who joins the TikTok LIVE: like the TikTok app, one line at the end of the chat that the next joiner
// rewrites. It stays the last line (new messages go above it) and never becomes a list.
const joinLine = document.createElement('div');
joinLine.className = 'chat-line chat-line--join';
joinLine.dataset.platform = 'tiktok';
let joinTimer = 0, joinLast = 0, joinNext = null;
function showJoin(m) {
  joinNext = m;
  if (joinTimer) return;
  joinTimer = setTimeout(() => {
    joinTimer = 0;
    joinLast = Date.now();
    const next = joinNext;
    joinNext = null;
    if (!next) return;
    // same prefix as a message (time, empty moderator slot, TikTok icon): the name sits in the name column
    joinLine.replaceChildren(...linePrefix({...next, platform: 'tiktok'}, el('b', '', next.name)), ' joined');
    joinLine.hidden = !visible(next);
    joinLine.classList.remove('is-new');
    void joinLine.offsetWidth; // the line fades in again for every new name
    joinLine.classList.add('is-new');
    if (messages.lastElementChild !== joinLine) {
      const stick = !paused && atBottom();
      messages.append(joinLine);
      if (stick) scrollDown();
    }
  }, Math.max(0, 600 - (Date.now() - joinLast))); // at most one change every 600 ms
}
// Every line that is not a chat message (system, moderation, rewards, AutoMod) goes in here: the join line stays last.
function pushLine(line, stick = true) {
  messages.append(line);
  if (joinLine.isConnected) messages.append(joinLine);
  if (stick) scrollDown();
}

// Channel point rewards, as in Twitch chat: "Redeemed TTS (points) 100" above the viewer's message, with a grey
// stripe on the left. Title and cost arrive from EventSub (the "activity" event, the same one the Activity dock
// uses), the viewer's text arrives as a chat message (usually with rewardId, not always). They are paired by
// viewer and text, whichever arrives first, within 30 s. If the message does not come, the block shows the text
// itself; if it comes later, it takes that block's place. A reward without text is a line of its own.
// Past 30 s only a message Twitch marked as a reward (rewardId) with the same text still pairs: never two copies.
const REWARD_WINDOW = 30000;
const rewardWaiting = []; // rewards with text whose chat message has not arrived yet: {event, at, timer, fallback}
const seenRewards = new Set(); // redemption ids already shown: EventSub may deliver the same one twice
const sameText = (event, m) => (event.input || '').trim() === (m.text || '').trim();
function sameReward(event, m) {
  const viewer = (!!event.userId && event.userId === m.userId) ||
    [event.name, event.login].some(n => !!n && n.toLowerCase() === (m.name || '').toLowerCase());
  return viewer && (!!m.rewardId || sameText(event, m));
}
function rewardHeader(event, withName) {
  // as Twitch writes it: "{user} redeemed {reward}" in plain text (the name is not bold), then icon and cost
  const head = el('div', 'reward-line__head', withName ? `${event.name} redeemed ` : 'Redeemed ');
  head.append(event.reward || 'a reward');
  if (event.cost) {
    // icon as Twitch nests it: an inline wrapper with 20px spaces around an inline-flex box resting on the baseline
    const icon = el('span', 'reward-line__icon');
    icon.append(el('span', 'reward-line__icon-box'));
    icon.firstChild.append(svgIcon('i-points'));
    head.append(icon, Number(event.cost).toLocaleString());
  }
  return head;
}
function decorateReward(line, event) {
  const stick = !paused && atBottom();
  line.classList.add('is-reward');
  if (event.reward) line.dataset.reward = event.reward; // paired: no other reward takes this line
  line.querySelector(':scope > .reward-line__head')?.remove(); // the generic "Redeemed a reward" gives way
  // above the message (and its reply row), below the first-message header
  line.insertBefore(rewardHeader(event, false), line.querySelector(':scope > .chat-line__row'));
  if (stick) scrollDown();
}
function rewardLine(event) {
  const line = document.createElement('div');
  line.className = 'chat-line is-reward';
  line.dataset.platform = 'twitch';
  line.dataset.userId = event.userId || '';
  line.dataset.name = event.name || '';
  line.hidden = !visible({platform: 'twitch'});
  if (event.input) {
    // the chat message did not come: the viewer's text under the header, as a chat line
    // (name color and badges from their last message, when this panel has seen one)
    const last = (history.get(userKey('twitch', event.userId, event.name)) || []).at(-1) || {};
    const m = {platform: 'twitch', userId: event.userId, name: event.name || event.login, login: event.login, color: last.color,
               badges: last.badges || [], emotes: [], text: event.input, demo: event.demo};
    const row = el('div', 'chat-line__row');
    row.append(...linePrefix(m), ': ', messageBody(m), replyButton(m));
    line.append(rewardHeader(event, false), row);
    line.querySelector('.chat-author').onclick = click => { click.stopPropagation(); openViewerCard(m); };
  } else {
    line.append(rewardHeader(event, true));
  }
  pushLine(line, !paused && atBottom());
  return line;
}
function onReward(event) {
  if (event.id) {
    if (seenRewards.has(event.id)) return;
    seenRewards.add(event.id);
  }
  if (!event.input) return rewardLine(event); // nothing will come in chat for this one
  // the message came first: the viewer's latest line of the last 30 s with the same text (even without
  // rewardId), otherwise their latest line with a rewardId, so two pending rewards never swap texts.
  // An older line only if Twitch marked it as a reward and the text is the same (EventSub came very late).
  // ponytail: scans the whole list, at most 500 lines
  const lines = [];
  for (let line = messages.lastElementChild; line; line = line.previousElementSibling) {
    if (!line.dataset.at || line.dataset.reward) continue;
    const m = messageIndex.get(line.dataset.id);
    if (!m || !sameReward(event, m)) continue;
    if (Date.now() - line.dataset.at <= REWARD_WINDOW || (m.rewardId && sameText(event, m))) lines.push({line, m});
  }
  const found = lines.find(c => sameText(event, c.m)) || lines[0];
  if (found) return decorateReward(found.line, event);
  // the chat message is on its way: wait for it a few seconds, then show the reward with its text on its own.
  // The wait stays until its message comes (the fallback block is on screen meanwhile), at most the latest 50.
  const wait = {event, at: Date.now(), fallback: null};
  wait.timer = setTimeout(() => { wait.fallback = rewardLine(event); }, 4000);
  rewardWaiting.push(wait);
  if (rewardWaiting.length > 50) rewardWaiting.shift();
}

function addMessage(m) {
  if (m.platform === 'tiktok' && m.eventId === 'join') return showJoin(m);
  if (m.platform === 'tiktok' && (m.eventId === 'follow' || m.eventId === 'share')) return;
  if (m.platform === 'tiktok' && m.eventId === 'like' && mergeLike(m)) return;
  // alla riconnessione TikTok rimanda gli ultimi commenti: gia' mostrati, non si ripetono
  if (m.id && m.id !== 'local' && messageIndex.has(m.id)) return;
  if (m.eventId === 'submysterygift') giftHighlight(m);
  if (m.name) chatters.set(m.name, Date.now());
  if (m.text && m.id !== 'local') remember(history, userKey(m.platform, m.userId, m.name), m, 500);
  if (m.id && m.id !== 'local') {
    messageIndex.set(m.id, m);
    if (messageIndex.size > 3000) messageIndex.delete(messageIndex.keys().next().value);
    const tid = m.replyThreadId || m.replyParentId;
    if (tid) remember(threads, tid, m, 200);
  }
  const line = document.createElement('div');
  line.className = 'chat-line' + (m.action ? ' is-action' : '');
  line.dataset.id = m.id;
  line.dataset.platform = m.platform;
  line.dataset.userId = m.userId || '';
  line.dataset.name = m.name;
  line.hidden = !visible(m);

  // Chat Highlight di Twitch (lo vede chi trasmette): card con bordo rosa o verde acqua e intestazione grigia
  // con l'icona, il titolo e a destra chi la vede (emittente e moderatori)
  if (m.firstMessage || m.returningChatter) {
    line.classList.add(m.firstMessage ? 'hl-first' : 'hl-returning');
    const tag = document.createElement('span');
    tag.className = 'chat-line__tag';
    const who = el('span', 'hl-roles');
    who.append(svgIcon('i-webcam'), svgIcon('i-sword'));
    tag.append(svgIcon(m.firstMessage ? 'i-first' : 'i-returning'),
               el('span', 'hl-label', m.firstMessage ? 'First Time Chat' : 'Returning Chatter'), who);
    line.append(tag);
  }

  if (m.eventId === 'like') {
    // like TikTok: riga fatta come un messaggio (orario, spazio mod, icona, nome) con il cuore e ×N
    line.classList.add('is-like');
    line.append(...linePrefix(m, el('b', '', m.name)), likeText(parseInt(m.eventCount || '1', 10) || 1));
  } else if (m.eventId) {
    // Eventi del canale: subscriptions, gifts, raid, annunci. Stessa struttura di Twitch:
    // icona a sinistra, nome, frase con le parti in grassetto, card grigia con la barra del colore del canale.
    line.classList.add('is-event');
    if (m.eventId === 'announcement')
      line.classList.add('is-announcement', 'color-' + (m.eventColor || 'PRIMARY'));
    if (m.platform === 'tiktok') line.style.setProperty('--channel-primary', '#fe2c55');
    const sentence = eventSentence(m); // {icon, inlineName, kind, title, parts:[testo | {b} | {plan}]}
    if (sentence.kind) line.classList.add(sentence.kind);
    const icon = document.createElement('span');
    icon.className = 'event-icon' + (sentence.icon === 'i-prime' ? ' prime' : '');
    icon.innerHTML = eventIcon(sentence.icon);
    line.append(icon);
    const text = document.createElement('span');
    text.className = 'chat-line__event';
    if (sentence.inlineName) {
      line.classList.add('is-inline');
      const who = document.createElement('b');
      who.textContent = m.name + ' ';
      text.append(who);
    } else if (sentence.title !== '') {
      const who = document.createElement('span');
      who.className = 'event-name';
      who.textContent = sentence.title || m.name;
      line.append(who);
    }
    appendParts(text, sentence.parts);
    if (sentence.parts.length) line.append(text);
    if (m.text) {
      // il messaggio dentro la card (annuncio, resub) è una riga di chat completa: orario, badge, nome, testo,
      // riquadro al passaggio e pulsante Rispondi
      const body = document.createElement('div');
      body.className = 'event-body';
      body.append(...linePrefix(m), ': ', messageBody(m));
      if (m.platform === 'twitch' && m.id) body.append(replyButton(m));
      line.append(body);
    }
  } else {
    line.classList.add('is-message');
    // la parte "messaggio" (risposta, orario, nome, testo) sta in un blocco suo: riquadro al passaggio e pulsante
    // Rispondi coprono solo lei, non l'intestazione del premio o della Chat Highlight, come su Twitch
    const row = el('div', 'chat-line__row');
    if (m.replyTo) {
      // come la ReplyLine di Twitch: "Rispondendo a @nome: testo", @nome evidenziato se sono io
      const reply = document.createElement('div');
      reply.className = 'chat-line__reply';
      reply.innerHTML = '<svg><use href="#i-replyline"/></svg>';
      const text = document.createElement('span');
      text.title = m.replyText || '';
      const who = document.createElement('span');
      who.textContent = `@${m.replyTo}`;
      const me = ((account && account.login) || $('twitch-channel').value || '').toLowerCase();
      if (me && m.replyTo.toLowerCase() === me) who.className = 'reply-line--mentioned';
      text.append('Replying to ', who, `: ${m.replyText || ''}`);
      reply.append(text);
      reply.onclick = event => { event.stopPropagation(); if (account) openThread(m); };
      row.append(reply);
    }
    row.append(...linePrefix(m), m.action ? ' ' : ': ', messageBody(m));
    if (m.platform === 'twitch' && m.id && m.id !== 'local') row.append(replyButton(m));
    line.append(row);
  }

  // clic sul nome: scheda utente come su Twitch
  for (const author of line.querySelectorAll('.chat-author'))
    author.onclick = event => { event.stopPropagation(); openViewerCard(m); };

  if (m.platform === 'twitch' && !m.eventId && m.id && m.id !== 'local') {
    line.dataset.at = Date.now(); // a reward arriving later looks for its message among the last 30 s
    // a reward waiting for this message (same viewer, same text): its header goes on this line,
    // and the block shown in the meantime goes away, so there are never two copies
    const pairs = w => sameReward(w.event, m) && (Date.now() - w.at <= REWARD_WINDOW || (m.rewardId && sameText(w.event, m)));
    const wait = rewardWaiting.find(w => pairs(w) && sameText(w.event, m)) || rewardWaiting.find(pairs);
    if (wait) {
      rewardWaiting.splice(rewardWaiting.indexOf(wait), 1);
      clearTimeout(wait.timer);
      if (wait.fallback) wait.fallback.remove();
      decorateReward(line, wait.event);
    } else if (m.rewardId) {
      // no title from Twitch (for example without the rewards permission): still say it is a reward
      setTimeout(() => { if (!line.dataset.reward) decorateReward(line, {}); }, 6000);
    }
  }
  const stick = !paused && atBottom();
  messages.append(line);
  if (joinLine.isConnected) messages.append(joinLine); // the join line stays last
  if (m.platform === 'tiktok' && m.eventId === 'like')
    likeLines.set(likeKey(m), {line, count: parseInt(m.eventCount || '1', 10) || 1, at: Date.now()});
  while (messages.childElementCount > 500) messages.firstElementChild.remove();
  if (stick) scrollDown();
}

function applyFilter(next) {
  filter = next;
  for (const button of document.querySelectorAll('.filter'))
    button.classList.toggle('is-active', button.dataset.filter === next);
  for (const line of messages.children) line.hidden = line.dataset.platform !== next && next !== 'all';
  renderStack(); // la pila in cima è tutta Twitch
  scrollDown();
}

window.post = post;
function post(path, data) {
  return fetch(`${path}?t=${token}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data),
  }).then(r => r.json()).catch(() => ({error: 'service unreachable'}));
}

// Inserisce l'emote scelta dal selettore dentro la casella, come immagine vera.
window.insertEmote = emote => {
  const img = document.createElement('img');
  img.src = emote.url;
  img.alt = emote.name;
  img.title = emote.name;
  img.dataset.name = emote.name;
  boxInsert(img);
  boxInsert(document.createTextNode(' '));
};

function setAccount(state) {
  account = state && state.login ? state : null;
  const ready = !!account;
  boxEnabled(ready);
  $('send').disabled = !ready;
  const needsReauth = ready && account.needsReauth;
  $('reauth').hidden = !needsReauth;
  $('account-state').textContent = !ready
    ? 'Twitch account not connected. Connect it to chat and moderate.'
    : needsReauth
      ? `Connected as ${account.login}, but permissions are outdated. Reconnect for emotes and moderation.`
      : `Connected as ${account.login}: you can chat and moderate.`;
  applyOptions(); // senza account non si modera: lo spazio delle icone sparisce
}

// eventi dal plugin
// Setup Wizard: strato a tutta altezza dentro il pannello (niente finestre separate).
function openSetup() {
  const frame = $('setup-frame');
  if (!frame.src) frame.src = `setup.html?t=${token}`;
  frame.hidden = false;
}
function closeSetup() { $('setup-frame').hidden = true; }
window.addEventListener('message', event => {
  if (event.data === 'crossfeed-setup-done') closeSetup();
});

const stream = new EventSource(`/api/events?t=${token}`);
stream.addEventListener('message-in', event => addMessage(JSON.parse(event.data)));
// spettatori per piattaforma ({twitch, tiktok}, null = non collegato), per i contatori dello stile Multistream
function setCounts(counts) {
  for (const platform of ['twitch', 'tiktok']) {
    const value = counts[platform];
    const count = document.querySelector(`.count.${platform}`);
    count.classList.toggle('is-off', value == null);
    count.querySelector('b').textContent = value == null ? '–' : Number(value).toLocaleString();
  }
}
stream.addEventListener('viewers', event => setCounts(JSON.parse(event.data)));
stream.addEventListener('activity', event => {
  const a = JSON.parse(event.data);
  if (a.type === 'redeem') onReward(a);
});
let welcomed = false;
stream.addEventListener('status', event => {
  const status = JSON.parse(event.data);
  const twitch = status.twitch || {};
  if (!welcomed && twitch.state === 'connected') {
    welcomed = true;
    const channel = ($('twitch-channel').value || '').trim();
    const line = document.createElement('div');
    line.className = 'chat-line is-system';
    const body = document.createElement('span');
    body.className = 'chat-line__message';
    body.textContent = `Welcome to ${channel || 'this channel'}'s chat room!`;
    line.append(body);
    pushLine(line);
  }
  $('dots').innerHTML = '';
  for (const platform of ['twitch', 'tiktok']) {
    const dot = document.createElement('i');
    dot.dataset.state = (status[platform] || {}).state || 'disabled';
    dot.title = `${platform === 'twitch' ? 'Twitch' : 'TikTok'}: ${(status[platform] || {}).detail || ''}`;
    $('dots').append(dot);
  }
});
stream.addEventListener('config', event => {
  const config = JSON.parse(event.data);
  $('twitch-channel').value = config.twitch || '';
  $('tiktok-channel').value = config.tiktok || '';
  $('client-id').value = config.clientId || '';
  // Con il Client ID incassato nella build resta solo il pulsante, come nei plugin commerciali.
  $('client-id-row').hidden = !!config.builtInClient;
  setAccount(config.account);
  preloadChatters();
});
// Messaggio trattenuto da AutoMod: si mostra con Consenti / Rifiuta, come nella chat dei moderatori.
stream.addEventListener('held', event => {
  const held = JSON.parse(event.data);
  const existing = messages.querySelector(`.chat-line.is-held[data-held-id="${CSS.escape(held.id)}"]`);
  if (held.resolved) {
    if (existing) {
      existing.classList.add('is-resolved');
      const tag = existing.querySelector('.chat-line__tag');
      if (tag) tag.textContent = held.approved ? 'Message Approved' : 'Message Denied';
      for (const button of existing.querySelectorAll('button')) button.disabled = true;
    }
    return;
  }
  if (existing) return;
  const line = document.createElement('div');
  line.className = 'chat-line is-held';
  line.dataset.heldId = held.id;
  line.dataset.reason = held.reason || 'automod';
  line.dataset.standard = held.category ? 'no' : 'yes';
  const tag = document.createElement('span');
  tag.className = 'chat-line__tag';
  tag.textContent = held.reason === 'blocked_term' ? 'Held: Blocked Channel Term'
    : held.category ? `Held by AutoMod: ${held.category}` : 'Held by AutoMod';
  const author = document.createElement('span');
  author.className = 'chat-author';
  author.textContent = held.name || 'user';
  const body = document.createElement('span');
  body.className = 'chat-line__message';
  body.textContent = held.text || '';
  const actions = document.createElement('div');
  actions.className = 'held-actions';
  for (const [label, action, cls] of [['Allow', 'allow', 'allow'], ['Deny', 'deny', 'deny']]) {
    const button = document.createElement('button');
    button.className = cls;
    button.textContent = label;
    button.onclick = () => {
      for (const b of actions.querySelectorAll('button')) b.disabled = true;
      post('/api/automod', {id: held.id, action}).then(result => {
        if (result.error) {
          tag.textContent = `Action failed: ${result.error}`;
          for (const b of actions.querySelectorAll('button')) b.disabled = false;
        }
      });
    };
    actions.append(button);
  }
  line.append(tag, author, document.createTextNode(': '), body, actions);
  // clic sul nome: scheda utente come su Twitch
  author.onclick = event => {
    event.stopPropagation();
    openViewerCard({platform: 'twitch', userId: held.userId, name: held.name, badges: []});
  };

  pushLine(line, !paused && atBottom());
});
stream.addEventListener('automod', event => {
  const info = JSON.parse(event.data);
  const state = $('automod-state');
  if (state) state.textContent = info.detail || '';
});

// Chi ha fatto l'ultima azione dal pannello: Twitch IRC non dice il moderatore, ma se sono stato io lo so.
let recentMod = {at: 0, login: ''};
function noteRecentMod() { if (account) recentMod = {at: Date.now(), login: account.login}; }

// Nota di Twitch accanto al messaggio eliminato (le sue stringhe).
function deletedNote(data) {
  const mod = Date.now() - recentMod.at < 8000 ? recentMod.login : '';
  if (!mod) return '(Deleted)';
  if (data.id) return `(Deleted by ${mod})`;
  if (data.duration) return `(${data.duration}s Timeout by ${mod})`;
  return `(Banned by ${mod})`;
}

// Segna la riga come eliminata come fa Twitch, secondo "Deleted Messages": "Detailed" = messaggio in alt-2
// barrato con la nota, "Legacy" = "<message deleted>" cliccabile, "Brief" = al posto della riga
// "N messages were deleted by a moderator.", solo sull'ultima riga eliminata da quell'azione (count).
function markDeleted(line, note, count) {
  line.classList.add('is-deleted');
  for (const trash of line.querySelectorAll('.mod-icon[data-action="delete"]')) trash.setAttribute('aria-label', 'Remove from chat');
  if (count) {
    line.classList.add('deleted-last');
    line.append(el('span', 'deleted-status', `${count} ${count === 1 ? 'message was' : 'messages were'} deleted by a moderator.`));
  }
  if (line.querySelector('.deleted-note')) return;
  const body = line.querySelector('.chat-line__message');
  if (!body) return;
  const brief = document.createElement('span');
  brief.className = 'deleted-brief';
  brief.textContent = '<message deleted>';
  brief.onclick = () => line.classList.add('show-deleted');
  const span = document.createElement('span');
  span.className = 'deleted-note';
  span.textContent = note;
  body.after(brief, span);
}

stream.addEventListener('clear', event => {
  const data = JSON.parse(event.data);
  let name = data.name || '';
  const note = deletedNote(data);
  let logged = false;
  const hit = [...messages.children].filter(line => line.dataset.platform === data.platform &&
    ((data.id && line.dataset.id === data.id) || (data.userId && line.dataset.userId === data.userId) ||
     (!data.id && !data.userId && line.classList.contains('is-message'))));
  // "Brief" conta solo le righe che questa azione elimina: quelle già eliminate restano come sono, come su Twitch
  const fresh = hit.filter(line => !line.classList.contains('is-deleted'));
  if (data.userId && !data.id) { bannedUsers.add(data.userId); refreshModIcons(data.userId); }
  for (const line of hit) {
    if (fresh.includes(line)) markDeleted(line, note, line === fresh.at(-1) ? fresh.length : 0);
    if (line.dataset.name) name = line.dataset.name; // nome con le maiuscole giuste
    if (!logged) {
      logged = true;
      remember(modLog, userKey('twitch', line.dataset.userId, line.dataset.name), {
        type: data.id ? 'delete' : data.duration ? 'timeout' : 'ban',
        duration: Number(data.duration) || 0, time: Date.now(),
        mod: Date.now() - recentMod.at < 8000 ? recentMod.login : '',
      }, 200);
    }
  }
  if (!data.id && !data.userId) {
    const status = document.createElement('div');
    status.className = 'chat-line chat-line__status';
    status.textContent = 'Chat was cleared by a moderator';
    pushLine(status);
  }
  if (account && options.modactions) modActionNotice(data, name);
});

// "Show moderation actions": la riga che Twitch mostra ai moderatori dopo un timeout, ban o eliminazione.
function modActionNotice(data, name) {
  const who = document.createElement('b');
  who.textContent = name;
  const line = document.createElement('div');
  line.className = 'chat-line is-system is-modaction';
  const body = document.createElement('span');
  body.className = 'chat-line__message';
  const mod = Date.now() - recentMod.at < 8000 ? recentMod.login : '';
  if (data.id) body.append('A message from ', who, ' was deleted.');
  else if (!data.userId) {
    if (!mod) return; // Twitch la attribuisce a chi l'ha fatto; senza nome basta la riga di stato
    body.append(el('b', '', mod), ' cleared this channel’s chat for non-moderators.');
  }
  else if (data.duration) body.append(...(mod ? [`${mod} timed out `, who, ` for ${data.duration} seconds.`]
    : [who, ` has been timed out for ${data.duration} seconds.`]));
  else body.append(...(mod ? [`${mod} banned `, who, '.'] : [who, ' is now banned from this channel.']));
  line.append(body);
  pushLine(line);
}

function durationText(seconds) {
  if (seconds % 86400 === 0) return seconds === 86400 ? '1 day' : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? '1 hour' : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? '1 minute' : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

// scrittura
// /demo: mostra esempi di ogni notifica SOLO in questo pannello. Non manda nulla a Twitch.
function showDemo() {
  applyOptions(); // le icone moderatore seguono l'account
  // contatori finti: li manda il plugin, che dopo 10 s rimette i numeri veri (senza plugin, solo qui)
  post('/api/demo', {kind: 'viewers'}).then(result => { if (!result || result.error) setCounts({twitch: 35, tiktok: 14}); });
  const now = Date.now();
  const me = ($('twitch-channel').value || 'fialss_').trim();
  // i badge globali veri di Twitch, dal suo CDN come quelli che arrivano da Helix
  const badge = id => `https://static-cdn.jtvnw.net/badges/v1/${id}/1`;
  const BADGE = {vip: {url: badge('b817aba4-fad8-49e2-b88a-7cc744dfa6ec'), title: 'VIP'},
                 sub: {url: badge('5d9f2208-5dd8-11e7-8513-2ff4adfae661'), title: 'Subscriber'},
                 streamer: {url: badge('5527c58c-fb7d-422d-b71b-f309dcb85cc1'), title: 'Broadcaster'}};
  const rows = [
    {platform: 'twitch', id: 'd1', userId: 'd1', name: 'NewViewer', color: '#1e90ff', text: 'Hi everyone, first time here!', badges: [], emotes: [], time: now, firstMessage: true},
    {platform: 'twitch', id: 'd2', userId: 'd2', name: 'Luna', color: '#ff69b4', text: `@${me} that jump was impossible`, badges: [BADGE.vip], emotes: [], time: now},
    {platform: 'twitch', id: 'd3', userId: 'd3', name: 'RiZing_tv', color: '#a970ff', text: 'twelve months!', badges: [BADGE.sub], emotes: [], time: now, eventId: 'resub', eventPlan: 'Prime', eventMonths: '12'},
    {platform: 'twitch', id: 'd4', userId: 'd4', name: 'Babbo', color: '#00ff7f', text: '', badges: [], emotes: [], time: now, eventId: 'submysterygift', eventPlan: '1000', eventCount: '5', eventTotal: '12'},
    // come su Twitch: dopo il regalo alla community, una riga per ogni persona che ha ricevuto la sub
    {platform: 'twitch', id: 'd4r0', userId: 'd4', name: 'Babbo', color: '#00ff7f', text: '', badges: [], emotes: [], time: now, eventId: 'subgift', eventPlan: '1000', eventRecipient: 'Fortunato', eventTotal: '0'},
    {platform: 'twitch', id: 'd4r1', userId: 'd4', name: 'Babbo', color: '#00ff7f', text: '', badges: [], emotes: [], time: now, eventId: 'subgift', eventPlan: '1000', eventRecipient: 'Nebbia', eventTotal: '0'},
    {platform: 'twitch', id: 'd4r2', userId: 'd4', name: 'Babbo', color: '#00ff7f', text: '', badges: [], emotes: [], time: now, eventId: 'subgift', eventPlan: '1000', eventRecipient: 'Kira_77', eventTotal: '0'},
    {platform: 'twitch', id: 'd4r3', userId: 'd4', name: 'Babbo', color: '#00ff7f', text: '', badges: [], emotes: [], time: now, eventId: 'subgift', eventPlan: '1000', eventRecipient: 'ottoBit', eventTotal: '0'},
    {platform: 'twitch', id: 'd4r4', userId: 'd4', name: 'Babbo', color: '#00ff7f', text: '', badges: [], emotes: [], time: now, eventId: 'subgift', eventPlan: '1000', eventRecipient: 'LunaPiena', eventTotal: '0'},
    {platform: 'twitch', id: 'd4b', userId: 'd4', name: 'Gifter', color: '#00ff7f', text: '', badges: [], emotes: [], time: now, eventId: 'subgift', eventPlan: '1000', eventRecipient: 'LuckyViewer', eventTotal: '3'},
    {platform: 'twitch', id: 'd5', userId: 'd5', name: 'StreamerFriend', color: '#ff7f50', text: '', badges: [], emotes: [], time: now, eventId: 'raid', eventViewers: '42'},
    {platform: 'twitch', id: 'd6', userId: 'd6', name: 'GenerousViewer', color: '#daa520', text: 'Cheer100 Great stream!', badges: [], emotes: [], time: now, bits: 100},
    {platform: 'twitch', id: 'd7', userId: 'd7', name: me, color: '#9147ff', text: 'We are playing late tonight', badges: [BADGE.streamer], emotes: [], time: now, eventId: 'announcement', eventColor: 'BLUE'},
    {platform: 'twitch', id: 'd8', userId: 'd8', name: 'Luna', color: '#ff69b4', text: 'that one is a keeper Kappa', badges: [BADGE.vip], emotes: [{start: 21, end: 25, url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'}], time: now, replyTo: me, replyText: 'We are playing late tonight'},
    {platform: 'tiktok', id: 'd9', userId: 'd9', name: 'giulia', color: '#75c8f1', text: 'Hi! First time here 👋', badges: [], emotes: [], time: now},
    {platform: 'tiktok', id: 'd9l', userId: 'd9', name: 'giulia', text: '', badges: [], emotes: [], time: now, eventId: 'like', eventCount: '1'},
    {platform: 'tiktok', id: 'd9e', userId: 'd9e', name: 'marco_tt', color: '#daa520', text: '[emote]', badges: [], emotes: [{start: 0, end: 6, url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'}], time: now},
    {platform: 'tiktok', id: 'd9m', userId: 'd9', name: 'giulia', text: '', badges: [], emotes: [], time: now, eventId: 'like', eventCount: '11'},
    {platform: 'twitch', id: 'd13', userId: 'd13', name: me, color: '#9147ff', text: 'thanks for the raid @Luna', badges: [BADGE.streamer], emotes: [], time: now},
    {platform: 'twitch', id: 'd14', userId: 'd14', name: 'PlainViewer', color: '#0000ff', text: 'no badges on this line', badges: [], emotes: [], time: now},
    {platform: 'twitch', id: 'd15', userId: 'd15', name: 'ActionGuy', color: '#008000', text: 'dances to the music', action: true, badges: [], emotes: [], time: now},
    {platform: 'tiktok', id: 'd16', userId: 'd16', name: 'sara.tt', text: '', badges: [], emotes: [], time: now, eventId: 'gift', eventCount: '5', eventText: 'Rose', eventTotal: '5'},
    {platform: 'twitch', id: 'd10', userId: 'd10', name: 'Troublemaker', color: '#b22222', text: 'message later deleted by a moderator', badges: [], emotes: [], time: now},
    {platform: 'twitch', id: 'd19', userId: 'd19', name: 'ClipFan', color: '#2e8b57', text: 'clip of that jump: https://clips.twitch.tv/demo', badges: [], emotes: [], time: now},
    {platform: 'twitch', id: 'd20', userId: 'd20', name: 'BigSpender', color: '#1e90ff', text: '', badges: [], emotes: [], time: now, eventId: 'sub', eventPlan: '3000'},
  ];
  for (const row of rows) addMessage({...row, demo: true}); // demo: le icone non chiamano mai Twitch
  // premi punti canale: messaggio prima del premio (anche senza rewardId), messaggio 1 s dopo,
  // messaggio che non arriva (dopo 4 s il blocco mostra il testo da solo), premio senza testo.
  // Gli id rendono la demo ripetibile: una seconda /demo non duplica i premi.
  addMessage({platform: 'twitch', id: 'd11', userId: 'd11', name: 'mi__chiamano__alfredo', color: '#00a8a8', text: 'Pronto, centralino?', badges: [], emotes: [], time: now, demo: true});
  onReward({id: 'demo-r1', userId: 'd11', name: 'mi__chiamano__alfredo', reward: 'TTS', cost: 100, input: 'Pronto, centralino?', demo: true});
  onReward({id: 'demo-r2', userId: 'd17', name: 'Pasquale', login: 'pasquale', reward: 'Song Request', cost: 2500, input: 'Nel blu dipinto di blu', demo: true});
  setTimeout(() => addMessage({platform: 'twitch', id: 'd17', userId: 'd17', name: 'Pasquale', color: '#ff4500', text: 'Nel blu dipinto di blu', badges: [], emotes: [], time: Date.now(), rewardId: 'demo', demo: true}), 1000);
  onReward({id: 'demo-r3', userId: 'd18', name: 'Ghost_Viewer', login: 'ghost_viewer', reward: 'TTS', cost: 100, input: 'is anyone reading this?', demo: true});
  onReward({id: 'demo-r4', userId: 'd12', name: 'Luna', reward: 'Hydrate!', cost: 500, input: '', demo: true});
  // chi entra nella LIVE TikTok: la stessa riga in fondo cambia nome, uno ogni 2,5 s (a demo già caricata)
  ['marco', 'andrea', 'riccardo', 'giulia', 'luca', 'sofia'].forEach((name, i) =>
    setTimeout(() => addMessage({platform: 'tiktok', name, eventId: 'join'}), 1500 + i * 2500));
  const gone = messages.querySelector('.chat-line[data-id="d10"]');
  if (gone && !gone.classList.contains('is-deleted')) markDeleted(gone, `(Deleted by ${me})`, 1);
  if (options.modactions) modActionNotice({userId: 'd10', duration: '600'}, 'Molesto');
  demoHighlights(me);
  systemLine('Samples are shown only here. Nothing was sent to Twitch.');
}

// Risposta in thread: barra "Rispondendo a @nome" sopra la casella, come su Twitch.
let replyTarget = null;
function startReply(m) {
  if (!account) return;
  replyTarget = {id: m.demo ? '' : m.id || '', name: m.name}; // senza id (o demo): una menzione, non una discussione
  $('reply-label').textContent = `Replying to @${m.name}:`;
  // il messaggio a cui si risponde, come lo mostra Twitch sopra la casella
  const quote = $('reply-quote');
  quote.innerHTML = '';
  for (const badge of m.badges || []) quote.append(badgeImage(badge));
  quote.append(authorSpan(m), document.createTextNode(': '), messageBody(m));
  $('thread-list').hidden = true;
  $('reply-footer').hidden = true;
  $('reply-bar').hidden = false;
  document.querySelector('.chat-input').classList.add('is-replying');
  setReplyChip(m.name);
  box.focus();
}
function cancelReply() {
  replyTarget = null;
  $('reply-bar').hidden = true;
  document.querySelector('.chat-input').classList.remove('is-replying');
  for (const chip of box.querySelectorAll('.reply-chip')) chip.remove();
}
$('reply-cancel').onclick = cancelReply;

$('send').onclick = () => {
  const text = boxText();
  if (!text) return;
  const replyTo = replyTarget ? replyTarget.id : '';
  cancelReply();
  boxClear();
  commandBox.hidden = true;
  if (text.toLowerCase().startsWith('/demo')) {
    showDemo();
    return;
  }
  // /user nome: apre la scheda dell'utente, come su Twitch (non manda niente in chat)
  const userCommand = /^\/user\s+@?([A-Za-z0-9_]{1,25})\s*$/i.exec(text);
  if (userCommand) {
    openUserByName(userCommand[1]);
    return;
  }
  if (/^\/(ban|timeout|delete|clear)\b/i.test(text)) noteRecentMod();
  post('/api/send', {text, replyTo}).then(result => {
    const info = result.error ? result.error : result.notice;
    if (info) systemLine(info);
  });
};
// Invio manda il messaggio. Se c'è un suggerimento aperto e quello che hai scritto non è ancora
// un comando o un nome completo, Invio completa (come Twitch) e il secondo Invio manda.
box.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (!mentionBox.hidden) {
    const active = mentionBox.querySelector('button.is-active') || mentionBox.querySelector('button');
    if (active) active.click();
    return;
  }
  if (!commandBox.hidden) {
    const value = boxText();
    const first = value.split(' ')[0].toLowerCase();
    const complete = COMMANDS.some(c => c[0] === first) || value.includes(' ');
    if (!complete) {
      const active = commandBox.querySelector('button.is-active') || commandBox.querySelector('button');
      if (active) active.click();
      return;
    }
  }
  $('send').click();
});
// Incollare porta solo testo: niente formattazione strana dentro la casella.
box.addEventListener('paste', event => {
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData('text');
  boxInsert(document.createTextNode(text));
});

// impostazioni
$('settings-button').onclick = () => { $('settings').hidden = !$('settings').hidden; };
$('save').onclick = () => {
  post('/api/config', {twitch: $('twitch-channel').value, tiktok: $('tiktok-channel').value})
    .then(result => { $('settings-result').textContent = result.error || 'Channels saved.'; });
};
$('reauth-button').onclick = () => {
  post('/api/account', {clientId: $('client-id').value.trim()}).then(() => {
    $('reauth').hidden = true;
  });
};
$('connect-account').onclick = () => {
  post('/api/account', {clientId: $('client-id').value.trim()}).then(result => {
    const box = $('device-code');
    box.hidden = false;
    box.textContent = result.error
      ? result.error
      : 'Your browser opened. Authorize Crossfeed on Twitch, then return here; it will connect automatically.';
  });
};
for (const button of document.querySelectorAll('.filter'))
  button.onclick = () => applyFilter(button.dataset.filter);


let chattersData = null;

function renderViewers() {
  const body = $('viewers-body');
  body.innerHTML = '';
  if (!chattersData) return;
  const needle = $('viewers-filter').value.trim().toLowerCase();
  const keep = name => !needle || name.toLowerCase().includes(needle);
  const section = (title, names) => {
    const list = names.filter(keep);
    if (!list.length) return;
    const heading = document.createElement('h4');
    heading.textContent = title;
    body.append(heading);
    for (const name of list) {
      const row = document.createElement('div');
      row.textContent = name;
      body.append(row);
    }
  };
  section('Emittente', chattersData.broadcaster ? [chattersData.broadcaster] : []);
  section('Moderators', chattersData.moderators || []);
  section('VIP', chattersData.vips || []);
  section('Chat bot', chattersData.bots || []);
  section('Spettatori', chattersData.viewers || []);
  if (!body.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = needle ? 'No user found with this name.' : 'No one is currently in chat.';
    body.append(empty);
  }
}

$('viewers').onclick = () => {
  const panel = $('viewer-list');
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  $('viewers-filter').value = '';
  $('viewers-body').innerHTML = '<div class="empty">Loading…</div>';
  post('/api/chatters', {}).then(result => {
    if (result.error) {
      $('viewers-body').innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = result.error;
      $('viewers-body').append(empty);
      return;
    }
    chattersData = result;
    rememberChatters(result);
    renderViewers();
  });
};

// Tutti i presenti in chat entrano nei suggerimenti con @, anche se non hanno ancora scritto.
function rememberChatters(data) {
  const names = [data.broadcaster, ...(data.moderators || []), ...(data.vips || []), ...(data.bots || []),
                 ...(data.viewers || [])].filter(Boolean);
  for (const name of names) if (!chatters.has(name)) chatters.set(name, 0);
}
let chattersLoaded = false;
function preloadChatters() {
  if (chattersLoaded || !account) return;
  chattersLoaded = true;
  post('/api/chatters', {}).then(result => { if (!result.error) rememberChatters(result); });
}
$('viewers-close').onclick = () => { $('viewer-list').hidden = true; };
$('viewers-filter').oninput = renderViewers;

// suggerimenti dei comandi, come quando su Twitch scrivi "/"
const COMMANDS = [
  ['/announce', '[message]', 'Send an announcement in chat (also /announceblue, /announcegreen, /announceorange, /announcepurple)'],
  ['/ban', '[username] [reason]', 'Permanently ban a user from the channel'],
  ['/block', '[username]', 'Prevent a user from interacting with you on Twitch'],
  ['/clear', '', 'Clear chat history for non-moderators'],
  ['/color', '[color]', 'Change your username color, for example blue or green'],
  ['/commercial', '[30|60|90|120|150|180]', 'Start an ad'],
  ['/emoteonly', '', 'Limit chat to emotes only'],
  ['/emoteonlyoff', '', 'Disable emote-only mode'],
  ['/followers', '[duration]', 'Limit chat to followers based on follow duration'],
  ['/followersoff', '', 'Disable followers-only mode'],
  ['/demo', '', 'Show notification samples in this panel without sending anything to Twitch'],
  ['/help', '[command]', 'Show detailed usage for a chat command'],
  ['/marker', '[description]', 'Add a stream marker at the current point'],
  ['/mod', '[username]', 'Grant moderator status to a user'],
  ['/mods', '', 'Show the channel moderator list'],
  ['/raid', '[channel]', 'Start a raid to another channel'],
  ['/shoutout', '[username]', 'Send a shoutout to another streamer'],
  ['/slow', '[seconds]', 'Limit how often users can send messages'],
  ['/slowoff', '', 'Disable slow mode'],
  ['/subscribers', '', 'Limit chat to subscribers'],
  ['/subscribersoff', '', 'Disable subscribers-only mode'],
  ['/timeout', '[username] [seconds] [reason]', 'Temporarily time out a user from chat'],
  ['/unban', '[username]', 'Remove a user ban'],
  ['/unblock', '[username]', 'Remove a user from your blocked list'],
  ['/uniquechat', '', 'Prevent identical or nearly identical messages'],
  ['/uniquechatoff', '', 'Disable unique chat mode'],
  ['/unmod', '[username]', 'Revoke moderator status from a user'],
  ['/unraid', '', 'Cancel the current raid'],
  ['/untimeout', '[username]', 'Remove a user timeout'],
  ['/unvip', '[username]', 'Revoke VIP status from a user'],
  ['/user', '[username]', 'View a channel user’s profile information'],
  ['/vip', '[username]', 'Grant VIP status to a user'],
  ['/vips', '', 'Show the channel VIP list'],
];

const commandBox = $('commands');
let commandIndex = 0;

function renderCommands() {
  const value = boxText();
  if (!value.startsWith('/')) {
    commandBox.hidden = true;
    return;
  }
  const typed = value.split(' ')[0].toLowerCase();
  const matches = COMMANDS.filter(c => c[0].startsWith(typed));
  commandBox.innerHTML = '';
  if (!matches.length || value.includes(' ')) {
    commandBox.hidden = true;
    return;
  }
  commandIndex = Math.min(commandIndex, matches.length - 1);
  matches.forEach(([name, args, description], i) => {
    const button = document.createElement('button');
    button.className = i === commandIndex ? 'is-active' : '';
    const title = document.createElement('b');
    title.textContent = name;
    const argSpan = document.createElement('span');
    argSpan.className = 'command-args';
    argSpan.textContent = args ? ' ' + args : '';
    const note = document.createElement('small');
    note.textContent = description;
    const head = document.createElement('div');
    head.append(title, argSpan);
    button.append(head, note);
    button.onclick = () => {
      box.textContent = name + ' ';
      box.focus();
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      renderCommands();
    };
    commandBox.append(button);
  });
  commandBox.hidden = false;
}

box.addEventListener('input', renderCommands);
box.addEventListener('keydown', event => {
  if (commandBox.hidden) return;
  const buttons = [...commandBox.querySelectorAll('button')];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    renderCommands();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    buttons[commandIndex].click();
  } else if (event.key === 'Escape') {
    commandBox.hidden = true;
  }
}, true);

// suggerimenti dei nomi quando scrivi @, come su Twitch
const mentionBox = $('mentions');
let mentionIndex = 0;

function currentMentionWord() {
  const match = textBeforeCaret().match(/@([\w]*)$/);
  return match ? match[1] : null;
}

function renderMentions() {
  const word = currentMentionWord();
  if (word === null) {
    mentionBox.hidden = true;
    return;
  }
  const needle = word.toLowerCase();
  const names = [...chatters.entries()]
    .filter(([name]) => name.toLowerCase().startsWith(needle))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name]) => name);
  mentionBox.innerHTML = '';
  if (!names.length) {
    mentionBox.hidden = true;
    return;
  }
  mentionIndex = Math.min(mentionIndex, names.length - 1);
  names.forEach((name, i) => {
    const button = document.createElement('button');
    button.className = i === mentionIndex ? 'is-active' : '';
    button.textContent = '@' + name;
    button.onclick = () => {
      // toglie il pezzo di nome già digitato e mette quello completo
      const selection = window.getSelection();
      if (selection.rangeCount) {
        const range = selection.getRangeAt(0);
        const typed = (currentMentionWord() || '').length + 1;
        for (let i = 0; i < typed; i++) document.execCommand('delete', false);
      }
      boxInsert(document.createTextNode('@' + name + ' '));
      mentionBox.hidden = true;
    };
    mentionBox.append(button);
  });
  mentionBox.hidden = false;
}

box.addEventListener('input', renderMentions);
box.addEventListener('keydown', event => {
  if (mentionBox.hidden) return;
  const buttons = [...mentionBox.querySelectorAll('button')];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    renderMentions();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    buttons[mentionIndex].click();
  } else if (event.key === 'Escape') {
    mentionBox.hidden = true;
  }
}, true);

// impostazioni dell'aspetto, salvate nel pannello ("Brief" è il predefinito di Twitch per chi trasmette)
const view = $('messages');
const options = {style: 'twitch', modIcons: 'hover', time: true, modactions: true, alternate: false, deleted: 'short',
                 size: '14', aria: false, pause: 'scroll', readable: true,
                 automodCat: true, automodStd: true, automodTerms: true, automodLinks: true};

function applyOptions() {
  // Mod Icons: "hover" (default) shows them over the message like the reply button, "always" in the line as on Twitch
  if (options.badges === false) options.modIcons = 'off'; // the old on/off switch
  delete options.badges;
  if (!['hover', 'always', 'off'].includes(options.modIcons)) options.modIcons = 'hover';
  $('opt-modicons').value = options.modIcons;
  // Chat Style: "twitch" (predefinito) o "multistream", compatta coi contatori per piattaforma (style.css in fondo)
  if (!['twitch', 'multistream'].includes(options.style)) options.style = 'twitch';
  $('opt-style').value = options.style;
  document.body.classList.toggle('style-multistream', options.style === 'multistream');
  view.classList.toggle('no-modicons', options.modIcons === 'off' || !account);
  view.classList.toggle('modicons-hover', options.modIcons === 'hover');
  view.classList.toggle('no-time', !options.time);
  view.classList.toggle('alternate', options.alternate);
  // la vecchia "Brief" (e prima ancora "strike") mostrava "<message deleted>": è il Legacy di Twitch
  if (options.deleted === 'strike' || options.deleted === 'brief') options.deleted = 'legacy';
  if (!['hide', 'detail', 'legacy', 'short'].includes(options.deleted)) options.deleted = 'short';
  $('opt-deleted').value = options.deleted;
  view.classList.remove('deleted-hide', 'deleted-detail', 'deleted-legacy', 'deleted-short');
  view.classList.add('deleted-' + options.deleted);
  // dimensione della chat: un cursore che ingrandisce testo, emote e badge insieme (70-200%).
  // Chi aveva scelto una voce della vecchia tendina (12/13/14/18 px) la ritrova convertita.
  if (!options.zoom) options.zoom = Math.round((Number(options.size) || 14) / 14 * 100);
  options.zoom = Math.min(200, Math.max(70, Math.round((Number(options.zoom) || 100) / 5) * 5));
  view.style.setProperty('--chat-zoom', String(options.zoom / 100));
  $('opt-zoom-value').textContent = `${options.zoom}%`;
  view.setAttribute('aria-live', options.aria ? 'polite' : 'off');
  view.classList.toggle('hide-automod-cat', !options.automodCat);
  view.classList.toggle('hide-automod-std', !options.automodStd);
  view.classList.toggle('hide-automod-terms', !options.automodTerms);
  view.classList.toggle('hide-automod-links', !options.automodLinks);
  for (const author of messages.querySelectorAll('.chat-author[data-color]'))
    author.style.color = options.readable ? readable(author.dataset.color) : author.dataset.color;
  localStorage.setItem('fialss-chat-options', JSON.stringify(options));
}

try {
  Object.assign(options, JSON.parse(localStorage.getItem('fialss-chat-options') || '{}'));
} catch { /* preferenze illeggibili: si riparte da quelle predefinite */ }

$('opt-time').checked = options.time;
$('opt-modactions').checked = options.modactions;
$('opt-alternate').checked = options.alternate;
$('opt-deleted').value = options.deleted;
$('opt-zoom').value = String(options.zoom || 100);
applyOptions();

$('opt-style').onchange = e => { options.style = e.target.value; applyOptions(); };
$('opt-modicons').onchange = e => { options.modIcons = e.target.value; applyOptions(); };
$('opt-time').onchange = e => { options.time = e.target.checked; applyOptions(); };
$('opt-modactions').onchange = e => { options.modactions = e.target.checked; applyOptions(); };
$('opt-alternate').onchange = e => { options.alternate = e.target.checked; applyOptions(); };
$('opt-deleted').onchange = e => { options.deleted = e.target.value; applyOptions(); };
$('opt-zoom').oninput = e => { options.zoom = Number(e.target.value); applyOptions(); };
$('opt-aria').checked = options.aria;
$('opt-aria').onchange = e => { options.aria = e.target.checked; applyOptions(); };
$('opt-pause').value = options.pause;
$('opt-pause').onchange = e => { options.pause = e.target.value; applyOptions(); };
$('opt-readable').checked = options.readable;
$('opt-readable').onchange = e => { options.readable = e.target.checked; applyOptions(); };
for (const [id, key] of [['opt-automod-cat', 'automodCat'], ['opt-automod-std', 'automodStd'],
                         ['opt-automod-terms', 'automodTerms'], ['opt-automod-links', 'automodLinks']]) {
  $(id).checked = options[key];
  $(id).onchange = e => { options[key] = e.target.checked; applyOptions(); };
}
$('settings-close').onclick = () => { $('settings').hidden = true; };
$('open-popout').onclick = () => {
  const channel = $('twitch-channel').value.trim();
  if (channel) window.open(`https://www.twitch.tv/popout/${channel}/chat?popout=`, '_blank');
};

// moderazione col tasto destro
const menu = $('context-menu');
let menuTarget = null;
messages.addEventListener('contextmenu', event => {
  const line = event.target.closest('.chat-line');
  if (!line || !account) return;
  event.preventDefault();
  menuTarget = line;
  menu.hidden = false;
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 110)}px`;
});
document.addEventListener('click', () => { menu.hidden = true; });
for (const button of menu.querySelectorAll('button')) {
  button.onclick = () => {
    if (!menuTarget) return;
    post('/api/moderate', {
      action: button.dataset.action,
      platform: menuTarget.dataset.platform,
      id: menuTarget.dataset.id,
      userId: menuTarget.dataset.userId,
      name: menuTarget.dataset.name,
    }).then(result => { if (result.error) systemLine(`Action failed: ${result.error}`); });
  };
}


// ============================================================ scheda utente (viewer card) come su Twitch
// Testi presi dalla traduzione italiana di Twitch. I dati Twitch arrivano da Helix (/api/user);
// messaggi e azioni sono quelli visti da questo pannello da quando è aperto.
const history = new Map(); // chiave utente -> ultimi messaggi
const modLog = new Map();  // chiave utente -> timeout/ban/eliminazioni viste
const TIMEOUTS = [[60, '1 minute'], [600, '10 minutes'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week']];
let cardKey = '';

function userKey(platform, userId, name) { return `${platform}:${userId || (name || '').toLowerCase()}`; }
function remember(map, key, entry, cap) {
  const list = map.get(key) || [];
  list.push(entry);
  if (list.length > cap) list.shift();
  map.set(key, list);
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svgIcon(icon) {
  const span = el('span');
  span.innerHTML = `<svg><use href="#${icon}"/></svg>`;
  return span.firstChild;
}
function iconButton(icon, label, onClick) {
  const button = el('button', 'icon-button');
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(svgIcon(icon));
  button.onclick = event => { event.stopPropagation(); onClick(event); };
  return button;
}
function pill(icon, label, onClick) {
  const button = el('button', 'viewer-card__pill');
  if (icon) button.append(svgIcon(icon));
  button.append(document.createTextNode(label));
  button.onclick = event => { event.stopPropagation(); onClick(); };
  return button;
}
function longDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {day: 'numeric', month: 'long', year: 'numeric'});
}
function shortWhen(time) { // " 12/09/26 alle ore 23:36" come Twitch
  const d = new Date(time);
  return `${d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'})} at ${d.toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit'})}`;
}
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
function openTwitch(url) { post('/api/open', {url}); }
function systemLine(text) {
  const line = el('div', 'chat-line is-system');
  line.append(el('span', 'chat-line__message', text));
  pushLine(line);
}
function runText(text) {
  post('/api/send', {text}).then(result => { const info = result.error || result.notice; if (info) systemLine(info); });
}

function showMenu(anchor, items) {
  closeMenu();
  const card = $('viewer-card');
  const menu = el('div', 'viewer-card__menu');
  for (const [label, action] of items) {
    const button = el('button', '', label);
    button.onclick = event => { event.stopPropagation(); closeMenu(); action(); };
    menu.append(button);
  }
  const a = anchor.getBoundingClientRect(), c = card.getBoundingClientRect();
  menu.style.top = `${a.bottom - c.top + card.scrollTop + 2}px`;
  menu.style.right = `${Math.max(4, c.right - a.right)}px`;
  card.append(menu);
}
function closeMenu() { for (const menu of document.querySelectorAll('.viewer-card__menu')) menu.remove(); }
function closeViewerCard() { $('viewer-card').hidden = true; $('viewer-card').innerHTML = ''; cardKey = ''; }
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeViewerCard(); });
document.addEventListener('click', event => {
  if (!event.target.closest('.viewer-card')) closeMenu();
  if (!event.target.closest('.viewer-card, .chat-author')) closeViewerCard();
});

function openViewerCard(m) {
  const card = $('viewer-card');
  const key = userKey(m.platform, m.userId, m.name);
  cardKey = key;
  card.hidden = false;
  card.innerHTML = '';
  const login = (m.name || '').toLowerCase();
  const channel = ($('twitch-channel').value || '').trim().toLowerCase();
  const isTwitch = m.platform === 'twitch';
  const isMe = !!account && isTwitch && login === (account.login || '').toLowerCase();
  const isOwner = !!account && (account.login || '').toLowerCase() === channel;
  const isMod = (m.badges || []).some(b => /moderat/i.test((b.title || '') + (b.url || '')));
  let banned = false;

  // --- intestazione: avatar, nome, righe con le icone di Twitch, pulsanti in alto a destra
  const header = el('div', 'viewer-card__header');
  const avatar = el('img', 'viewer-card__avatar');
  avatar.alt = '';
  avatar.hidden = !isTwitch;
  const info = el('div', 'viewer-card__info');
  const name = el('div', 'viewer-card__name', m.name);
  name.onclick = () => { if (isTwitch) openTwitch(`https://www.twitch.tv/${login}`); };
  const rows = el('div');
  info.append(name, rows);
  const tools = el('div', 'viewer-card__tools');
  header.append(avatar, info, tools);
  card.append(header);
  const row = (icon, text) => { const r = el('div', 'viewer-card__row'); r.append(svgIcon(icon), el('span', '', text)); rows.append(r); };

  const moderate = (action, duration) => {
    noteRecentMod();
    post('/api/moderate', {action, platform: 'twitch', id: '', userId: m.userId, name: m.name, duration: String(duration || 0)})
      .then(result => {
        if (result.error) return systemLine(`Action failed: ${result.error}`);
        banned = action !== 'unban';
        if (!banned) { bannedUsers.delete(m.userId); refreshModIcons(m.userId); }
        refreshTools();
      });
  };
  const refreshTools = () => {
    tools.innerHTML = '';
    if (account && isTwitch && !isMe) {
      if (banned) tools.append(iconButton('i-unban', `Unban ${m.name}`, () => moderate('unban')));
      else {
        tools.append(iconButton('i-ban', `Ban ${m.name}`, () => moderate('ban')));
        const timeout = iconButton('i-timeout', `Timeout ${m.name}`, () =>
          showMenu(timeout, TIMEOUTS.map(([seconds, label]) => [`Timeout ${label}`, () => moderate('timeout', seconds)])));
        tools.append(timeout);
      }
    }
    if (isTwitch) tools.append(iconButton('i-popout', 'Popout', () => openTwitch(`https://www.twitch.tv/popout/${channel}/viewercard/${login}`)));
    tools.append(iconButton('i-close', 'Hide', closeViewerCard));
  };
  refreshTools();

  if (isTwitch && account) {
    post('/api/user', m.userId ? {id: m.userId} : {login}).then(data => {
      if (cardKey !== key || data.error) return;
      const u = data.user && data.user.data && data.user.data[0];
      if (!u) return;
      if (u.profile_image_url) avatar.src = u.profile_image_url;
      if (u.display_name) name.textContent = u.display_name;
      if (u.created_at) row('i-cake', `Account created on ${longDate(u.created_at)}`);
      const f = data.follow && data.follow.data && data.follow.data[0];
    if (f) row('i-heart', `Following since ${longDate(f.followed_at)}`);
      const s = data.sub && data.sub.data && data.sub.data[0];
      const months = m.subMonths || 0;
      if (s) {
        const tier = s.tier === '3000' ? 3 : s.tier === '2000' ? 2 : 1;
      row(s.is_gift ? 'i-gift' : 'i-star', `Tier ${tier} subscription for ${plural(months || 1, 'month', 'months')}`);
      } else if (months) {
      row('i-star', `Previously subscribed for ${plural(months, 'month', 'months')}`);
      }
      const b = data.ban && data.ban.data && data.ban.data[0];
      if (b) {
        rows.append(el('span', 'viewer-card__status', b.expires_at ? 'Timed Out' : 'Banned'));
        banned = true;
        refreshTools();
      }
    });
  }

  // --- stemmi
  if (m.badges && m.badges.length) {
    const section = el('div', 'viewer-card__section');
    section.append(el('h5', 'viewer-card__title', 'Badges'));
    const grid = el('div', 'viewer-card__badges');
    for (const badge of m.badges) {
      const box = el('div', 'viewer-card__badge');
      box.title = badge.title || '';
      const img = el('img');
      img.src = badge.url;
      img.alt = badge.title || '';
      box.append(img);
      grid.append(box);
    }
    section.append(grid);
    card.append(section);
  }

  // --- pulsanti come su Twitch
  const actions = el('div', 'viewer-card__actions');
  if (isMe) {
    actions.append(pill('', 'Edit Profile', () => openTwitch('https://www.twitch.tv/settings/profile')),
                   pill('', 'Edit Chat Identity', () => openTwitch('https://www.twitch.tv/settings/profile')));
  } else if (isTwitch) {
    actions.append(pill('i-gift', 'Gift a Sub', () => openTwitch(`https://www.twitch.tv/subs/${channel}`)));
    actions.append(pill('', 'Follow', () => openTwitch(`https://www.twitch.tv/${login}`)));
    const more = iconButton('i-more', 'More options', () => showMenu(more, [
      [`Blocca ${m.name}`, () => runText(`/block ${login}`)],
      [`Report ${m.name}`, () => openTwitch(`https://www.twitch.tv/${login}`)],
      ...(isOwner ? [[isMod ? `Remove Moderator from ${m.name}` : `Make Moderator: ${m.name}`, () => runText(`/${isMod ? 'unmod' : 'mod'} ${login}`)]] : []),
    ]));
    actions.append(more);
    actions.append(pill('', 'Whisper', () => openTwitch(`https://www.twitch.tv/${login}`)));
  }
  if (actions.childElementCount) card.append(actions);

  // --- cassetto moderatore: Messaggi / Moderation Actions / Moderator Comments
  if (account) {
    const msgs = history.get(key) || [];
    const acts = modLog.get(key) || [];
    const comments = loadComments(key);
    const count = t => acts.filter(a => a.type === t).length;
    const tabs = el('div', 'viewer-card__tabs');
    const panel = el('div');
    const defs = [
      [msgs.length > 999 ? '999+' : String(msgs.length), 'Messages', renderMessages],
      [`${count('warn')}/${count('timeout')}/${count('ban')}`, 'Moderation Actions', renderActions],
      [`${comments.length} (+0)`, 'Moderator Comments', renderComments],
    ];
    defs.forEach(([number, label, render], index) => {
      const tab = el('button', 'viewer-card__tab');
      tab.append(el('b', '', number), el('span', '', label));
      tab.onclick = event => {
        event.stopPropagation();
        for (const t of tabs.children) t.classList.remove('is-active');
        tab.classList.add('is-active');
        panel.innerHTML = '';
        render(panel);
      };
      tabs.append(tab);
      if (index === 0) { tab.classList.add('is-active'); render(panel); }
    });
    card.append(tabs, panel);

    function renderMessages(into) {
      const logs = el('div', 'viewer-card__logs');
    if (!msgs.length) logs.append(el('div', 'viewer-card__empty', 'This user has not chatted in this channel.'));
      for (const msg of msgs) {
        const line = el('div', 'chat-line');
        const live = messages.querySelector(`.chat-line[data-id="${msg.id}"]`);
        if (live && live.classList.contains('is-deleted')) line.classList.add('is-deleted');
        line.append(el('span', 'chat-line__timestamp', timeText(msg.time)));
        line.append(messageBody(msg));
        logs.append(line);
      }
      into.append(logs);
      logs.scrollTop = logs.scrollHeight;
    }
    function renderActions(into) {
      const logs = el('div', 'viewer-card__logs');
      if (!acts.length) logs.append(el('div', 'viewer-card__empty', 'No moderation actions recorded by this panel. (Warnings/Timeouts/Bans)'));
      for (const a of acts.slice().reverse()) {
        const entry = el('div', 'viewer-card__entry');
        const what = a.type === 'timeout' ? `Timed out for ${durationText(a.duration)}` : a.type === 'ban' ? 'Banned' : 'Message Deleted';
        entry.append(el('b', '', what), el('small', '', ` ${shortWhen(a.time)}${a.mod ? ` di ${a.mod}` : ''}`));
        logs.append(entry);
      }
      into.append(logs);
    }
    function renderComments(into) {
      const logs = el('div', 'viewer-card__logs');
      const list = loadComments(key);
      if (!list.length) logs.append(el('div', 'viewer-card__empty', 'There are no moderator comments for this user.'));
      for (const c of list.slice().reverse()) {
        const entry = el('div', 'viewer-card__entry');
        entry.append(el('div', '', c.text), el('small', '', `${c.by} ${shortWhen(c.time)}`));
        logs.append(entry);
      }
      const form = el('div', 'viewer-card__comment');
      const input = el('input');
      input.placeholder = 'Add a comment';
      input.maxLength = 500;
      const add = pill('', 'Aggiungi', () => {
        const text = input.value.trim();
        if (!text) return;
        list.push({text, by: account.login, time: Date.now()});
        saveComments(key, list);
        into.innerHTML = '';
        renderComments(into);
        tabs.children[2].querySelector('b').textContent = `${list.length} (+0)`;
      });
      input.onkeydown = event => { if (event.key === 'Enter') add.click(); event.stopPropagation(); };
      form.append(input, add);
      into.append(logs, form);
    }
  }
}

// I commenti dei moderatori su Twitch stanno sui suoi server (non c'è API): qui restano nel pannello.
function loadComments(key) {
  try { return (JSON.parse(localStorage.getItem('fialss-chat-modcomments') || '{}')[key]) || []; } catch { return []; }
}
function saveComments(key, list) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem('fialss-chat-modcomments') || '{}'); } catch { /* si riparte da zero */ }
  all[key] = list;
  localStorage.setItem('fialss-chat-modcomments', JSON.stringify(all));
}


// ============================================================ discussione (thread) come su Twitch
const messageIndex = new Map(); // id -> messaggio, per ricostruire le discussioni viste da questo pannello
const threads = new Map();      // id del primo messaggio -> risposte

// La menzione a inizio casella e' grigia e non si scrive: come su Twitch. Sta nel testo sent.
function setReplyChip(name) {
  for (const chip of box.querySelectorAll('.reply-chip')) chip.remove();
  const chip = document.createElement('span');
  chip.className = 'reply-chip';
  chip.contentEditable = 'false';
  chip.textContent = `@${name}`;
  box.insertBefore(chip, box.firstChild);
  if (!chip.nextSibling || chip.nextSibling.nodeType !== Node.TEXT_NODE || !chip.nextSibling.nodeValue.startsWith(' '))
    chip.after(document.createTextNode(' '));
  box.focus();
  const range = document.createRange();
  range.selectNodeContents(box);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function compactLine(m) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  for (const badge of m.badges || []) line.append(badgeImage(badge));
  line.append(authorSpan(m), document.createTextNode(': '), messageBody(m));
  return line;
}

// Apre la discussione a cui appartiene il messaggio e imposta la risposta verso quel messaggio.
function openThread(m) {
  if (!account) return;
  const tid = m.replyThreadId || m.replyParentId || m.id;
  const root = messageIndex.get(tid) ||
    (m.replyParentId === tid ? {name: m.replyTo || '?', text: m.replyText || '', badges: [], emotes: []} : m);
  replyTarget = {id: m.demo ? '' : m.id || '', name: m.name};
  $('reply-label').textContent = 'Thread';
  const quote = $('reply-quote');
  quote.innerHTML = '';
  quote.append(compactLine(root));
  const list = $('thread-list');
  list.innerHTML = '';
  const replies = (threads.get(tid) || []).filter(r => r.id !== root.id);
  for (const r of replies) list.append(compactLine(r));
  list.hidden = replies.length === 0;
  $('reply-footer-name').textContent = `@${m.name}`;
  $('reply-footer').hidden = false;
  $('reply-bar').hidden = false;
  document.querySelector('.chat-input').classList.add('is-replying');
  setReplyChip(m.name);
  list.scrollTop = list.scrollHeight;
}
$('reply-footer-cancel').onclick = () => cancelReply();


// /user nome: riusa l'ultimo messaggio di quell'utente (colore, stemmi, id) se l'abbiamo visto,
// altrimenti chiede a Twitch solo il nome. Stesse parole di Twitch quando non esiste.
function openUserByName(name) {
  const wanted = name.toLowerCase();
  let found = null;
  for (const list of history.values())
    for (const m of list)
      if ((m.name || '').toLowerCase() === wanted && (!found || m.time > found.time)) found = m;
  if (found) return openViewerCard(found);
  post('/api/user', {login: wanted}).then(data => {
    const u = data && data.user && data.user.data && data.user.data[0];
    if (!u) return systemLine('No user matches that username.');
    openViewerCard({platform: 'twitch', id: '', userId: u.id, name: u.display_name || name,
                    color: '', badges: [], emotes: [], text: '', time: Date.now()});
  });
}


// ============================================================ in cima alla chat: la pila degli highlight di Twitch
// (community highlight stack). Regali alla community, sondaggio, pronostico e messaggio fissato sono card: davanti
// c'è la più recente, le altre aspettano dietro (se ne vede il bordo) e tornano quando quella davanti se ne va.
// L'Hype Train sta fisso sopra a tutte. Misure, testi e tempi dal codice di Twitch; i dati arrivano dal plugin
// (EventSub "highlight", Helix "pins") e dalla chat (submysterygift). La pila è fuori dallo zoom delle righe.
const stack = $('highlights');
const stickyBox = $('highlight-sticky');
const cardBox = $('highlight-card');
const highlights = []; // in ordine d'arrivo
const findHighlight = id => highlights.find(h => h.id === id);
const frontCard = () => highlights.filter(h => !h.sticky).pop();

// Crea o aggiorna la card `id` coi campi di spec (type, draw, sticky, expandable, endsAt, duration, timerView,
// removeAt, refresh...). Lo stesso id resta al suo posto, aperto o chiuso com'era; draw(h) ne rifà il contenuto.
function putHighlight(id, spec) {
  let h = findHighlight(id);
  if (!h) {
    h = {id, expanded: false, node: el('div', 'highlight'), box: el('div', 'highlight__box')};
    h.node.append(h.box);
    h.node.addEventListener('click', () => { h.touched = true; }, true);
    // clic sulla card: si apre o si chiude (non mentre passa l'intro, né alla fine di una selezione del testo)
    h.node.onclick = () => { if (h.expandable && !h.overlay && !String(getSelection())) toggleHighlight(h); };
    highlights.push(h);
  }
  Object.assign(h, spec);
  clearTimeout(h.removeTimer);
  if (h.removeAt) h.removeTimer = setTimeout(() => dropHighlight(h), Math.max(0, h.removeAt - Date.now()));
  drawHighlight(h);
  renderStack();
  return h;
}
function drawHighlight(h) {
  h.node.dataset.type = h.type;
  h.node.classList.toggle('is-expanded', h.expanded);
  h.node.classList.toggle('is-expandable', !!h.expandable);
  // il tempo è una barra sotto al bordo: "hidden" conta ma non si vede (regali), "open" si vede solo aperta (fissato)
  h.node.classList.toggle('has-timer', !!h.endsAt && h.timerView !== 'open');
  const parts = h.draw(h);
  if (h.endsAt && h.timerView !== 'hidden') parts.push(timerBar(h));
  h.box.replaceChildren(...parts);
  if (h.refresh) h.refresh(h);
}
// Barra del tempo che resta: parte da quanto manca e si svuota fino alla fine. Web Animations: tornando davanti
// dopo essere stata dietro a un'altra card non riparte da capo.
function timerBar(h) {
  const bar = el('div', 'highlight__timer'), fill = el('div', 'highlight__fill');
  const left = Math.max(0, h.endsAt - Date.now());
  fill.style.width = '0%';
  fill.animate([{width: `${h.duration > 0 ? Math.min(100, left / h.duration * 100) : 0}%`}, {width: '0%'}], {duration: left});
  bar.append(fill);
  return bar;
}
function dropHighlight(h) {
  if (!h || !highlights.includes(h)) return;
  highlights.splice(highlights.indexOf(h), 1);
  for (const timer of [h.removeTimer, h.overlayTimer, h.collapseTimer]) clearTimeout(timer);
  clearInterval(h.ticker);
  if (!h.node.isConnected) return renderStack();
  h.node.classList.add('is-leaving'); // esce in 100 ms, poi torna davanti quella che aspettava
  setTimeout(() => { h.node.remove(); renderStack(); }, 100);
}
function renderStack() {
  const sticky = highlights.find(h => h.sticky);
  const cards = highlights.filter(h => !h.sticky);
  const front = cards[cards.length - 1];
  for (const [box, h] of [[stickyBox, sticky], [cardBox, front]])
    if (box.firstChild !== (h ? h.node : null)) box.replaceChildren(...(h ? [h.node] : []));
  // una card sola è più larga (e l'Hype Train con lei); con due o più si intravede quella dietro
  stickyBox.classList.toggle('is-wide', cards.length === 1);
  cardBox.classList.toggle('community-highlight-stack__card--wide', cards.length === 1);
  $('highlight-backlog').hidden = cards.length < 2;
  stack.hidden = (!sticky && !front) || filter === 'tiktok'; // la pila è tutta Twitch
  fitMessages();
}
// Come su Twitch: finché la card davanti è chiusa i messaggi partono sotto di lei (padding = card coi suoi 5px,
// l'Hype Train escluso); aperta copre la chat senza spostarla.
function fitMessages() {
  const front = frontCard();
  if (front && front.expanded) return;
  const pad = `${stack.hidden ? 0 : cardBox.offsetHeight}px`;
  if (messages.style.paddingTop === pad) return;
  const stick = !paused && atBottom();
  // scivola solo con pochi messaggi, dove si vede; con la chat piena il cambio è sopra, fuori vista, e una
  // transizione la staccherebbe dal fondo
  const glide = messages.scrollHeight <= messages.clientHeight;
  messages.style.transition = glide ? 'padding-top 0.2s ease' : 'none';
  messages.style.paddingTop = pad;
  if (stick) scrollDown();
  if (stick && glide) setTimeout(() => { if (!paused) scrollDown(); }, 250);
}
function toggleHighlight(h, open = !h.expanded) {
  if (open === h.expanded) return;
  h.expanded = open;
  h.node.classList.toggle('is-expanded', open);
  for (const button of h.node.querySelectorAll('.highlight__chevron')) {
    button.title = open ? 'Collapse' : 'Expand';
    button.setAttribute('aria-label', button.title);
  }
  if (h.refresh) h.refresh(h);
  // la parte che si apre scende dall'alto (SlideOverTop di Twitch)
  if (open) for (const part of h.box.querySelectorAll('.highlight__body, .highlight__timer'))
    part.animate([{opacity: 0, transform: 'translateY(-20px)'}, {opacity: 1, transform: 'none'}], {duration: 200, easing: 'ease'});
  fitMessages();
}
function chevronButton(h) {
  const button = iconButton('i-angle-down', h.expanded ? 'Collapse' : 'Expand', () => toggleHighlight(h));
  button.classList.add('highlight__chevron');
  return button;
}
function closeButton(h) {
  const button = iconButton('i-close', 'Close', () => dropHighlight(h));
  button.classList.add('highlight__close');
  return button;
}
// ⋮ col menù di Twitch; il clic altrove lo chiude come quello della scheda utente (closeMenu)
function moreButton(items) {
  const more = iconButton('i-more', 'More Options', () => {
    closeMenu();
    const menu = el('div', 'viewer-card__menu highlight__menu');
    menu.onclick = event => event.stopPropagation();
    for (const [label, action] of items) {
      const button = el('button', '', label);
      button.onclick = () => { closeMenu(); action(); };
      menu.append(button);
    }
    const card = more.closest('.highlight'), a = more.getBoundingClientRect(), c = card.getBoundingClientRect();
    menu.style.top = `${a.bottom - c.top + 2}px`;
    menu.style.right = `${c.right - a.right}px`;
    card.append(menu);
  });
  return more;
}
// Da `from` a `to` con la transizione di Twitch, anche su un elemento appena rifatto (Web Animations)
function slide(node, prop, from, to, ms, easing) {
  node.style[prop] = to;
  if (from !== to) node.animate([{[prop]: from}, {[prop]: to}], {duration: ms, easing});
}
// Numero che sale fino al valore nuovo (punti del pronostico in 0,2 s, percentuale dell'Hype Train in 4 s)
function countUp(node, from, to, ms, format) {
  const start = performance.now();
  const step = now => {
    const t = from === to ? 1 : Math.min(1, (now - start) / ms);
    node.textContent = format(Math.floor(from + (to - from) * t));
    if (t < 1) requestAnimationFrame(step);
  };
  step(start);
}
// Animazioni che passano sopra alla card una dopo l'altra (intro del pronostico, fasi dell'Hype Train): ogni passo
// riempie il suo strato e dice quanto dura; finito l'ultimo torna il contenuto normale.
function playOverlay(h, steps, done) {
  clearTimeout(h.overlayTimer);
  const next = () => {
    if (h.overlay) h.overlay.remove();
    const step = steps.shift();
    h.overlay = step ? el('div', 'highlight__overlay') : null;
    h.node.classList.toggle('has-overlay', !!step);
    if (!step) return done && done();
    h.node.append(h.overlay);
    h.overlayTimer = setTimeout(next, step(h.overlay));
  };
  next();
}

// --- regalo di sub alla community (MysteryGiftChatBanner): ogni acquisto è una card sua, davanti; quella di prima
// resta dietro finché non finisce il suo tempo. Durata secondo i regali, come Twitch.
const GIFT_SECONDS = [[4, 5], [10, 10], [30, 20], [50, 30], [70, 40], [90, 50]];
function giftHighlight(m) {
  const count = parseInt(m.eventCount || '1', 10) || 1;
  const seconds = (GIFT_SECONDS.find(([most]) => count <= most) || [0, 60])[1];
  // "Nome (login)" quando il nome non è in caratteri latini, come Twitch (se il plugin manda il login)
  const who = /^ananonymousgifter$/i.test(m.name) ? 'Anonymous'
    : m.login && /[^\x00-\x7f]/.test(m.name) ? `${m.name} (${m.login})` : m.name;
  const ends = Date.now() + seconds * 1000;
  const h = putHighlight(`gift:${m.id || ends}`, {type: 'gift', endsAt: ends, duration: seconds * 1000, removeAt: ends,
    timerView: 'hidden', draw: () => {
      const icon = el('span', 'mystery-gift__icon');
      icon.append(svgIcon('i-gift'));
      const text = el('span', 'mystery-gift__text');
      text.append(el('b', '', who), ' gifted subs');
      const left = el('div', 'mystery-gift__left');
      left.append(icon, text);
      const row = el('div', 'mystery-gift');
      row.append(left, giftCount(count));
      // sfondo che scorre: viola fino a 19, poi sfumature sempre più ricche
      return [el('div', 'mystery-gift__bg' + (count >= 100 ? ' tier-100' : count >= 50 ? ' tier-50' : count >= 20 ? ' tier-20' : '')), row];
    }});
  if (count >= 10) confetti(h, count);
}
// "x25" con le cifre che girano come un contachilometri: ognuna scorre da 0 a sé, quelle a destra partono prima
function giftCount(count) {
  const out = el('span', 'mystery-gift__count' + (count >= 50 ? ' is-big' : ''), 'x');
  out.setAttribute('aria-label', `x${count}`);
  [...String(count)].forEach((digit, i) => {
    const reel = el('span', 'digit-reel'), strip = el('span', 'digit-reel__strip');
    for (let n = 0; n <= Number(digit); n++) strip.append(el('span', '', String(n)));
    strip.animate([{transform: 'translateY(0)'}, {transform: `translateY(${-digit}em)`}],
                  {duration: 2000, delay: (1 - 0.11 * i) * 1000, easing: 'ease', fill: 'both'});
    reel.append(strip);
    out.append(reel);
  });
  return out;
}
// coriandoli da 10 regali in su: più regali, più pezzi e più lontano cadono (valori di Twitch)
const CONFETTI_COLORS = ['rgb(105, 255, 195)', 'rgb(255, 202, 95)', 'rgb(30, 105, 255)', 'rgb(190, 0, 120)'];
function confetti(h, count) {
  const [pieces, fall, ms] = count >= 100 ? [200, 60, 1800] : count >= 50 ? [150, 30, 1000] : count >= 20 ? [100, 15, 1000] : [75, 5, 600];
  const layer = el('div', 'mystery-gift__confetti');
  for (let i = 0; i < pieces; i++) {
    const piece = el('i'), size = 4 + Math.random() * 6;
    piece.style.cssText = `left: ${Math.random() * 100}%; top: ${Math.random() * 100}%; width: ${size}px; height: ${size}px; background: ${CONFETTI_COLORS[i % 4]}`;
    piece.animate([{transform: 'none', opacity: 1},
                   {transform: `translate(${(Math.random() - 0.5) * 80}px, ${fall}vh) rotate(${Math.random() * 720}deg)`, opacity: 0}],
                  {duration: ms * (0.7 + Math.random() * 0.6), delay: Math.random() * 300, easing: 'ease-in', fill: 'both'});
    layer.append(piece);
  }
  h.node.append(layer);
  setTimeout(() => layer.remove(), ms * 1.3 + 400);
}

// numeri come nella chat di Twitch in inglese: 45% (1,234), 12.3K
const PERCENT = new Intl.NumberFormat('en-US', {style: 'percent'}), NUMBER = new Intl.NumberFormat('en-US');
const COMPACT = new Intl.NumberFormat('en-US', {notation: 'compact', maximumFractionDigits: 1});

// --- sondaggio (channel.poll.*): in corso "Current Poll" col tempo che resta; finito "Poll Ended", si apre da solo sui
// risultati (vincitori in verde con la coppa) e resta finché non lo chiudi, al massimo 5 minuti (quanto lo tenga
// Twitch non si vede). Dal pannello non si vota, non c'è un'API: solo lettura, come Twitch quando non puoi scegliere.
function pollHighlight(type, e) {
  const id = `poll:${e.id}`, old = findHighlight(id);
  const ended = type === 'channel.poll.end';
  if (ended && e.status === 'archived') return dropHighlight(old);
  const ends = Date.parse(e.ends_at), wasEnded = !!(old && old.ended); // putHighlight aggiorna old
  if (!ended && ends + 300000 < Date.now()) return; // la fine di questo sondaggio non è mai arrivata
  const h = putHighlight(id, {type: 'poll', poll: e, ended, expandable: true, draw: drawPoll,
    endsAt: ended ? 0 : ends, duration: ends - Date.parse(e.started_at), removeAt: (ended ? Date.now() : ends) + 300000});
  if (ended && !wasEnded) toggleHighlight(h, true);
}
function drawPoll(h) {
  const poll = h.poll, votes = c => c.votes || 0;
  const total = poll.choices.reduce((sum, c) => sum + votes(c), 0), top = Math.max(0, ...poll.choices.map(votes));
  const header = el('div', 'highlight__header');
  header.append(el('div', 'poll__status', h.ended ? 'Poll Ended' : 'Current Poll'), el('div', 'poll__title', poll.title));
  const more = moreButton([['Learn more about Polls', () => openLink('https://help.twitch.tv/s/article/how-to-use-polls')]]);
  more.classList.add('poll__more');
  const row = el('div', 'highlight__row');
  row.append(header, more, chevronButton(h));
  if (h.ended) row.append(closeButton(h));
  // finito: in ordine di voti; vincono tutte le scelte a pari merito in cima, se qualcuno ha votato
  const body = el('div', 'highlight__body poll__choices' + (h.ended && top ? ' has-winner' : ''));
  const shown = h.shares || {};
  h.shares = {};
  for (const c of h.ended ? poll.choices.slice().sort((a, b) => votes(b) - votes(a)) : poll.choices) {
    const share = total ? votes(c) / total : 0, winner = h.ended && top > 0 && votes(c) === top;
    h.shares[c.id] = share;
    const fill = el('div', 'poll-choice__fill');
    slide(fill, 'width', `${(shown[c.id] || 0) * 100}%`, `${share * 100}%`, 500, 'cubic-bezier(.215, .61, .355, 1)');
    const title = el('span', 'poll-choice__title');
    if (winner) title.append(svgIcon('i-trophy'));
    title.append(el('span', '', c.title));
    const choice = el('div', 'poll-choice' + (winner ? ' is-winner' : ''));
    choice.append(fill, title, el('span', 'poll-choice__votes', `${PERCENT.format(share)} (${NUMBER.format(votes(c))})`));
    body.append(choice);
  }
  return [row, body];
}

// --- pronostico (channel.prediction.*): compare all'inizio con l'intro viola che scorre, resta fino alla chiusura
// delle puntate (chiuse prima: "See Details"), torna come card del risultato per 120 s; annullato sparisce.
// Sempre "Channel Points" con l'icona predefinita: nome e icona dei punti del canale non hanno un'API.
function predictionHighlight(type, e) {
  const id = `prediction:${e.id}`, old = findHighlight(id);
  const phase = type.slice('channel.prediction.'.length); // begin, progress, lock, end
  if (phase === 'end' && e.status !== 'resolved') return dropHighlight(old);
  const pred = Object.assign({}, old && old.pred, e);
  pred.locks_at = e.locks_at || (old && old.pred.locks_at) || e.locked_at; // il lock non lo ripete: resta quello dell'inizio
  const resolved = phase === 'end', locks = Date.parse(pred.locks_at);
  if (!resolved && !(locks > Date.now())) return dropHighlight(old); // puntate chiuse: si aspetta il risultato
  const wasResolved = !!(old && old.resolved); // putHighlight aggiorna old
  const ends = resolved ? (wasResolved ? old.endsAt : Date.now() + 120000) : locks;
  const h = putHighlight(id, {type: 'prediction', pred, resolved, locked: phase === 'lock' || !!(old && old.locked),
    expandable: true, draw: drawPrediction, refresh: predictionLine, endsAt: ends, removeAt: ends,
    duration: resolved ? 120000 : locks - Date.parse(pred.started_at)});
  const winner = (pred.outcomes || []).find(o => o.id === pred.winning_outcome_id);
  if (resolved && !wasResolved)
    playOverlay(h, [predictionIntro(`Prediction result is "${winner ? winner.title : ''}"!`, 120)]);
  else if (phase === 'begin' && !old && locks - Date.now() >= 5000)
    playOverlay(h, [predictionIntro('Prediction Started!', 160), ...(locks - Date.now() >= 30000
      ? [predictionIntro('Win Channel Points if you make the correct prediction!', 120)] : [])]);
  // chiusa, con due esiti: la seconda riga si alterna ogni 4 s fra il titolo e "12.3K vs 4.5K"
  if (!h.ticker) h.ticker = setInterval(() => {
    if (h.expanded || h.resolved || h.overlay || (h.pred.outcomes || []).length !== 2) return;
    h.versus = !h.versus;
    predictionLine(h, true);
  }, 4000);
}
// intro: fascia viola con la sfera e la scritta che passa da destra a sinistra (px al secondo di Twitch)
const predictionIntro = (text, speed) => overlay => {
  overlay.classList.add('prediction-intro');
  const lane = el('div', 'prediction-intro__lane'), words = el('span', '', text);
  lane.append(words);
  overlay.append(svgIcon('i-predict'), lane);
  const from = lane.clientWidth, to = words.offsetWidth;
  if (!from) return 0; // card dietro a un'altra: niente intro
  const ms = (from + to) / speed * 1000;
  words.animate([{transform: `translateX(${from}px)`}, {transform: `translateX(${-to}px)`}], {duration: ms, fill: 'both'});
  return ms;
};
function drawPrediction(h) {
  const p = h.pred, outcomes = p.outcomes || [], winner = outcomes.find(o => o.id === p.winning_outcome_id);
  const header = el('div', 'highlight__header');
  header.append(el('div', 'prediction__label', h.resolved ? `${p.title} ${winner ? winner.title : ''}` : 'Predict with Channel Points'),
                el('div', 'prediction__line'));
  // "Predict" non può puntare da qui: apre i dettagli, come "See Details"
  const button = el('button', 'highlight__button', h.resolved || h.locked ? 'See Details' : 'Predict');
  button.onclick = event => { event.stopPropagation(); toggleHighlight(h); };
  const actions = el('div', 'prediction__actions');
  actions.append(button, moreButton([['How to Play', () => openLink('https://help.twitch.tv/s/article/channel-points-predictions')],
                                     ['Dismiss This Message', () => dropHighlight(h)]]));
  const row = el('div', 'highlight__row');
  row.append(header, actions);
  const body = el('div', 'highlight__body prediction__outcomes');
  const shown = h.points || {};
  h.points = {};
  outcomes.forEach((o, i) => {
    const points = o.channel_points || 0, count = el('span');
    h.points[o.id] = points;
    countUp(count, shown[o.id] || 0, points, 200, n => NUMBER.format(n));
    const amount = el('span', 'prediction-outcome__points');
    amount.append(svgIcon('i-points'), count);
    const line = el('div', 'prediction-outcome');
    line.append(el('span', 'prediction-outcome__n', `${i + 1}.`), el('span', 'prediction-outcome__title', o.title), amount);
    body.append(line);
  });
  return [row, body];
}
// seconda riga: il titolo, i punti "12.3K vs 4.5K" o, nel risultato, a chi vanno i punti
function predictionLine(h, animate) {
  const line = h.box.querySelector('.prediction__line');
  if (!line) return;
  if (h.expanded) h.versus = false;
  const p = h.pred, content = el('div', 'prediction__title');
  if (h.resolved) content.append(...predictionResult(p));
  else if (h.versus) (p.outcomes || []).forEach((o, i) => {
    if (i) content.append(el('span', 'prediction__vs', 'vs'));
    const points = el('span', 'prediction__points');
    points.append(svgIcon('i-points'), COMPACT.format(o.channel_points || 0));
    content.append(points);
  });
  else content.textContent = p.title;
  line.replaceChildren(content);
  if (animate) content.animate([{opacity: 0, transform: 'translateY(100%)'}, {opacity: 1, transform: 'none'}], {duration: 150, easing: 'ease'});
}
function predictionResult(p) {
  const outcomes = p.outcomes || [], winner = outcomes.find(o => o.id === p.winning_outcome_id) || {};
  const users = winner.users || 0, top = (winner.top_predictors || []).map(u => u.user_name);
  if (!users) return ['Nobody thought this would happen'];
  if (!top[0]) return [];
  const points = el('span', 'prediction__points is-small');
  points.append(svgIcon('i-points'), COMPACT.format(outcomes.reduce((sum, o) => sum + (o.channel_points || 0), 0)));
  return [points, ` go to ${top[0]}${users === 1 ? '' : users === 2 ? ` and ${top[1] || '1 other'}` : ` and ${users - 1} others`}`];
}

// --- Hype Train (channel.hype_train.*, v2 o v1): fisso sopra alle card, tutto il riquadro è la barra del livello.
// All'inizio, a ogni livello e alla fine passa il trenino con le emote, poi livello, tempo e percentuale. Colore del
// creatore, emote in premio, conducenti e totali finali non arrivano da EventSub: non ci sono.
const HYPE_CAR = 'https://static-cdn.jtvnw.net/emoticons/v2/81273/default/dark/2.0'; // KomodoHype
const GOLD_COIN = 'https://static-cdn.jtvnw.net/twilight-static-assets/Hype_Train_Banner_Icon_Gold_Coin.png';
const isGolden = t => t.type === 'golden_kappa' || !!t.is_golden_kappa_train;
const hypePercent = t => Math.floor(Math.min(1, (t.progress || 0) / (t.goal || 1)) * 100);
const hypeRecord = t => t.all_time_high_total > 0 && t.total >= t.all_time_high_total && !isGolden(t);
function hypeName(t) {
  if (t.is_shared_train) return isGolden(t) ? 'Shared Golden Kappa Train' : 'Shared Hype Train';
  return isGolden(t) ? 'Golden Kappa Train' : t.type === 'treasure' ? 'Treasure Train' : 'Hype Train';
}
function hypeHighlight(type, e) {
  const old = findHighlight('hype-train'), phase = type.slice('channel.hype_train.'.length);
  if (phase !== 'end' && !(Date.parse(e.expires_at) > Date.now())) return dropHighlight(old); // treno già scaduto
  const train = Object.assign({}, old && old.train, e); // record e ultimo progresso restano dagli eventi prima
  const level = old && old.train.level; // putHighlight aggiorna old
  const h = putHighlight('hype-train', {type: 'hype-train', sticky: true, train, draw: drawHype,
    removeAt: phase === 'end' ? Date.now() + 13000 : Date.parse(e.expires_at) + 60000});
  const name = hypeName(train);
  if (phase === 'begin' && !old) playOverlay(h, [hypeCars(`${name} ${train.is_shared_train ? 'starting!' : 'incoming!'}`, 7000),
    hypeText([isGolden(train) ? "You'll have a limited time to earn an exclusive Golden Kappa emote for 24 hrs"
      : train.is_shared_train ? 'Collaborate to achieve higher levels and unlock more emotes!'
      : train.type === 'treasure' ? 'Woah, this is a rare Treasure Train!' : "You'll have a limited time to earn exclusive emotes"], 4000)]);
  else if (phase === 'progress' && e.level > level)
    playOverlay(h, [hypeCars('Hyyyyypeeee', 8000), hypeText([`Level ${level} complete!`], 4000)]);
  else if (phase === 'end') playOverlay(h, [hypeCars(`${name} success!`, 6000), () => 1000,
    hypeText(['Such strong support', `${name} Complete! Level ${train.level}, ${hypePercent(train)}%`], 6000)]);
  if (!h.ticker) h.ticker = setInterval(() => {
    const time = h.box.querySelector('.hype-train__time');
    if (time) time.textContent = hypeClock(h.train);
  }, 1000);
}
function hypeClock(t) {
  const s = Math.max(0, Math.floor((Date.parse(t.expires_at) - Date.now() - 500) / 1000)) || 0;
  const pad = n => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
const hypeCars = (text, ms) => overlay => {
  overlay.classList.add('hype-train__marquee');
  const cars = el('div', 'hype-train__cars', text);
  for (let i = 0; i < 4; i++) {
    const car = el('img');
    car.src = HYPE_CAR;
    car.alt = '';
    cars.append(car);
  }
  cars.style.animationDuration = `${ms}ms`;
  overlay.append(cars);
  return ms;
};
const hypeText = (lines, ms) => overlay => {
  overlay.classList.add('hype-train__message');
  for (const line of lines) overlay.append(el('div', '', line));
  return ms;
};
function drawHype(h) {
  const t = h.train, record = hypeRecord(t), percent = hypePercent(t);
  h.node.classList.toggle('is-golden', isGolden(t));
  h.node.classList.toggle('is-record', record);
  h.node.classList.toggle('is-shared', !!t.is_shared_train && !isGolden(t));
  const fill = el('div', 'hype-train__fill');
  slide(fill, 'transform', `scaleX(${(h.percent || 0) / 100})`, `scaleX(${percent / 100})`, 2000, 'cubic-bezier(.33, 0, .1, 1)');
  const title = el('div', 'hype-train__title');
  title.append(el('span', t.is_shared_train ? 'hype-train__shared' : '', record ? (t.is_shared_train ? 'New Shared Record' : 'New Record') : hypeName(t)));
  const level = el('div', 'hype-train__level');
  if (record) level.append(svgIcon('i-trophy'));
  else if (t.type === 'treasure') {
    const coin = el('img', 'hype-train__coin');
    coin.src = GOLD_COIN;
    coin.alt = '';
    level.append(coin);
  }
  level.append(`Lvl ${t.level}`);
  const count = el('div', 'hype-train__percent');
  countUp(count, h.percent || 0, percent, 4000, n => `${n}%`);
  h.percent = percent;
  const left = el('div', 'hype-train__column'), right = el('div', 'hype-train__column is-end');
  left.append(title, level);
  right.append(el('div', 'hype-train__time', hypeClock(t)), count);
  const info = el('div', 'hype-train__info');
  info.append(left, right);
  return [fill, info];
}

// --- messaggio fissato (Helix /chat/pins, il plugin lo manda quando cambia): appena fissato si apre e si richiude dopo
// 15 s se non lo tocchi; "Hide for yourself" lo nasconde solo qui. Senza messaggi fissati la card sparisce.
const hiddenPins = new Set();
const PIN_BADGE = {broadcaster: 'https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1/1',
                   moderator: 'https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1'};
function onPins(response) {
  const pins = ((response && response.data) || []).filter(pin => !hiddenPins.has(pin.message_id));
  for (const h of highlights.filter(h => h.type === 'pinned' && !pins.some(pin => h.id === `pin:${pin.message_id}`))) dropHighlight(h);
  for (const pin of pins) {
    const id = `pin:${pin.message_id}`, fresh = !findHighlight(id), ends = pin.ends_at ? Date.parse(pin.ends_at) : 0;
    if (ends && ends <= Date.now()) continue;
    const h = putHighlight(id, {type: 'pinned', pin, expandable: true, draw: drawPinned, refresh: maskPinned,
      endsAt: ends, removeAt: ends, timerView: 'open', duration: ends - Date.parse(pin.starts_at)});
    if (!fresh) continue;
    toggleHighlight(h, true);
    h.collapseTimer = setTimeout(() => { if (!h.touched) toggleHighlight(h, false); }, 15000);
  }
}
function drawPinned(h) {
  const pin = h.pin, m = messageIndex.get(pin.message_id); // la riga in chat, se c'è: colore, badge e ora
  const by = el('div', 'pinned__by');
  const badge = el('img', 'pinned__badge');
  badge.src = pin.pinned_by_user_login === ($('twitch-channel').value || '').trim().toLowerCase() ? PIN_BADGE.broadcaster : PIN_BADGE.moderator;
  badge.alt = '';
  by.append(svgIcon('i-pin'), badge, el('span', '', `Pinned by ${pin.pinned_by_user_name}`));
  const text = el('div', 'pinned__message');
  const message = pin.message || {};
  for (const part of message.fragments || [{text: message.text || ''}]) {
    if (part.type !== 'emote' || !part.emote) { text.append(part.text || ''); continue; }
    const img = el('img', 'pinned__emote');
    img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${part.emote.id}/default/dark/1.0`;
    img.srcset = `${img.src} 1x, ${img.src.slice(0, -3)}2.0 2x, ${img.src.slice(0, -3)}3.0 4x`;
    img.alt = img.title = part.text;
    text.append(img);
  }
  const sender = {platform: 'twitch', name: pin.sender_user_name, color: m && m.color};
  const name = el('b', 'pinned__sender', pin.sender_user_name);
  name.style.color = options.readable ? readable(nameColor(sender)) : nameColor(sender);
  const meta = el('div', 'highlight__body pinned__meta');
  meta.append(...(m ? m.badges || [] : []).map(badgeImage), name);
  if (m) meta.append(` sent at ${new Date(m.time).toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit'})}`);
  const column = el('div', 'pinned__column');
  column.append(by, text, meta);
  const scroll = el('div', 'pinned__scroll');
  scroll.append(column);
  const hide = iconButton('i-eye-slash', 'Hide for yourself', () => { hiddenPins.add(pin.message_id); dropHighlight(h); });
  hide.classList.add('pinned__hide');
  const tools = el('div', 'pinned__tools');
  tools.append(hide, chevronButton(h));
  return [scroll, tools];
}
// aperto e più lungo di 200px: il testo sfuma in fondo, come su Twitch
function maskPinned(h) {
  const scroll = h.box.querySelector('.pinned__scroll');
  requestAnimationFrame(() => scroll.classList.toggle('is-scrollable', scroll.scrollHeight > scroll.clientHeight));
}

function onHighlight(data) {
  const type = data.type || '', event = data.event || {};
  if (type.startsWith('channel.poll.')) pollHighlight(type, event);
  else if (type.startsWith('channel.prediction.')) predictionHighlight(type, event);
  else if (type.startsWith('channel.hype_train.')) hypeHighlight(type, event);
}
stream.addEventListener('highlight', event => onHighlight(JSON.parse(event.data)));
stream.addEventListener('pins', event => onPins(JSON.parse(event.data)));
new ResizeObserver(fitMessages).observe(cardBox);

// /demo: un esempio per tipo, uno dopo l'altro così si vedono tutti (circa 80 s). Gli eventi sono finti ma hanno la
// forma di quelli di EventSub e Helix e passano dagli stessi gestori: niente va al plugin o a Twitch.
function demoHighlights(me) {
  const t0 = Date.now(), at = (s, run) => setTimeout(run, s * 1000), iso = s => new Date(t0 + s * 1000).toISOString();
  const channel = {broadcaster_user_id: 'demo', broadcaster_user_login: me.toLowerCase(), broadcaster_user_name: me};
  const who = name => ({user_id: name, user_login: name.toLowerCase(), user_name: name});
  // Hype Train: inizio, livello 2, fine
  const train = {id: 'demo-train', ...channel, top_contributions: [{...who('BigSpender'), type: 'subscription', total: 1500}],
                 shared_train_participants: null, type: 'regular', is_shared_train: false};
  at(1, () => onHighlight({type: 'channel.hype_train.begin', event: {...train, level: 1, total: 350, progress: 350, goal: 1600,
    all_time_high_level: 3, all_time_high_total: 9000, started_at: iso(1), expires_at: iso(300)}}));
  at(14, () => onHighlight({type: 'channel.hype_train.progress', event: {...train, level: 2, total: 2000, progress: 400, goal: 1800,
    started_at: iso(1), expires_at: iso(314)}}));
  at(44, () => onHighlight({type: 'channel.hype_train.end', event: {...train, level: 2, total: 2000, started_at: iso(1),
    ended_at: iso(44), cooldown_ends_at: iso(3644)}}));
  // sondaggio: inizio, voti, fine con un vincitore
  const poll = {id: 'demo-poll', ...channel, title: 'Which map should we play next?', bits_voting: {is_enabled: false, amount_per_vote: 0},
                channel_points_voting: {is_enabled: true, amount_per_vote: 100}, started_at: iso(5)};
  const choices = votes => [['Dust II', 412], ['Mirage', 1234], ['Inferno', 873]].map(([title, n], i) =>
    ({id: `demo-c${i}`, title, ...(votes ? {votes: Math.round(n * votes), channel_points_votes: Math.round(n * votes), bits_votes: 0} : {})}));
  at(5, () => onHighlight({type: 'channel.poll.begin', event: {...poll, choices: choices(0), ends_at: iso(95)}}));
  at(9, () => onHighlight({type: 'channel.poll.progress', event: {...poll, choices: choices(0.6), ends_at: iso(95)}}));
  at(17, () => onHighlight({type: 'channel.poll.end', event: {...poll, choices: choices(1), status: 'completed', ended_at: iso(17)}}));
  // pronostico: inizio, puntate, chiusura anticipata, risultato
  const prediction = {id: 'demo-prediction', ...channel, title: 'Will we win this round?', started_at: iso(22)};
  const outcomes = (done, won) => [
    {id: 'demo-o1', title: 'Yes, easy win', color: 'blue', ...(done ? {users: 25, channel_points: 12345, top_predictors: [
      {...who('Luna'), channel_points_used: 5000, channel_points_won: won ? 9800 : null},
      {...who('RiZing_tv'), channel_points_used: 2500, channel_points_won: won ? 4900 : null}]} : {})},
    {id: 'demo-o2', title: 'No way', color: 'pink', ...(done ? {users: 11, channel_points: 4520, top_predictors: [
      {...who('Troublemaker'), channel_points_used: 2000, channel_points_won: won ? 0 : null}]} : {})}];
  at(22, () => onHighlight({type: 'channel.prediction.begin', event: {...prediction, outcomes: outcomes(false), locks_at: iso(67)}}));
  at(30, () => onHighlight({type: 'channel.prediction.progress', event: {...prediction, outcomes: outcomes(true), locks_at: iso(67)}}));
  at(36, () => onHighlight({type: 'channel.prediction.lock', event: {...prediction, outcomes: outcomes(true), locked_at: iso(36)}}));
  at(42, () => onHighlight({type: 'channel.prediction.end', event: {...prediction, outcomes: outcomes(true, true),
    winning_outcome_id: 'demo-o1', status: 'resolved', ended_at: iso(42)}}));
  // messaggio fissato: quello di Luna con l'emote, fissato da te
  at(52, () => onPins({data: [{message_id: 'd8', sender_user_id: 'd8', sender_user_login: 'luna', sender_user_name: 'Luna',
    pinned_by_user_id: 'demo', pinned_by_user_login: me.toLowerCase(), pinned_by_user_name: me,
    message: {text: 'that one is a keeper Kappa', fragments: [{type: 'text', text: 'that one is a keeper '},
      {type: 'emote', text: 'Kappa', emote: {id: '25', emote_set_id: '0'}}]},
    starts_at: iso(52), ends_at: iso(142), updated_at: iso(52)}]}));
  // regalo più grande (il primo, da 5, è fra le righe della demo): sfondo sfumato e coriandoli
  at(60, () => addMessage({platform: 'twitch', id: 'd21', userId: 'd21', name: 'GenerousViewer', color: '#daa520', text: '', badges: [],
    emotes: [], time: Date.now(), eventId: 'submysterygift', eventPlan: '1000', eventCount: '25', eventTotal: '40', demo: true}));
}
