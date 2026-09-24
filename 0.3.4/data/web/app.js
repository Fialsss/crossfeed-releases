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

function sourceIcon(platform) {
  const span = document.createElement('span');
  span.className = `chat-line__source ${platform}`;
  span.title = platform === 'twitch' ? 'Twitch' : 'TikTok';
  span.innerHTML = `<svg><use href="#i-${platform}"/></svg>`;
  return span;
}

function badgeImage(badge) {
  const img = document.createElement('img');
  img.className = 'chat-badge';
  img.src = badge.url;
  img.alt = badge.title || '';
  img.title = badge.title || '';
  return img;
}

// Sostituisce le emote nel testo lavorando per code point, come fa Twitch con i suoi indici.
function messageBody(m) {
  const body = document.createElement('span');
  body.className = 'chat-line__message';
  const points = Array.from(m.text || '');
  const emotes = (m.emotes || []).slice().sort((a, b) => a.start - b.start);
  let position = 0;
  for (const emote of emotes) {
    if (emote.start < position || emote.end >= points.length) continue;
    body.append(document.createTextNode(points.slice(position, emote.start).join('')));
    const img = document.createElement('img');
    img.className = 'chat-emote';
    img.src = emote.url;
    img.alt = points.slice(emote.start, emote.end + 1).join('');
    img.title = img.alt;
    body.append(img);
    position = emote.end + 1;
  }
  body.append(document.createTextNode(points.slice(position).join('')));
  boldMentions(body);
  return body;
}

// @nome in grassetto (e con sfondo se sei tu), come nella chat di Twitch.
function boldMentions(body) {
  const me = ((account && account.login) || $('twitch-channel').value || '').toLowerCase();
  for (const node of [...body.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue.includes('@')) continue;
    const parts = node.nodeValue.split(/(@[A-Za-z0-9_]+)/);
    if (parts.length === 1) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (/^@[A-Za-z0-9_]+$/.test(part)) {
        const strong = document.createElement('span');
        strong.className = 'chat-line__mention' + (part.slice(1).toLowerCase() === me ? ' is-me' : '');
        strong.textContent = part;
        fragment.append(strong);
      } else if (part) {
        fragment.append(document.createTextNode(part));
      }
    }
    node.replaceWith(fragment);
  }
}

// Icone moderatore davanti al messaggio: ban, timeout 10 min, elimina. Sui propri messaggi solo elimina.
function modIcons(m) {
  const wrap = document.createElement('span');
  wrap.className = 'mod-icons';
  const mine = account && m.name && m.name.toLowerCase() === (account.login || '').toLowerCase();
  const tools = mine
    ? [['delete', 'i-trash', 'Delete Message']]
    : [['ban', 'i-ban', 'Ban User'], ['timeout', 'i-timeout', 'Timeout for 10 Minutes'], ['delete', 'i-trash', 'Delete Message']];
  for (const [action, icon, title] of tools) {
    const button = document.createElement('button');
    button.title = title;
    button.innerHTML = `<svg><use href="#${icon}"/></svg>`;
    button.onclick = event => {
      event.stopPropagation();
      noteRecentMod();
      post('/api/moderate', {action, platform: m.platform, id: m.id, userId: m.userId, name: m.name})
        .then(result => {
          if (result.error) {
            const line = document.createElement('div');
            line.className = 'chat-line is-system';
            const body = document.createElement('span');
            body.className = 'chat-line__message';
            body.textContent = `Action failed: ${result.error}`;
            line.append(body);
            messages.append(line);
            scrollDown();
          }
        });
    };
    wrap.append(button);
  }
  return wrap;
}

