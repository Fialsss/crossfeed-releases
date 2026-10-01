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
  replayNotify: true,
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
  if (config.replayNotify !== undefined) state.replayNotify = config.replayNotify;
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
  list.push('gioco', 'replay', 'alerts', 'done');
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

// The replay buffer banner, drawn like the real one (flat, sharp corners, 4px accent bar, the same icons),
// cycling through its three kinds with the real timings: 220ms in, 2.5s on screen, 350ms out.
const REPLAY_KINDS = [
  {kind: 'on', accent: '#3d8bff', title: 'Replay Buffer On', sub: 'Recording in the background', label: 'Buffer on',
   icon: '<circle cx="13" cy="13" r="10.7" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="1.4" stroke-dasharray="0.14 3.64" stroke-linecap="round"/><circle cx="13" cy="13" r="6.4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="13" cy="13" r="3.4" fill="currentColor"/>'},
  {kind: 'saved', accent: '#76b900', title: 'Replay Saved', sub: 'Clip saved to disk', label: 'Replay saved',
   icon: '<rect x="2.15" y="6.75" width="10.7" height="8.5" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M15.8 9.4 20.8 6.8V15l-5-2.6Z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="19.1" cy="19.1" r="6.9" fill="#121316"/><circle cx="19.1" cy="19.1" r="5.1" fill="currentColor"/><path d="M16.5 19.1 18.3 20.9 21.7 17.3" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'},
  {kind: 'off', accent: '#e05252', title: 'Replay Buffer Off', sub: 'Recording paused', label: 'Buffer off',
   icon: '<path d="M18.7 7.9A8.1 8.1 0 1 1 7.3 7.9" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><path d="M13 2.9v8.7" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>'},
];
function replayPreview() {
  const wrap = el('div', 'rn-preview');
  const stage = el('div', 'rn-stage');
  const legend = el('div', 'rn-legend');
  const chips = REPLAY_KINDS.map(k => {
    const chip = el('span', 'rn-chip');
    chip.style.setProperty('--accent', k.accent);
    chip.append(el('i'), document.createTextNode(k.label));
    legend.append(chip);
    return chip;
  });
  wrap.append(stage, legend);
  let turn = 0;
  const next = () => {
    if (!stage.isConnected && turn) return; // the step was left: stop
    const k = REPLAY_KINDS[turn++ % REPLAY_KINDS.length];
    chips.forEach((chip, i) => chip.classList.toggle('is-on', REPLAY_KINDS[i] === k));
    const banner = el('div', 'rn');
    banner.style.setProperty('--accent', k.accent);
    banner.innerHTML = `<svg class="rn__icon" viewBox="0 0 26 26">${k.icon}</svg>`;
    const text = el('span', 'rn__text');
    text.append(el('b', '', k.title), el('small', '', k.sub));
    banner.append(text);
    stage.replaceChildren(banner);
    setTimeout(() => banner.classList.add('is-out'), 220 + 2500);
    setTimeout(next, 220 + 2500 + 350 + 450);
  };
  next();
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
    view.append(el('p', 'lead', 'Crossfeed sets Game Capture to OBS\'s own automatic mode: it captures the game you play in fullscreen, with its audio. No hotkeys or menus for every session.'));

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
      ['i-monitor', 'Any game, fullscreen or borderless',
       'OBS captures the game in front of you, exactly as when you set it up by hand.'],
      ['i-volume', 'Captures game audio too',
       'Game Capture includes game sound. Your microphone, Discord, and Spotify remain on their own tracks.'],
      ['i-check', 'Safe with anti-cheat',
       'Crossfeed never reads or touches the game or its files: it is the same capture you would set up by hand in OBS.'],
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

  if (name === 'replay') {
    view.append(el('h1', '', 'Know when a replay is saved'));
    view.append(el('p', 'lead', 'A small banner in the corner of your screen, like ShadowPlay, when the replay buffer starts, saves a clip or stops. It never takes the focus from your game.'));
    view.append(replayPreview());

    const toggle = el('button', 'toggle' + (state.replayNotify ? ' is-on' : ''));
    toggle.type = 'button';
    const mark = el('span', 'toggle__icon');
    mark.append(icon('i-replay'));
    const body = el('span', 'toggle__body');
    body.append(el('b', '', 'Replay Buffer Notifications'),
                el('small', '', state.replayNotify ? 'Enabled: a banner for every start, save and stop'
        : 'Disabled: no banner on screen'));
    toggle.append(mark, body, el('span', 'switch'));
    toggle.onclick = () => {
      state.replayNotify = !state.replayNotify;
      post('/api/replay-notify', {on: state.replayNotify});
      render();
    };
    view.append(toggle);

    view.append(el('p', 'note', 'Turn it on or off at any time from OBS: Crossfeed → Replay Buffer Notifications.'));

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
  const replayIcon = el('span', 'pick__icon');
  replayIcon.append(icon('i-replay'));
  items.push({icon: replayIcon, title: 'Replay Buffer Notifications', detail: state.replayNotify ? 'on' : 'off', ok: state.replayNotify});
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
  const chosen = !pick || (state.picked[pick.key] ?? info.name) === info.name; // found = selected until another is picked
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
    saveInBackground(key);
    go(1);
  };
}

// ------------------------------------------------------------ azioni
// Salvare un canale fa ricollegare le chat al plugin e puo' metterci qualche secondo: si salva in background e la
// guida va avanti subito. I salvataggi restano in fila (non si sorpassano); se il plugin rifiuta il canale si torna
// a quel passo con l'errore.
let saving = Promise.resolve();
function saveInBackground(key) {
  saving = saving.then(saveChannels).then(result => {
    if (!result.error) return;
    state.step = Math.max(0, steps().indexOf(key));
    render();
    fail(result.error);
  });
}
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
  saving = saving.then(saveChannels).then(() => post('/api/setup-done', {})).then(done);
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
