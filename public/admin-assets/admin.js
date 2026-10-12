const $ = (id) => document.getElementById(id);

const LINK_LABELS = {
  spotify: 'Spotify', appleMusic: 'Apple Music', youtube: 'YouTube', soundcloud: 'SoundCloud',
  bandcamp: 'Bandcamp', tidal: 'TIDAL', deezer: 'Deezer', other: 'Other link',
};
const SOCIAL_LABELS = {
  instagram: 'Instagram', x: 'X / Twitter', tiktok: 'TikTok', youtube: 'YouTube', spotify: 'Spotify',
  soundcloud: 'SoundCloud', facebook: 'Facebook', twitch: 'Twitch', discord: 'Discord', website: 'Website',
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

const fmt = (sec) => {
  sec = Math.max(0, sec || 0);
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
};

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

async function api(method, url, body) {
  const opts = { method, headers: { 'X-Requested-With': 'radio-admin' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/admin${url}`, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/login') {
    showLogin();
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let linkKeys = Object.keys(LINK_LABELS);
let socialKeys = Object.keys(SOCIAL_LABELS);
let tracks = [];
let status = null;
let pollTimer = null;

// --- auth ---------------------------------------------------------------------
function showLogin() {
  clearInterval(pollTimer);
  $('appView').hidden = true;
  $('loginView').hidden = false;
  $('password').focus();
}

async function boot() {
  const s = await api('GET', '/session');
  linkKeys = s.linkKeys || linkKeys;
  socialKeys = s.socialKeys || socialKeys;
  if (!s.loggedIn) return showLogin();
  $('loginView').hidden = true;
  $('appView').hidden = false;
  buildStaticFields();
  await Promise.all([refreshStatus(), refreshTracks(), loadSettings()]);
  clearInterval(pollTimer);
  let n = 0;
  pollTimer = setInterval(() => {
    n++;
    refreshStatus().catch(() => {});
    // Poll the library fast while uploads are processing, slowly otherwise.
    if (tracks.some((t) => t.status === 'processing') || n % 10 === 0) refreshTracks().catch(() => {});
  }, 2000);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    await api('POST', '/login', { password: $('password').value });
    $('password').value = '';
    boot();
  } catch (err) {
    $('loginError').textContent = err.message;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('POST', '/logout').catch(() => {});
  showLogin();
});

// --- tabs -------------------------------------------------------------------------
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t === tab));
    for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== tab.dataset.tab;
  });
}

// --- on air -------------------------------------------------------------------------
function thumb(src) {
  return src ? el('img', { class: 'thumb', src, alt: '' }) : el('span', { class: 'thumb' });
}

function item(tr, extra) {
  return el('div', { class: 'item' }, [
    thumb(tr.cover),
    el('div', { class: 'txt' }, [el('b', { text: tr.title }), el('span', { class: 'sub', text: tr.artist || 'Unknown artist' })]),
    extra,
  ]);
}

async function refreshStatus() {
  status = await api('GET', '/status');
  const now = status.now;
  $('adminStation').textContent = status.settings.stationName;
  $('nowTitle').textContent = now ? now.title : 'Nothing playing';
  $('nowArtist').textContent = now ? now.artist || 'Unknown artist' : 'Upload songs in the Library tab to go on air.';
  $('nowArt').style.backgroundImage = now?.cover ? `url("${now.cover}")` : '';
  $('nowPos').textContent = fmt(status.position);
  $('nowDur').textContent = fmt(now?.duration);
  $('nowBar').style.width = now ? `${Math.min(100, (status.position / now.duration) * 100)}%` : '0';
  $('listeners').textContent = status.listeners;
  $('connections').textContent = status.connections !== status.listeners ? `(${status.connections} connections)` : '';
  $('skipBtn').disabled = !now;

  $('dashNext').replaceChildren(status.next ? item(status.next) : el('p', { class: 'empty-note', text: 'Nothing queued yet.' }));
  $('dashQueue').replaceChildren(
    ...(status.queue.length
      ? status.queue.map((q) =>
          item(q, el('button', {
            class: 'btn sm ghost danger', text: 'Remove',
            onclick: () => api('DELETE', `/queue/${q.requestId}`).then(refreshStatus).catch((e) => toast(e.message, true)),
          })),
        )
      : [el('p', { class: 'empty-note', text: 'Empty. Use "Play next" in the Library to request a song.' })]),
  );
  $('dashHistory').replaceChildren(
    ...(status.history.length
      ? status.history.map((h) => item(h, el('time', { text: new Date(h.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })))
      : [el('p', { class: 'empty-note', text: 'No history yet.' })]),
  );
  markPlaying();
}

$('skipBtn').addEventListener('click', async () => {
  $('skipBtn').disabled = true;
  try {
    await api('POST', '/skip');
    toast('Skipped');
    setTimeout(refreshStatus, 400);
  } catch (e) {
    toast(e.message, true);
  }
});

// --- library --------------------------------------------------------------------------
let tracksKey = '';
async function refreshTracks() {
  tracks = await api('GET', '/tracks');
  const key = JSON.stringify(tracks.map((t) => [t.id, t.title, t.artist, t.status, t.enabled, t.cover, t.plays, Object.keys(t.links).length]));
  if (key !== tracksKey) {
    tracksKey = key;
    renderTracks();
  }
}

function markPlaying() {
  for (const row of document.querySelectorAll('#trackRows tr')) {
    row.querySelector('.badge.playing')?.remove();
    if (status?.now && row.dataset.id === status.now.id) {
      row.querySelector('.t-title b').append(el('span', { class: 'badge playing', text: 'On air' }));
    }
  }
}

function renderTracks() {
  const q = $('search').value.trim().toLowerCase();
  const list = tracks
    .filter((t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q))
    .sort((a, b) => b.addedAt - a.addedAt);
  $('trackCount').textContent = tracks.length;
  $('libraryEmpty').hidden = tracks.length > 0;

  $('trackRows').replaceChildren(
    ...list.map((t) => {
      const ready = t.status === 'ready';
      const badge =
        t.status === 'processing' ? el('span', { class: 'badge processing', text: 'Processing...' })
        : t.status === 'error' ? el('span', { class: 'badge error', text: 'Failed', title: t.error || '' })
        : null;
      const linkCount = Object.keys(t.links).length;
      const toggle = el('input', { type: 'checkbox', checked: t.enabled, disabled: !ready, 'aria-label': `Include ${t.title} in rotation` });
      toggle.addEventListener('change', () =>
        api('PATCH', `/tracks/${t.id}`, { enabled: toggle.checked }).then(refreshTracks).catch((e) => toast(e.message, true)),
      );
      return el('tr', { 'data-id': t.id }, [
        el('td', { class: 'cover-cell' }, el('button', { class: 'cover-btn', title: 'Change cover', 'aria-label': `Change cover for ${t.title}`, onclick: () => pickCover(t) }, t.cover ? el('img', { src: t.cover, alt: '' }) : null)),
        el('td', { class: 't-title' }, [
          el('b', { text: t.title }, badge),
          el('span', { text: [t.artist || 'Unknown artist', t.album].filter(Boolean).join(' · ') }),
          linkCount ? el('span', { class: 'links-count', text: ` · ${linkCount} link${linkCount > 1 ? 's' : ''}` }) : null,
          t.status === 'error' ? el('div', { class: 'small muted', text: t.error || '' }) : null,
        ]),
        el('td', { class: 'hide-sm muted', text: ready ? fmt(t.duration) : '-' }),
        el('td', { class: 'hide-sm muted', text: String(t.plays) }),
        el('td', {}, el('label', { class: 'switch' }, [toggle, el('span')])),
        el('td', {}, el('div', { class: 'actions' }, [
          el('button', { class: 'btn sm', text: 'Play next', disabled: !ready || !t.enabled, onclick: () => playNext(t) }),
          el('button', { class: 'btn sm ghost', text: 'Edit', onclick: () => openEdit(t) }),
          el('button', { class: 'btn sm ghost danger', text: 'Delete', onclick: () => removeTrack(t) }),
        ])),
      ]);
    }),
  );
  markPlaying();
}
$('search').addEventListener('input', renderTracks);

async function playNext(t) {
  try {
    await api('POST', '/queue', { id: t.id });
    toast(`"${t.title}" added to the request queue`);
    refreshStatus();
  } catch (e) {
    toast(e.message, true);
  }
}

async function removeTrack(t) {
  if (!confirm(`Delete "${t.title}" from the station? The file is removed from the server.`)) return;
  try {
    await api('DELETE', `/tracks/${t.id}`);
    toast('Deleted');
    refreshTracks();
  } catch (e) {
    toast(e.message, true);
  }
}

let coverTarget = null;
function pickCover(t) {
  coverTarget = t;
  $('coverInput').value = '';
  $('coverInput').click();
}
$('coverInput').addEventListener('change', async () => {
  const file = $('coverInput').files[0];
  if (!file || !coverTarget) return;
  const fd = new FormData();
  fd.append('cover', file);
  try {
    await api('POST', `/tracks/${coverTarget.id}/cover`, fd);
    toast('Cover updated');
    refreshTracks();
  } catch (e) {
    toast(e.message, true);
  }
});

// --- uploads ----------------------------------------------------------------------------
const uploadQueue = [];
let uploading = false;

function addFiles(files) {
  for (const file of files) {
    const bar = el('progress', { max: '100', value: '0' });
    const state = el('span', { class: 'state', text: 'Waiting' });
    const row = el('div', { class: 'upload' }, [el('span', { class: 'name', text: file.name }), bar, state]);
    $('uploads').prepend(row);
    uploadQueue.push({ file, row, bar, state });
  }
  pumpUploads();
}

function pumpUploads() {
  if (uploading || !uploadQueue.length) return;
  uploading = true;
  const job = uploadQueue.shift();
  const fd = new FormData();
  fd.append('audio', job.file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/admin/tracks');
  xhr.setRequestHeader('X-Requested-With', 'radio-admin');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      job.bar.value = (e.loaded / e.total) * 100;
      job.state.textContent = `${Math.round((e.loaded / e.total) * 100)}%`;
    }
  };
  xhr.onload = () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
    if (xhr.status === 202) {
      job.bar.value = 100;
      job.state.textContent = 'Converting...';
      refreshTracks();
      // The row's job is done once the library shows it; fade it out.
      setTimeout(() => job.row.remove(), 4000);
    } else {
      job.row.classList.add('fail');
      job.state.textContent = 'Failed';
      job.state.title = data.error || `HTTP ${xhr.status}`;
      toast(`${job.file.name}: ${data.error || 'Upload failed'}`, true);
    }
    uploading = false;
    pumpUploads();
  };
  xhr.onerror = () => {
    job.row.classList.add('fail');
    job.state.textContent = 'Network error';
    uploading = false;
    pumpUploads();
  };
  job.state.textContent = 'Uploading';
  xhr.send(fd);
}

const dz = $('dropzone');
$('fileInput').addEventListener('change', () => {
  addFiles([...$('fileInput').files]);
  $('fileInput').value = '';
});
for (const ev of ['dragenter', 'dragover']) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) dz.addEventListener(ev, () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});

// --- edit dialog ----------------------------------------------------------------------------
function buildStaticFields() {
  $('linkFields').replaceChildren(
    ...linkKeys.map((k) =>
      el('div', { class: 'social-field' }, [
        el('span', { class: 'small muted', text: LINK_LABELS[k] || k }),
        el('input', { name: `link_${k}`, type: 'url', placeholder: 'https://', 'aria-label': `${LINK_LABELS[k] || k} link` }),
      ]),
    ),
  );
  $('socialFields').replaceChildren(
    ...socialKeys.map((k) =>
      el('div', { class: 'social-field' }, [
        el('span', { class: 'small muted', text: SOCIAL_LABELS[k] || k }),
        el('input', { name: `social_${k}`, type: 'url', placeholder: 'https://', 'aria-label': `${SOCIAL_LABELS[k] || k} URL` }),
      ]),
    ),
  );
}

let editing = null;
function openEdit(t) {
  editing = t;
  // form.elements, not form.title: a form's own `title` property would shadow the input.
  const f = $('editForm').elements;
  f.title.value = t.title;
  f.artist.value = t.artist || '';
  f.album.value = t.album || '';
  for (const k of linkKeys) f[`link_${k}`].value = t.links[k] || '';
  $('editDialog').showModal();
}

$('editDialog').addEventListener('close', async () => {
  if ($('editDialog').returnValue !== 'save' || !editing) return;
  const f = $('editForm').elements;
  const links = {};
  for (const k of linkKeys) links[k] = f[`link_${k}`].value.trim();
  try {
    await api('PATCH', `/tracks/${editing.id}`, { title: f.title.value, artist: f.artist.value, album: f.album.value, links });
    toast('Saved');
    refreshTracks();
  } catch (e) {
    toast(e.message, true);
  }
});

// --- station settings ----------------------------------------------------------------------------
function renderBgPreview(bg) {
  const box = $('bgPreview');
  if (!bg) return box.replaceChildren(document.createTextNode('No custom background. The visualizer and cover art fill the screen.'));
  const url = `/bg/${bg.file}?v=${bg.rev}`;
  if (bg.type === 'video') {
    const v = el('video', { src: url, autoplay: true, loop: true, playsinline: true });
    v.muted = true;
    box.replaceChildren(v);
  } else box.replaceChildren(el('img', { src: url, alt: '' }));
  $('bgRemove').disabled = !bg;
}

async function loadSettings() {
  const s = await api('GET', '/settings');
  const f = $('settingsForm');
  f.stationName.value = s.stationName;
  f.tagline.value = s.tagline || '';
  f.accent.value = s.accent;
  f.backgroundOpacity.value = s.backgroundOpacity;
  for (const k of socialKeys) f[`social_${k}`].value = s.socials?.[k] || '';
  renderBgPreview(s.background);
  $('bgRemove').disabled = !s.background;
}

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const socials = {};
  for (const k of socialKeys) socials[k] = f[`social_${k}`].value.trim();
  try {
    await api('PATCH', '/settings', {
      stationName: f.stationName.value,
      tagline: f.tagline.value,
      accent: f.accent.value,
      backgroundOpacity: Number(f.backgroundOpacity.value),
      socials,
    });
    $('settingsStatus').textContent = 'Saved. Listeners see it instantly.';
    setTimeout(() => ($('settingsStatus').textContent = ''), 3000);
    loadSettings();
  } catch (err) {
    toast(err.message, true);
  }
});

$('bgInput').addEventListener('change', async () => {
  const file = $('bgInput').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('background', file);
  $('bgStatus').textContent = 'Processing...';
  try {
    await api('POST', '/settings/background', fd);
    $('bgStatus').textContent = '';
    toast('Background updated');
    loadSettings();
  } catch (e) {
    $('bgStatus').textContent = '';
    toast(e.message, true);
  } finally {
    $('bgInput').value = '';
  }
});

$('bgRemove').addEventListener('click', async () => {
  try {
    await api('DELETE', '/settings/background');
    loadSettings();
  } catch (e) {
    toast(e.message, true);
  }
});

boot().catch((e) => toast(e.message, true));