// Frasi degli eventi, parola per parola come la chat italiana di Twitch.
function eventSentence(m) {
  const level = 'Tier ' + (m.eventPlan === '2000' ? '2' : m.eventPlan === '3000' ? '3' : '1');
  const plan = m.eventPlan === 'Prime' ? ['with ', {plan: 'Prime'}] : ['at ' + level];
  const channel = ($('twitch-channel').value || 'this channel').trim();
  switch (m.eventId) {
    case 'sub':
      return {icon: m.eventPlan === 'Prime' ? 'i-prime' : 'i-star', parts: ['subscribed ', ...plan, '.']};
    case 'resub':
      return {icon: m.eventPlan === 'Prime' ? 'i-prime' : 'i-star', parts: ['subscribed ', ...plan, ". They've subscribed for ", {b: `${m.eventMonths || 1} months`}, '!']};
    case 'subgift':
      return {icon: 'i-gift', inlineName: true, parts: [`gifted a ${level} sub to `, {b: m.eventRecipient || 'someone'}, '!']};
    case 'submysterygift': {
      const count = parseInt(m.eventCount || '1', 10) || 1;
      const total = parseInt(m.eventTotal || '0', 10);
      const tail = total > count ? ` They have gifted a total of ${total} subscriptions in the channel!`
        : ' This is their first gifted subscription in the channel!';
      return {icon: 'i-gift', parts: [`is gifting ${count} ${count === 1 ? 'subscription' : 'subscriptions'} ${level} to the community of ${channel}!${tail}`]};
    }
    case 'giftpaidupgrade':
    case 'anongiftpaidupgrade':
      return {icon: 'i-star', parts: ['is continuing the Gift Sub they got!']};
    case 'raid':
      return {icon: 'i-raid', parts: ['is raiding with a party of ', {b: m.eventViewers || 'several'}, ' viewers!']};
    case 'unraid':
      return {icon: 'i-raid', parts: ['cancelled the raid.']};
    case 'announcement':
      return {icon: 'i-megaphone', title: 'Announcement', parts: []};
    case 'gift': // gift TikTok
      return {icon: 'i-gift', parts: ['sent ', {b: `${m.eventCount || 1} × ${m.eventText || 'gift'}`},
        m.eventTotal && m.eventTotal !== '0' ? ` (${m.eventTotal} diamonds)` : '']};
    case 'like': { // like TikTok, accorpati per persona (vedi mergeLike)
      const count = parseInt(m.eventCount || '1', 10) || 1;
      return {icon: 'i-heart', inlineName: true, parts: count > 1 ? ['liked the LIVE ', {b: `\u00d7${count}`}] : ['liked the LIVE']};
    }
    case 'bitsbadgetier':
      return {icon: 'i-bits', parts: ['unlocked a new Bits badge!']};
    default:
      // evento che non conosciamo: la frase originale di Twitch così com'è
      return {icon: 'i-star', title: '', parts: [m.eventText || m.eventId]};
  }
}

function visible(m) {
  return filter === 'all' || m.platform === filter;
}

const chatters = new Map(); // nome -> ultima volta che ha scritto, per i suggerimenti con @

function mentionsMe(text) {
  const me = (account && account.login) || '';
  const channel = ($('twitch-channel').value || '').toLowerCase();
  const needle = (me || channel).toLowerCase();
  if (!needle) return false;
  return new RegExp('@' + needle + '\\b', 'i').test(text || '');
}

