// Setup Wizard: schede in sequenza che preparano Crossfeed per le piattaforme scelte.
// Usa le stesse rotte dei pannelli (/api/config, /api/account, /api/feed-config) più /api/setup-done.
const token = new URLSearchParams(location.search).get('t') || '';
const $ = id => document.getElementById(id);

function post(path, data) {
  return fetch(`${path}?t=${token}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data || {}),
  }).then(r => r.json()).catch(() => ({error: 'service unreachable'}));
}

const PLATFORMS = {
  twitch: {name: 'Twitch', note: 'Full chat: messages, moderation, emotes, and alerts', ready: true},
  tiktok: {name: 'TikTok', note: 'Live chat, gifts, and followers (read-only)', ready: true},
  youtube: {name: 'YouTube', note: 'Live chat and Super Chat', ready: false},
  kick: {name: 'Kick', note: 'Live chat, subscriptions, and gifts', ready: false},
};

// stato locale della guida
const state = {
  chosen: {twitch: false, tiktok: false, youtube: false, kick: false},
  channels: {twitch: '', tiktok: '', youtube: '', kick: ''},
  account: null,
  builtInClient: true,
  seConfigured: false,
  seToken: '',
  autoGame: true,
  step: 0,
  checks: {twitch: null, tiktok: null, youtube: null, kick: null},
  picked: {},
  timers: {},
  manual: {twitch: false},
};

// la configurazione arriva dal plugin appena la pagina si apre
const stream = new EventSource(`/api/events?t=${token}`);
stream.addEventListener('config', event => {
  const config = JSON.parse(event.data);
  state.account = config.account;
  state.builtInClient = config.builtInClient;
  state.seConfigured = config.seConfigured;
  if (config.autoGame !== undefined) state.autoGame = config.autoGame;
  for (const key of Object.keys(state.channels)) {
    if (config[key]) {
      state.channels[key] = config[key];
      state.chosen[key] = true;
    }
  }
  prefetchProfiles();
  render();
});

// Every saved channel is looked up once, in parallel, as soon as the wizard opens: by the time you reach its
// step the profile is already there instead of a spinner.
const prefetched = new Set();
function prefetchProfiles() {
  for (const key of Object.keys(PLATFORMS)) {
    const name = state.channels[key];
    if (!name || state.checks[key] || prefetched.has(key + ':' + name)) continue;
    prefetched.add(key + ':' + name);
    post('/api/check', {platform: key, name}).then(info => {
      if (!info.ok || state.channels[key] !== name || state.checks[key]) return;
      state.checks[key] = info;
      if (steps()[state.step] === key) render();
    });
  }
}

function steps() {
  const list = ['intro', 'platforms'];
  for (const key of Object.keys(PLATFORMS)) if (state.chosen[key]) list.push(key);
  list.push('gioco', 'alerts', 'done');
  return list;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const span = el('span');
  span.innerHTML = `<svg><use href="#${name}"/></svg>`;
  return span.firstChild;
}
function platformIcon(key) {
  const box = el('span', `pick__icon ${key}`);
  box.append(icon(`i-${key}`));
  return box;
}
function field(label, value, placeholder, help, onInput) {
  const wrap = el('label', 'field');
  wrap.append(el('span', '', label));
  const input = el('input');
  input.value = value || '';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.oninput = () => onInput(input.value.trim());
  wrap.append(input);
  if (help) wrap.append(el('small', '', help));
  setTimeout(() => input.focus(), 50);
  return wrap;
}

// Entering a step animates its blocks in; any other re-render (config update, a click inside the step)
// swaps the content without animation, so nothing jumps while you use the step.
let shownStep = -1;
function render() {
  const list = steps();
  if (state.step >= list.length) state.step = list.length - 1;
  const entering = state.step !== shownStep;
  const view = $('view');
  view.classList.remove('is-entering');
  if (entering) view.dataset.dir = state.step >= shownStep ? 'next' : 'back';
  renderHead(list);
  renderStep(list);
  if (entering) {
    [...view.children].forEach((child, i) => child.style.setProperty('--i', i));
    void view.offsetWidth; // restart the animation
    view.classList.add('is-entering');
    view.scrollTop = 0;
  }
  shownStep = state.step;
}

function renderHead(list) {
  $('counter').textContent = `${state.step + 1} OF ${list.length}`;
  const bars = $('bars');
  if (bars.childElementCount !== list.length) bars.replaceChildren(...list.map(() => el('span')));
  [...bars.children].forEach((bar, i) => { bar.className = i < state.step ? 'is-done' : i === state.step ? 'is-now' : ''; });
}

function renderStep(list) {
  const name = list[state.step];
  const view = $('view');
  view.innerHTML = '';
  $('hint').textContent = '';
  $('hint').className = 'hint';
  $('back').hidden = state.step === 0;
  $('skip').hidden = state.step === steps().length - 1;
  $('next').innerHTML = '';
  $('next').disabled = false;

  const drawNext = (label, iconName) => {
    $('next').append(document.createTextNode(label));
    if (iconName) $('next').append(icon(iconName));
  };

  if (name === 'intro') {
    const hero = el('div', 'hero');
    const mark = el('div', 'hero__mark');
    mark.append(icon('i-chat'));
    hero.append(mark);
    hero.append(el('h1', 'hero__title', 'Welcome to Crossfeed'));
  hero.append(el('p', 'hero__sub', 'Twitch, TikTok, and more in one chat and one activity feed inside OBS. Connecting your channels takes about a minute.'));
    const logos = el('div', 'hero__logos');
    for (const [key, info] of Object.entries(PLATFORMS)) {
      const dot = el('span', `logo ${key}`);
      dot.setAttribute('title', info.name);
      dot.append(icon(`i-${key}`));
      logos.append(dot);
    }
    hero.append(logos);
    const feats = el('div', 'feats');
    const make = (iconName, title) => {
      const tile = el('div', 'feat');
      const box = el('span', 'feat__icon');
      box.append(icon(iconName));
      tile.append(box, el('b', '', title));
      return tile;
    };
    feats.append(make('i-chat', 'One chat for every platform'), make('i-bell', 'Follows, subs, and gifts live'),
                 make('i-gamepad', 'Your game captured on its own'));
    hero.append(feats);
    view.append(hero);
    drawNext('Get started', 'i-next');
    $('next').onclick = () => go(1);
    return;
  }

  if (name === 'platforms') {
    view.append(el('h1', '', 'Which platforms do you use?'));
    view.append(el('p', '', 'Choose one or more. You can change them later in the dock settings.'));
    const grid = el('div', 'grid');
    for (const [key, info] of Object.entries(PLATFORMS)) {
      const card = el('button', 'pick' + (state.chosen[key] ? ' is-on' : ''));
      card.type = 'button';
      card.append(platformIcon(key));
      const text = el('span');
      const title = el('b', '', info.name);
      if (!info.ready) title.append(el('span', 'soon', 'soon'));
      text.append(title, el('small', '', info.note));
      card.append(text);
      const tick = el('span', 'tick');
      tick.append(icon('i-check'));
      card.append(tick);
      card.onclick = () => {
        state.chosen[key] = !state.chosen[key];
        if (!state.chosen[key]) state.channels[key] = '';
        render();
      };
      grid.append(card);
    }
    view.append(grid);
    const any = Object.values(state.chosen).some(Boolean);
    $('next').disabled = !any;
    if (!any) $('hint').textContent = 'Choose at least one platform to continue.';
    drawNext('Next', 'i-next');
    $('next').onclick = () => go(1);
    return;
  }

  if (PLATFORMS[name]) return renderPlatform(name, drawNext);

  if (name === 'gioco') {
    view.append(el('h1', '', 'Your game enters the scene automatically'));
    view.append(el('p', 'lead', 'Open your game and Crossfeed points your sources at it, with video and audio together. No hotkeys or menus for every session.'));

    const toggle = el('button', 'toggle' + (state.autoGame ? ' is-on' : ''));
    toggle.type = 'button';
    const mark = el('span', 'toggle__icon');
    mark.append(icon('i-gamepad'));
    const body = el('span', 'toggle__body');
    body.append(el('b', '', 'Automatic Game Capture'),
                el('small', '', state.autoGame ? 'Enabled: Crossfeed handles the game'
        : 'Disabled: your sources stay unchanged'));
    toggle.append(mark, body, el('span', 'switch'));
    toggle.onclick = () => {
      state.autoGame = !state.autoGame;
      post('/api/game', {on: state.autoGame});
      render();
    };
    view.append(toggle);

    const feats = el('div', 'feats feats--rows');
    const rows = [
      ['i-monitor', 'It recognizes games it has never seen before',
       'Just run the game in borderless fullscreen. It also detects Steam, Epic, GOG, EA, Xbox, and Battle.net installations.'],
      ['i-volume', 'Captures game audio too',
       'Game Capture includes game sound. Your microphone, Discord, and Spotify remain on their own tracks.'],
      ['i-swap', 'Alt+Tab without surprises',
       'Switching to OBS, Discord, Spotify, or a browser does not change the game. Crossfeed waits for a stable window before switching.'],
    ];
    for (const [name2, title, note] of rows) {
      const feat = el('div', 'feat');
      const box = el('span', 'feat__icon');
      box.append(icon(name2));
      const text = el('span');
      text.append(el('b', '', title), el('small', '', note));
      feat.append(box, text);
      feats.append(feat);
    }
    view.append(feats);
    view.append(el('p', 'note', 'Turn it on or off at any time from OBS: Crossfeed → Automatic Game Capture.'));

    drawNext('Next', 'i-next');
    $('next').onclick = () => go(1);
    return;
  }

  if (name === 'alerts') {
    view.append(el('h1', '', 'Alert Controls (Optional)'));
    view.append(el('p', '', 'If you use StreamElements alerts, its token lets you pause, mute, skip, and replay them from the Activity dock. You can skip this step; everything else still works.'));
    view.append(field('StreamElements JWT Token', '', state.seConfigured ? 'Token already saved' : 'Paste the token here',
      'Find it on your StreamElements account page: channel row → enable “Show Secrets” → copy “JWT Token”.',
      value => { state.seToken = value; }));
    const open = el('button', 'btn btn--plain', 'Open Token Page');
    open.type = 'button';
    open.onclick = () => post('/api/open', {url: 'https://streamelements.com/dashboard/account/channels'});
    view.append(open);
    if (state.seConfigured) {
      const ok = el('div', 'box');
      ok.append(el('span', 'state ok', 'StreamElements is already connected'));
      view.append(ok);
    }
    drawNext('Next', 'i-next');
    $('next').onclick = () => {
      if (!state.seToken) return go(1);
      post('/api/feed-config', {seToken: state.seToken, adLength: '60'}).then(result => {
        if (result.error) return fail(result.error);
        go(1);
      });
    };
    return;
  }

  // last step: a "ready" panel like the setup box of Nostalgia
  view.append(el('h1', '', 'All set'));
  view.append(el('p', '', 'Both docks are in OBS. The Crossfeed menu reopens them, and this guide, whenever you need.'));
  const items = [];
  for (const [key, info] of Object.entries(PLATFORMS)) {
    if (!state.chosen[key]) continue;
    const ok = key === 'twitch' ? !!(state.channels.twitch && state.account) : !!state.channels[key] && info.ready;
    const shown = (state.checks[key] && state.checks[key].display) || state.channels[key];
    const detail = !state.channels[key] ? 'channel missing'
      : key === 'twitch' && !state.account ? `${shown} \u00b7 read-only`
      : info.ready ? shown : `${shown} \u00b7 coming soon`;
    items.push({icon: platformIcon(key), title: info.name, detail, ok});
  }
  const gameIcon = el('span', 'pick__icon');
  gameIcon.append(icon('i-gamepad'));
  items.push({icon: gameIcon, title: 'Automatic Game Capture', detail: state.autoGame ? 'on' : 'off', ok: state.autoGame});
  const done = items.filter(item => item.ok).length;
  const panel = el('div', 'ready');
  const head = el('div', 'ready__head');
  head.append(el('b', '', done === items.length ? 'Ready to stream' : 'Almost ready'), el('span', 'ready__count', `${done}/${items.length}`));
  const bars = el('div', 'ready__bars');
  for (const item of items) bars.append(el('span', item.ok ? 'ok' : ''));
  const rows = el('div', 'rows');
  for (const item of items) {
    const row = el('div', 'row');
    const text = el('span', 'row__text');
    text.append(el('b', '', item.title), el('small', '', item.detail));
    const check = el('span', 'row__check' + (item.ok ? ' ok' : ''));
    check.append(icon('i-check'));
    row.append(item.icon, text, check);
    rows.append(row);
  }
  panel.append(head, bars, rows);
  view.append(panel);
  drawNext('Finish', 'i-check');
  $('next').onclick = finish;
}

// scheda del profilo trovato: avatar, nome vero, stato della diretta.
// Quando arriva da una ricerca e' un pulsante: si tocca per confermare che e' il profilo giusto.
function profileCard(info, pick) {
  const chosen = !pick || state.picked[pick.key] === info.name;
  const card = el(pick ? 'button' : 'div', 'profile' + (pick ? ' profile--pick' : '') + (chosen ? ' is-chosen' : ''));
  if (pick) card.type = 'button';
  const avatar = document.createElement('img');
  avatar.className = 'profile__avatar';
  avatar.alt = '';
  avatar.onload = () => avatar.classList.add('is-loaded');
  if (info.avatar) avatar.src = info.avatar;
  const body = el('span', 'profile__body');
  body.append(el('b', '', info.display || info.name));
  const sub = el('small', info.live ? 'is-live' : '', info.live ? 'live now' : '@' + info.name);
  body.append(sub);
  card.append(avatar, body);
  const tick = el('span', 'profile__tick' + (chosen ? '' : ' profile__tick--empty'));
  if (chosen) tick.append(icon('i-check'));
  card.append(tick);
  if (pick) {
  card.append(el('span', 'profile__hint', chosen ? 'selected' : 'click to use this'));
    card.onclick = () => {
      state.picked[pick.key] = info.name;
      state.channels[pick.key] = info.name;
      render();
    };
  }
  return card;
}

// campo con verifica automatica: si scrive il nome e il plugin conferma che il canale esiste
function checkedField(key, label, placeholder, help) {
  const wrap = el('div', 'checked');
  const result = el('div', 'checked__result');
  wrap.append(field(label, state.channels[key], placeholder, help, value => {
    state.channels[key] = value;
    state.checks[key] = null;
    clearTimeout(state.timers[key]);
    result.innerHTML = '';
    if (!value) return;
    result.append(el('span', 'state is-loading', 'Looking up the profile...'));
    state.timers[key] = setTimeout(() => runCheck(key, result), 450);
  }));
  wrap.append(result);
  if (state.checks[key]) {
    result.append(el('small', 'checked__label', 'Profile found:'));
    result.append(profileCard(state.checks[key], {key}));
  }
  else if (state.channels[key]) setTimeout(() => runCheck(key, result), 100);
  return wrap;
}

function runCheck(key, result) {
  const name = state.channels[key];
  if (!name) return;
  post('/api/check', {platform: key, name}).then(info => {
    if (state.channels[key] !== name) return; // nel frattempo ha scritto altro
    result.innerHTML = '';
    if (!info.ok) {
      state.checks[key] = null;
      result.append(el('span', 'state ko', info.error || 'Channel not found'));
      return;
    }
    state.checks[key] = info;
    result.append(el('small', 'checked__label', 'Profile found:'));
    const card = profileCard(info, {key});
    card.classList.add('is-new');
    result.append(card);
  });
}

function renderPlatform(key, drawNext) {
  const info = PLATFORMS[key];
  const view = $('view');
  view.append(el('h1', '', 'Connect ' + info.name));

  if (key === 'twitch') {
    if (state.account && state.account.login) {
      view.append(el('p', '', 'Account already connected. Twitch provides the channel, name, and permissions automatically.'));
      // the signed-in account is the channel: its card starts selected instead of asking for a click
      if (!state.picked.twitch) state.picked.twitch = state.channels.twitch || state.account.login;
      const slot = el('div', 'checked__result');
      if (state.checks.twitch) {
        slot.append(profileCard(state.checks.twitch));
      } else {
        // finché non arriva la risposta si mostra il nome, poi la scheda si completa con l'avatar
        slot.append(profileCard({name: state.channels.twitch || state.account.login, display: state.account.login}));
        runCheck('twitch', slot);
      }
      view.append(slot);
      if (state.account.needsReauth) {
        const box = el('div', 'box');
      box.append(el('h3', '', 'Permissions Update Required'));
      box.append(el('p', '', 'New permissions are required for followers, subscriptions, ads, and channel point rewards. Click the button and confirm on Twitch.'));
      const again = el('button', 'btn btn--plain', 'Update Permissions');
        again.type = 'button';
        again.onclick = () => connectTwitch(again);
        box.append(again);
        view.append(box);
      }
      const account = el('div', 'box');
      account.append(el('h3', '', 'Twitch Sign-in'));
    account.append(el('p', '', 'Crossfeed uses a Twitch sign-in saved on this computer; no password is stored. You can connect another account or sign in again here.'));
      const change = el('button', 'btn btn--plain', 'Change Twitch Account');
      change.type = 'button';
      change.onclick = () => connectTwitch(change);
      account.append(change);
      view.append(account);

      if (state.manual.twitch) {
        view.append(checkedField('twitch', 'Twitch Channel to Follow', 'for example: fialss_',
                                 'Useful when you moderate someone else’s channel.'));
      } else {
        const other = el('button', 'link link--inline', 'Not your channel? Enter another one');
        other.type = 'button';
        other.onclick = () => { state.manual.twitch = true; render(); };
        view.append(other);
      }
    } else {
      view.append(el('p', '', 'Click the button to open Twitch in your browser, authorize Crossfeed, then return here. Twitch provides your channel and username; your password never passes through Crossfeed.'));
      const connect = el('button', 'btn btn--go btn--big', 'Connect Twitch Account');
      connect.type = 'button';
      connect.onclick = () => connectTwitch(connect);
      view.append(connect);
      const box = el('div', 'box');
      box.append(el('h3', '', 'Or just read the chat'));
    box.append(el('p', '', 'You can read a channel without connecting an account. Enter its name below; chat and moderation will be unavailable.'));
      view.append(box);
      view.append(checkedField('twitch', 'Twitch Channel to Follow', 'for example: fialss_', ''));
    }
  } else if (key === 'tiktok') {
    view.append(el('p', '', 'TikTok does not provide app sign-in like Twitch. Enter your username to read the public live chat; no password is required.'));
    view.append(checkedField('tiktok', 'TikTok Username', 'for example: fialss',
                             'Without the @; the profile link works too. As soon as you type it, the matching profile shows up below.'));
  } else if (key === 'youtube') {
    view.append(el('p', '', 'Enter the channel; Crossfeed will read its chat when it goes live.'));
    view.append(checkedField('youtube', 'YouTube Channel', 'for example: fialss',
      'Your handle without @, or the channel URL.'));
    const box = el('div', 'box');
    box.append(el('h3', '', 'In Development'));
    box.append(el('p', '', 'YouTube chat support is coming in an update. The channel will remain saved and activate automatically.'));
    view.append(box);
  } else if (key === 'kick') {
    view.append(el('p', '', 'Kick chat is public. Enter the channel name; no account or keys are required.'));
    view.append(checkedField('kick', 'Kick Channel', 'for example: fialss',
                             'Use the name shown in kick.com/name.'));
    const box = el('div', 'box');
    box.append(el('h3', '', 'In Development'));
    box.append(el('p', '', 'Kick chat support is coming in an update. The channel will remain saved and activate automatically.'));
    view.append(box);
  }

  drawNext('Next', 'i-next');
  $('next').onclick = () => {
    if (state.checks[key]) { // se il profilo e' stato trovato ma non toccato, vale comunque
      state.picked[key] = state.checks[key].name;
      state.channels[key] = state.checks[key].name;
    }
    if (!state.channels[key])
  return fail('A channel is required for ' + info.name + ': enter it above' + (key === 'twitch' ? ' or connect the account.' : '.'));
    saveChannels().then(result => {
      if (result.error) return fail(result.error);
      go(1);
    });
  };
}

// ------------------------------------------------------------ azioni
function saveChannels() {
  return post('/api/config', {
    twitch: state.chosen.twitch ? state.channels.twitch : '',
    tiktok: state.chosen.tiktok ? state.channels.tiktok : '',
    youtube: state.chosen.youtube ? state.channels.youtube : '',
    kick: state.chosen.kick ? state.channels.kick : '',
  });
}
function connectTwitch(button) {
  button.disabled = true;
  button.textContent = 'Waiting for confirmation in your browser…';
  saveChannels().then(() => post('/api/account', {})).then(result => {
    if (result.error) {
      button.disabled = false;
      button.textContent = 'Connect Twitch Account';
      fail(result.error);
    }
  });
}
function finish() {
  saveChannels().then(() => post('/api/setup-done', {})).then(done);
}
function done() { parent.postMessage('crossfeed-setup-done', '*'); }
function go(delta) {
  state.step = Math.max(0, state.step + delta);
  render();
}
function fail(message) {
  $('hint').textContent = message;
  $('hint').className = 'hint bad';
}

$('back').onclick = () => go(-1);
$('skip').onclick = () => post('/api/setup-done', {}).then(done);
render();
