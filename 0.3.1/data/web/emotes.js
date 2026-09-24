// Selettore emote ricostruito sul pannello di Twitch: ricerca in cima, sezioni
// "Di uso frequente" e una per canale, colonna di avatar sulla destra.
(function () {
  const $ = id => document.getElementById(id);
  const panel = $('emote-panel');
  const grid = $('emote-grid');
  const rail = $('emote-rail');
  const search = $('emote-search');

  let emotes = null;
  let groups = [];
  let uses = {};
  try {
    uses = JSON.parse(localStorage.getItem('fialss-chat-emote-uses') || '{}');
  } catch { /* conteggi illeggibili: si riparte da zero */ }

  function noteUse(name) {
    uses[name] = (uses[name] || 0) + 1;
    localStorage.setItem('fialss-chat-emote-uses', JSON.stringify(uses));
  }

  function emoteButton(emote) {
    const button = document.createElement('button');
    button.className = 'emote-cell';
    button.title = emote.name;
    const img = document.createElement('img');
    img.src = emote.url;
    img.alt = emote.name;
    img.loading = 'lazy';
    button.append(img);
    button.onclick = () => {
      window.insertEmote(emote);
      noteUse(emote.name);
    };
    return button;
  }

  function section(title, list, key) {
    if (!list.length) return;
    const heading = document.createElement('h4');
    heading.textContent = title;
    heading.dataset.section = key;
    grid.append(heading);
    const box = document.createElement('div');
    box.className = 'emote-cells';
    for (const emote of list) box.append(emoteButton(emote));
    grid.append(box);
  }

  function render() {
    const needle = search.value.trim().toLowerCase();
    grid.innerHTML = '';
    if (!emotes) return;
    const match = e => !needle || e.name.toLowerCase().includes(needle);

    const frequent = emotes
      .filter(e => uses[e.name] && match(e))
      .sort((a, b) => uses[b.name] - uses[a.name])
      .slice(0, 30);
    section('Frequently Used', frequent, 'recenti');

    for (const group of groups) {
      section(group.name, emotes.filter(e => e.group === group.name && match(e)), group.name);
    }
    $('emote-state').textContent = grid.childElementCount ? '' : 'No emotes match this name.';
  }

  function buildRail() {
    rail.innerHTML = '';
    const entries = [{name: 'recenti', avatar: null, icon: '🕘'}, ...groups];
    for (const group of entries) {
      const button = document.createElement('button');
      button.title = group.name === 'recenti' ? 'Frequently Used' : group.name;
      if (group.avatar) {
        const img = document.createElement('img');
        img.src = group.avatar;
        img.alt = group.name;
        button.append(img);
      } else {
        button.textContent = group.icon || group.name.slice(0, 2);
      }
      button.onclick = () => {
        const heading = grid.querySelector(`[data-section="${CSS.escape(group.name)}"]`);
        if (heading) heading.scrollIntoView({block: 'start'});
      };
      rail.append(button);
    }
  }

  function load() {
    $('emote-state').textContent = 'Loading emotes…';
    window.post('/api/emotes', {}).then(result => {
      if (result.error) {
        $('emote-state').textContent = result.error;
        return;
      }
      emotes = result.emotes || [];
      groups = result.groups || [];
      $('emote-state').textContent = '';
      buildRail();
      render();
    });
  }

  $('emotes').onclick = () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    search.focus();
    if (!emotes) load();
  };
  $('emote-close').onclick = () => { panel.hidden = true; };
  search.oninput = render;
})();