// Like TikTok: arrivano a raffica (TikTok raggruppa i tocchi). Una riga per persona che si aggiorna
// finche' continua a toccare, invece di riempire la chat.
const likeLines = new Map(); // utente -> {line, count, at}
const likeKey = m => m.userId || m.name;
function mergeLike(m) {
  const open = likeLines.get(likeKey(m));
  if (!open || !open.line.isConnected || Date.now() - open.at > 60000) return false;
  open.count += parseInt(m.eventCount || '1', 10) || 1;
  open.at = Date.now();
  const text = open.line.querySelector('.chat-line__event');
  const who = text.querySelector('b');
  text.replaceChildren(who);
  appendParts(text, eventSentence({...m, eventCount: String(open.count)}).parts);
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
    const who = document.createElement('b');
    who.textContent = next.name;
    joinLine.replaceChildren(sourceIcon('tiktok'), who, document.createTextNode(' joined'));
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

function addMessage(m) {
  if (m.platform === 'tiktok' && m.eventId === 'join') return showJoin(m);
  if (m.platform === 'tiktok' && (m.eventId === 'follow' || m.eventId === 'share')) return;
  if (m.platform === 'tiktok' && m.eventId === 'like' && mergeLike(m)) return;
  // alla riconnessione TikTok rimanda gli ultimi commenti: gia' mostrati, non si ripetono
  if (m.id && m.id !== 'local' && messageIndex.has(m.id)) return;
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
  if (mentionsMe(m.text)) line.classList.add('is-mention');
  if (m.firstMessage || m.returningChatter) line.classList.add('is-first');
  line.dataset.id = m.id;
  line.dataset.platform = m.platform;
  line.dataset.userId = m.userId || '';
  line.dataset.name = m.name;
  line.hidden = !visible(m);

  if (m.firstMessage || m.returningChatter || mentionsMe(m.text)) {
    const tag = document.createElement('span');
    tag.className = 'chat-line__tag';
    tag.textContent = m.firstMessage ? 'First message in the channel'
      : m.returningChatter ? 'Returning chatter'
      : 'Mentioned you';
    line.append(tag);
  }

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
    line.append(reply);
  }

  // Eventi del canale: subscriptions, gifts, raid, annunci. Stessa struttura di Twitch:
  // icona a sinistra, nome in grassetto, frase con le parti in grassetto, card con bordo viola.
  if (m.eventId) {
    line.classList.add('is-event');
    if (m.eventId === 'like') line.classList.add('is-like');
    if (m.eventId === 'announcement')
      line.classList.add('is-announcement', 'color-' + (m.eventColor || 'PRIMARY'));
    const sentence = eventSentence(m); // {icon, inlineName, title, parts:[testo | {b} | {plan}]}
    const icon = document.createElement('span');
    icon.className = 'event-icon' + (sentence.icon === 'i-prime' ? ' prime' : '');
    icon.innerHTML = `<svg><use href="#${sentence.icon}"/></svg>`;
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
      const body = document.createElement('div');
      body.className = 'event-body';
      if (m.eventId === 'announcement') {
        // l'annuncio è un messaggio normale dentro la card: badge, nome, testo
        for (const badge of m.badges || []) body.append(badgeImage(badge));
        const author = document.createElement('span');
        author.className = 'chat-author';
        author.style.color = m.color || '#efeff1';
        author.textContent = m.name;
        body.append(author, document.createTextNode(': '));
      }
      body.append(messageBody(m));
      line.append(body);
    }
  } else {
    if (m.bits) line.classList.add('is-cheer');
    const time = document.createElement('span');
    time.className = 'chat-line__timestamp';
    time.textContent = new Date(m.time || Date.now())
      .toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit'});
    line.append(time);
    if (account && m.platform === 'twitch' && m.id && m.id !== 'local') line.append(modIcons(m));
    line.append(sourceIcon(m.platform));

    for (const badge of m.badges || []) line.append(badgeImage(badge));

    const author = document.createElement('span');
    author.className = 'chat-author';
    author.style.color = m.color || '#efeff1';
    author.textContent = m.name;
    line.append(author, document.createTextNode(m.action ? ' ' : ': '), messageBody(m));

    if (m.bits) {
      const bits = document.createElement('span');
      bits.className = 'chat-line__bits';
      bits.textContent = `${m.bits} bit`;
      line.append(bits);
    }
    if (m.platform === 'twitch' && m.id && m.id !== 'local') {
      const reply = document.createElement('button');
      reply.className = 'reply-button';
      reply.innerHTML = '<svg><use href="#i-reply"/></svg>';
      reply.onclick = event => {
        event.stopPropagation();
        if (m.replyParentId || threads.has(m.id)) openThread(m);
        else startReply(m);
      };
      line.append(reply);
    }
  }

  // clic sul nome: scheda utente come su Twitch
  for (const author of line.querySelectorAll('.chat-author'))
    author.onclick = event => { event.stopPropagation(); openViewerCard(m); };

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
    body.textContent = `Welcome to the chat room for ${channel || 'this channel'}!`;
    line.append(body);
    messages.append(line);
    scrollDown();
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
  for (const author of line.querySelectorAll('.chat-author'))
    author.onclick = event => { event.stopPropagation(); openViewerCard(m); };

  const stick = !paused && atBottom();
  messages.append(line);
  if (stick) scrollDown();
});
stream.addEventListener('automod', event => {
  const info = JSON.parse(event.data);
  const state = $('automod-state');
  if (state) state.textContent = info.detail || '';
});

// Chi ha fatto l'ultima azione dal pannello: Twitch IRC non dice il moderatore, ma se sono stato io lo so.
let recentMod = {at: 0, login: ''};
function noteRecentMod() { if (account) recentMod = {at: Date.now(), login: account.login}; }

// Nota di Twitch accanto al messaggio eliminato (stringhe della sua traduzione italiana).
function deletedNote(data) {
  const mod = Date.now() - recentMod.at < 8000 ? recentMod.login : '';
  if (!mod) return '(Deleted by a moderator)';
  if (data.id) return `(Deleted by ${mod})`;
  if (data.duration) return `(Timed out for ${data.duration} by ${mod})`;
  return `(Banned by ${mod})`;
}

