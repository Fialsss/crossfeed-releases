// Window of updates and "What's New". The plugin opens it with ?mode=update (something to do), news (the first start
// of a new version: what changed since the last one seen) or history (from the menu). Data, commands and links: /api/update.
const params = new URLSearchParams(location.search);
const token = params.get('t') || '';
const mode = params.get('mode') || 'update';
const since = params.get('since') || '';
const $ = id => document.getElementById(id);

function post(path, data) {
  return fetch(`${path}?t=${token}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data || {}),
  }).then(r => r.json()).catch(() => ({error: 'service unreachable'}));
}
const command = action => post('/api/update', {action});

// "0.3.10" > "0.3.9": numbers, not text
function compare(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// the notes are plain text from the manifest: "### Title", "- point", **bold**
function escape(text) {
  return text.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}
const inline = text => escape(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
function release(note) {
  const box = document.createElement('article');
  box.className = 'release';
  let html = `<div class="release__version">${escape(note.version)}</div>`, list = false;
  for (const raw of note.text.split('\n')) {
    const line = raw.trim();
    const point = line.startsWith('- ');
    if (list && !point) { html += '</ul>'; list = false; }
    if (!line) continue;
    if (line.startsWith('### ')) html += `<h3>${inline(line.slice(4))}</h3>`;
    else if (point) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(line.slice(2))}</li>`; }
    else html += `<p>${inline(line)}</p>`;
  }
  box.innerHTML = html + (list ? '</ul>' : '');
  return box;
}

function show(notes) {
  $('notes').replaceChildren(...notes.map(release));
}

function render(s) {
  const go = $('go'), later = $('later'), tag = $('tag');
  const busy = !s.canRestart;
  let eyebrow, title, lead, notes = [], action = 'close', label = 'OK', hint = '', tagText = '', tagClass = '';
  later.hidden = false;
  later.textContent = 'Later';
  if (mode === 'news') {
    eyebrow = 'Updated';
    title = `Crossfeed is now ${s.current}`;
    lead = since ? `Here is what changed since ${since}.` : 'Here is what is new in this version.';
    notes = s.notes.filter(n => compare(n.version, s.current) <= 0 && (since ? compare(n.version, since) > 0 : compare(n.version, s.current) === 0));
    label = 'Got it';
    later.hidden = true;
  } else if (mode === 'history') {
    eyebrow = "What's new";
    title = "What's new in Crossfeed";
    lead = `You have ${s.current}.`;
    notes = s.notes.filter(n => compare(n.version, s.current) <= 0);
    if (!s.notes.length) lead += ' The notes arrive with the next check for updates.';
    label = 'Close';
    later.hidden = true;
  } else if (s.status === 'ready') {
    eyebrow = `${s.current} → ${s.latest}`;
    title = `Crossfeed ${s.latest} is ready`;
    lead = `Restart OBS to start using it. Until then, ${s.current} keeps running as it is.`;
    action = 'restart';
    label = 'Restart OBS';
    if (busy) hint = 'Stop streaming, recording, the replay buffer and the virtual camera first.';
  } else if (s.status === 'available') {
    eyebrow = `${s.current} → ${s.latest}`;
    title = `Crossfeed ${s.latest} is available`;
    lead = `You have ${s.current}. Download it now: it starts the next time OBS opens.`;
    action = 'update';
    label = 'Update';
  } else if (s.status === 'setup') {
    eyebrow = `${s.current} → ${s.latest}`;
    title = `Crossfeed ${s.latest} is available`;
    lead = "This copy can't update itself. Install the new version once with the setup: after that, updates are automatic.";
    action = 'download';
    label = 'Download';
  } else if (s.status === 'latest') {
    eyebrow = 'Up to date';
    title = `Crossfeed ${s.current} is the latest version`;
    lead = 'Crossfeed checks for updates every time OBS starts.';
    notes = s.notes.filter(n => compare(n.version, s.current) === 0);
    later.hidden = true;
  } else {
    eyebrow = 'Updates';
    title = "Couldn't check for updates";
    lead = s.message || 'GitHub did not answer. Check the connection and try again.';
    action = 'update';
    label = 'Try again';
    later.textContent = 'Close';
  }
  if (['ready', 'available', 'setup'].includes(s.status) && mode === 'update') {
    notes = s.notes.filter(n => compare(n.version, s.current) > 0 && compare(n.version, s.latest) <= 0);
    tagText = 'New update';
    tagClass = 'is-new';
  } else if (s.status === 'latest') {
    tagText = 'Latest';
    tagClass = 'is-latest';
  }
  $('eyebrow').textContent = eyebrow;
  $('title').textContent = title;
  $('lead').textContent = lead;
  $('hint').textContent = hint;
  tag.hidden = !tagText;
  tag.textContent = tagText;
  tag.className = 'tag ' + tagClass;
  go.textContent = label;
  go.disabled = action === 'restart' && busy;
  go.onclick = () => {
    if (action === 'close') return command('close');
    if (action === 'download') return command('download').then(() => command('close'));
    if (action === 'update') { go.disabled = true; go.textContent = 'Downloading…'; waitFor(s.status); }
    command(action);
  };
  show(notes);
}

// after "Update" the plugin downloads, then the state changes: the window follows it
function waitFor(previous) {
  let tries = 0;
  const tick = () => post('/api/update', {action: 'state'}).then(s => {
    if (s.status && s.status !== previous && s.status !== 'unknown') return render(s);
    if (++tries < 60) setTimeout(tick, 1000);
    else render(s);
  });
  setTimeout(tick, 1000);
}

$('later').onclick = () => command('close');
$('releases').onclick = () => command('releases');

post('/api/update', {action: 'state'}).then(s => {
  if (!s || s.error || !s.current) s = {status: 'unknown', current: '', latest: '', notes: [], canRestart: false};
  s.notes = s.notes || [];
  render(s);
});