// Segna la riga come eliminata come fa Twitch: messaggio in alt-2 (barrato in "Detailed" con la nota),
// oppure "<message deleted>" cliccabile in "Breve".
function markDeleted(line, note) {
  line.classList.add('is-deleted');
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
  for (const line of [...messages.children]) {
    const matchesUser = data.userId && line.dataset.userId === data.userId;
    const matchesId = data.id && line.dataset.id === data.id;
    if (line.dataset.platform === data.platform && (matchesId || matchesUser || (!data.id && !data.userId))) {
      markDeleted(line, note);
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
  }
  if (!data.id && !data.userId) {
    const status = document.createElement('div');
    status.className = 'chat-line chat-line__status';
    status.textContent = 'Chat was cleared by a moderator';
    messages.append(status);
    scrollDown();
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
  if (data.id) body.append('A message from ', who, ' was deleted.');
  else if (!data.userId) {
    const mod = Date.now() - recentMod.at < 8000 ? recentMod.login : '';
    if (!mod) return; // Twitch la attribuisce a chi l'ha fatto; senza nome basta la riga di stato
    body.append(el('b', '', mod), ' cleared this channel’s chat for non-moderators.');
  }
  else if (data.duration) body.append(who, ` was timed out for ${durationText(Number(data.duration))}.`);
  else body.append(who, ' was banned.');
  line.append(body);
  messages.append(line);
  scrollDown();
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
  const now = Date.now();
  const me = ($('twitch-channel').value || 'fialss_').trim();
  const rows = [
    {platform: 'twitch', id: 'd1', userId: 'd1', name: 'NewViewer', color: '#1e90ff', text: 'Hi everyone, first time here!', badges: [], emotes: [], time: now, firstMessage: true},
    {platform: 'twitch', id: 'd2', userId: 'd2', name: 'Luna', color: '#ff69b4', text: `@${me} that jump was impossible`, badges: [{url: '/badge/vip.png', title: 'VIP'}], emotes: [], time: now},
    {platform: 'twitch', id: 'd3', userId: 'd3', name: 'RiZing_tv', color: '#a970ff', text: 'twelve months!', badges: [{url: '/badge/subscriber.png', title: 'Subscriber'}], emotes: [], time: now, eventId: 'resub', eventPlan: 'Prime', eventMonths: '12'},
    {platform: 'twitch', id: 'd4', userId: 'd4', name: 'Babbo', color: '#00ff7f', text: '', badges: [], emotes: [], time: now, eventId: 'submysterygift', eventPlan: '1000', eventCount: '1', eventTotal: '1'},
    {platform: 'twitch', id: 'd4b', userId: 'd4', name: 'Gifter', color: '#00ff7f', text: '', badges: [], emotes: [], time: now, eventId: 'subgift', eventPlan: '1000', eventRecipient: 'LuckyViewer'},
    {platform: 'twitch', id: 'd5', userId: 'd5', name: 'StreamerFriend', color: '#ff7f50', text: '', badges: [], emotes: [], time: now, eventId: 'raid', eventViewers: '42'},
    {platform: 'twitch', id: 'd6', userId: 'd6', name: 'GenerousViewer', color: '#daa520', text: 'Great stream!', badges: [], emotes: [], time: now, bits: 100},
    {platform: 'twitch', id: 'd7', userId: 'd7', name: me, color: '#9147ff', text: 'We are playing late tonight', badges: [{url: '/badge/broadcaster.png', title: 'Streamer'}], emotes: [], time: now, eventId: 'announcement', eventColor: 'BLUE'},
    {platform: 'twitch', id: 'd8', userId: 'd8', name: 'Luna', color: '#ff69b4', text: 'that one is a keeper Kappa', badges: [{url: '/badge/vip.png', title: 'VIP'}], emotes: [{start: 20, end: 24, url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'}], time: now, replyTo: me, replyText: 'We are playing late tonight'},
    {platform: 'tiktok', id: 'd9', userId: 'd9', name: 'giulia', color: '#75c8f1', text: 'Hi! First time here 👋', badges: [], emotes: [], time: now},
    {platform: 'tiktok', id: 'd9l', userId: 'd9', name: 'giulia', text: '', badges: [], emotes: [], time: now, eventId: 'like', eventCount: '1'},
    {platform: 'tiktok', id: 'd9e', userId: 'd9e', name: 'marco_tt', color: '#daa520', text: '[emote]', badges: [], emotes: [{start: 0, end: 6, url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'}], time: now},
    {platform: 'tiktok', id: 'd9m', userId: 'd9', name: 'giulia', text: '', badges: [], emotes: [], time: now, eventId: 'like', eventCount: '11'},
    {platform: 'twitch', id: 'd10', userId: 'd10', name: 'Troublemaker', color: '#b22222', text: 'message later deleted by a moderator', badges: [], emotes: [], time: now},
  ];
  for (const row of rows) addMessage(row);
  ['marco', 'andrea', 'riccardo'].forEach((name, i) =>
    setTimeout(() => addMessage({platform: 'tiktok', name, eventId: 'join'}), 400 + i * 900));
  const gone = messages.querySelector('.chat-line[data-id="d10"]');
  if (gone) markDeleted(gone, `(Deleted by ${me})`);
  if (options.modactions) modActionNotice({userId: 'd10', duration: '600'}, 'Molesto');
  const note = document.createElement('div');
  note.className = 'chat-line is-system';
  const body = document.createElement('span');
  body.className = 'chat-line__message';
  body.textContent = 'Samples are shown only here. Nothing was sent to Twitch.';
  note.append(body);
  messages.append(note);
  scrollDown();
}

// Risposta in thread: barra "Rispondendo a @nome" sopra la casella, come su Twitch.
let replyTarget = null;
function startReply(m) {
  if (!account) return;
  replyTarget = {id: m.id, name: m.name};
  $('reply-label').textContent = `Replying to @${m.name}:`;
  // il messaggio a cui si risponde, come lo mostra Twitch sopra la casella
  const quote = $('reply-quote');
  quote.innerHTML = '';
  for (const badge of m.badges || []) quote.append(badgeImage(badge));
  const author = document.createElement('span');
  author.className = 'chat-author';
  author.style.color = m.color || '#efeff1';
  author.textContent = m.name;
  quote.append(author, document.createTextNode(': '), messageBody(m));
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
    if (!info) return;
    const line = document.createElement('div');
    line.className = 'chat-line is-system';
    const body = document.createElement('span');
    body.className = 'chat-line__message';
    body.textContent = info;
    line.append(body);
    messages.append(line);
    scrollDown();
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
  if (chattersLoaded || !account || account.needsReauth) return;
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

// impostazioni dell'aspetto, salvate nel pannello
const view = $('messages');
const options = {badges: true, time: true, modactions: true, alternate: false, deleted: 'detail',
                 size: '14', aria: false, pause: 'scroll', readable: true,
                 automodCat: true, automodStd: true, automodTerms: true, automodLinks: true};

function applyOptions() {
  view.classList.toggle('no-modicons', !options.badges);
  view.classList.toggle('no-time', !options.time);
  view.classList.toggle('alternate', options.alternate);
  if (options.deleted === 'strike') options.deleted = 'brief';
  view.classList.remove('deleted-hide', 'deleted-detail', 'deleted-brief');
  view.classList.add('deleted-' + (['hide', 'detail', 'brief'].includes(options.deleted) ? options.deleted : 'detail'));
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
  view.classList.toggle('readable-names', options.readable);
  localStorage.setItem('fialss-chat-options', JSON.stringify(options));
}

try {
  Object.assign(options, JSON.parse(localStorage.getItem('fialss-chat-options') || '{}'));
} catch { /* preferenze illeggibili: si riparte da quelle predefinite */ }

$('opt-badges').checked = options.badges;
$('opt-time').checked = options.time;
$('opt-modactions').checked = options.modactions;
$('opt-alternate').checked = options.alternate;
$('opt-deleted').value = options.deleted;
$('opt-zoom').value = String(options.zoom || 100);
applyOptions();

$('opt-badges').onchange = e => { options.badges = e.target.checked; applyOptions(); };
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
    }).then(result => {
      if (result.error)
        addMessage({platform: 'twitch', id: 'local', name: 'Crossfeed', color: '#adadb8',
                    text: `Action failed: ${result.error}`, badges: [], emotes: [], time: Date.now()});
    });
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
  messages.append(line);
  scrollDown();
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
    section.append(el('h5', 'viewer-card__title', 'Stemmi'));
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
        line.append(el('span', 'chat-line__timestamp', new Date(msg.time || Date.now()).toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit'})));
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
  const author = document.createElement('span');
  author.className = 'chat-author';
  author.style.color = m.color || '#efeff1';
  author.textContent = m.name;
  line.append(author, document.createTextNode(': '), messageBody(m));
  return line;
}

// Apre la discussione a cui appartiene il messaggio e imposta la risposta verso quel messaggio.
function openThread(m) {
  if (!account) return;
  const tid = m.replyThreadId || m.replyParentId || m.id;
  const root = messageIndex.get(tid) ||
    (m.replyParentId === tid ? {name: m.replyTo || '?', text: m.replyText || '', badges: [], emotes: []} : m);
  replyTarget = {id: m.id, name: m.name};
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
