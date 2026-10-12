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
  await Promise.all([refreshStatus(), refreshTracks(), refreshAlbums(), loadSettings()]);
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
  const logoUrl = status.settings.logo;
  if (logoUrl && $('adminLogo').getAttribute('src') !== logoUrl) $('adminLogo').src = logoUrl;
  $('adminLogo').hidden = !logoUrl;
  $('adminMark').hidden = Boolean(logoUrl);
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

// --- albums -----------------------------------------------------------------------------
let albums = [];
let albumFilter = null; // album id, 'none' for songs without an album, or null for all
let albumsKey = '';

async function refreshAlbums() {
  albums = await api('GET', '/albums');
  const key = JSON.stringify(albums);
  if (key === albumsKey) return;
  albumsKey = key;
  renderAlbums();
  fillAlbumSelects();
  renderTracks();
}

function albumOptions(select, { auto = false, none = 'No album' } = {}) {
  const current = select.value;
  select.replaceChildren(
    ...(auto ? [el('option', { value: '', text: 'Album from song tags (automatic)' })] : [el('option', { value: '', text: none })]),
    ...albums.map((a) => el('option', { value: a.id, text: a.artist ? `${a.title} · ${a.artist}` : a.title })),
  );
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function fillAlbumSelects() {
  albumOptions($('uploadAlbum'), { auto: true });
  albumOptions($('bulkAlbum'), { none: 'No album (ungroup)' });
  albumOptions($('editAlbum'));
}

function renderAlbums() {
  const looseCount = tracks.filter((t) => !t.albumId).length;
  const cards = albums.map((a) =>
    el('div', { class: `album${albumFilter === a.id ? ' active' : ''}` }, [
      el('button', { class: 'album-art', title: 'Replace artwork', 'aria-label': `Replace artwork for ${a.title}`, onclick: () => pickAlbumCover(a) },
        a.cover ? el('img', { src: a.cover, alt: '' }) : el('span', { text: 'Add artwork' })),
      el('button', { class: 'album-meta', title: 'Show this album\'s songs', onclick: () => setAlbumFilter(albumFilter === a.id ? null : a.id) }, [
        el('b', { text: a.title }),
        el('span', { text: `${a.artist ? `${a.artist} · ` : ''}${a.trackCount} song${a.trackCount === 1 ? '' : 's'}` }),
      ]),
      el('div', { class: 'album-actions' }, [
        el('button', { class: 'btn sm ghost', text: 'Edit', onclick: () => openAlbumDialog(a) }),
        el('button', { class: 'btn sm ghost danger', text: 'Delete', onclick: () => removeAlbum(a) }),
      ]),
    ]),
  );
  if (looseCount) {
    cards.push(
      el('div', { class: `album loose${albumFilter === 'none' ? ' active' : ''}` }, [
        el('button', { class: 'album-art', title: 'Show songs without an album', onclick: () => setAlbumFilter(albumFilter === 'none' ? null : 'none') }, el('span', { text: 'Singles' })),
        el('button', { class: 'album-meta', onclick: () => setAlbumFilter(albumFilter === 'none' ? null : 'none') }, [
          el('b', { text: 'No album' }),
          el('span', { text: `${looseCount} song${looseCount === 1 ? '' : 's'}` }),
        ]),
      ]),
    );
  }
  $('albumGrid').replaceChildren(...(cards.length ? cards : [el('p', { class: 'empty-note', text: 'No albums yet. Create one, or upload songs that have an album tag.' })]));
}

function setAlbumFilter(id) {
  albumFilter = id;
  const album = albums.find((a) => a.id === id);
  $('albumFilter').hidden = !id;
  $('albumFilterName').textContent = id === 'none' ? 'No album' : album?.title || '';
  selected.clear();
  renderAlbums();
  renderTracks();
}
$('albumFilterClear').addEventListener('click', () => setAlbumFilter(null));

// Replace an album's artwork straight from its card.
let albumCoverTarget = null;
function pickAlbumCover(a) {
  albumCoverTarget = a;
  $('albumCoverInput').value = '';
  $('albumCoverInput').click();
}
$('albumCoverInput').addEventListener('change', async () => {
  const file = $('albumCoverInput').files[0];
  if (!file || !albumCoverTarget) return;
  const fd = new FormData();
  fd.append('cover', file);
  try {
    await api('POST', `/albums/${albumCoverTarget.id}/cover`, fd);
    toast(`Artwork updated for "${albumCoverTarget.title}"`);
    await refreshAlbums();
    refreshTracks();
  } catch (e) {
    toast(e.message, true);
  }
});

async function removeAlbum(a) {
  if (!confirm(`Delete the album "${a.title}"? Its ${a.trackCount} song(s) stay in your library, just without an album.`)) return;
  try {
    await api('DELETE', `/albums/${a.id}`);
    if (albumFilter === a.id) setAlbumFilter(null);
    toast('Album deleted');
    await refreshAlbums();
    refreshTracks();
  } catch (e) {
    toast(e.message, true);
  }
}

// Create / edit dialog
let editingAlbum = null;
let albumArtFile = null;
function setAlbumPreview(src) {
  const box = $('albumArtPreview');
  box.querySelector('img')?.remove();
  box.querySelector('span').hidden = Boolean(src);
  if (src) box.append(el('img', { src, alt: '' }));
}
function openAlbumDialog(a = null) {
  editingAlbum = a;
  albumArtFile = null;
  $('albumArtInput').value = '';
  $('albumDialogTitle').textContent = a ? 'Edit album' : 'New album';
  const f = $('albumForm').elements;
  f.title.value = a?.title || '';
  f.artist.value = a?.artist || '';
  setAlbumPreview(a?.cover || null);
  $('albumDialog').showModal();
}
$('newAlbumBtn').addEventListener('click', () => openAlbumDialog());
$('albumArtInput').addEventListener('change', () => {
  albumArtFile = $('albumArtInput').files[0] || null;
  if (albumArtFile) setAlbumPreview(URL.createObjectURL(albumArtFile));
});
$('albumDialog').addEventListener('close', async () => {
  if ($('albumDialog').returnValue !== 'save') return;
  const f = $('albumForm').elements;
  try {
    let id = editingAlbum?.id;
    if (editingAlbum) {
      await api('PATCH', `/albums/${id}`, { title: f.title.value, artist: f.artist.value });
    } else {
      const fd = new FormData();
      fd.append('title', f.title.value);
      fd.append('artist', f.artist.value);
      if (albumArtFile) fd.append('cover', albumArtFile);
      id = (await api('POST', '/albums', fd)).id;
      albumArtFile = null;
    }
    if (albumArtFile) {
      const fd = new FormData();
      fd.append('cover', albumArtFile);
      await api('POST', `/albums/${id}/cover`, fd);
    }
    toast(editingAlbum ? 'Album saved' : `Album "${f.title.value}" created`);
    await refreshAlbums();
    refreshTracks();
  } catch (e) {
    toast(e.message, true);
  }
});

// --- library --------------------------------------------------------------------------
let tracksKey = '';
const selected = new Set();

async function refreshTracks() {
  tracks = await api('GET', '/tracks');
  const key = JSON.stringify(tracks.map((t) => [t.id, t.title, t.artist, t.album, t.albumId, t.status, t.enabled, t.cover, t.plays, t.likes, Object.keys(t.links).length]));
  if (key !== tracksKey) {
    tracksKey = key;
    for (const id of selected) if (!tracks.some((t) => t.id === id)) selected.delete(id);
    renderTracks();
    // Album song counts and auto-created albums change with the library.
    refreshAlbums().catch(() => {});
    renderAlbums();
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

function shownTracks() {
  const q = $('search').value.trim().toLowerCase();
  return tracks
    .filter((t) => !albumFilter || (albumFilter === 'none' ? !t.albumId : t.albumId === albumFilter))
    .filter((t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q))
    .sort((a, b) => b.addedAt - a.addedAt);
}

function updateBulkBar() {
  $('bulkBar').hidden = selected.size === 0;
  $('bulkCount').textContent = `${selected.size} selected`;
  const shown = shownTracks();
  $('selectAll').checked = shown.length > 0 && shown.every((t) => selected.has(t.id));
  $('selectAll').indeterminate = !$('selectAll').checked && shown.some((t) => selected.has(t.id));
}

function renderTracks() {
  const list = shownTracks();
  $('trackCount').textContent = albumFilter ? `${list.length} of ${tracks.length}` : tracks.length;
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
      const pick = el('input', { type: 'checkbox', checked: selected.has(t.id), 'aria-label': `Select ${t.title}` });
      pick.addEventListener('change', () => {
        if (pick.checked) selected.add(t.id);
        else selected.delete(t.id);
        updateBulkBar();
      });
      return el('tr', { 'data-id': t.id }, [
        el('td', { class: 'check-cell' }, pick),
        el('td', { class: 'cover-cell' }, el('button', { class: 'cover-btn', title: 'Artwork & details', 'aria-label': `Edit artwork for ${t.title}`, onclick: () => openEdit(t) }, t.cover ? el('img', { src: t.cover, alt: '' }) : null)),
        el('td', { class: 't-title' }, [
          el('b', { text: t.title }, badge),
          el('span', { text: t.artist || 'Unknown artist' }),
          t.album ? el('span', { class: 'album-tag', text: ` · ${t.album}` }) : null,
          linkCount ? el('span', { class: 'links-count', text: ` · ${linkCount} link${linkCount > 1 ? 's' : ''}` }) : null,
          t.status === 'error' ? el('div', { class: 'small muted', text: t.error || '' }) : null,
        ]),
        el('td', { class: 'hide-sm muted', text: ready ? fmt(t.duration) : '-' }),
        el('td', { class: 'hide-sm muted', text: String(t.plays) }),
        el('td', { class: 'hide-sm likes-cell', text: t.likes ? `♥ ${t.likes}` : '-' }),
        el('td', {}, el('label', { class: 'switch' }, [toggle, el('span')])),
        el('td', {}, el('div', { class: 'actions' }, [
          el('button', { class: 'btn sm', text: 'Play next', disabled: !ready || !t.enabled, onclick: () => playNext(t) }),
          el('button', { class: 'btn sm ghost', text: 'Edit', onclick: () => openEdit(t) }),
          el('button', { class: 'btn sm ghost danger', text: 'Delete', onclick: () => removeTrack(t) }),
        ])),
      ]);
    }),
  );
  updateBulkBar();
  markPlaying();
}
$('search').addEventListener('input', renderTracks);

$('selectAll').addEventListener('change', () => {
  for (const t of shownTracks()) {
    if ($('selectAll').checked) selected.add(t.id);
    else selected.delete(t.id);
  }
  renderTracks();
});
$('bulkClear').addEventListener('click', () => {
  selected.clear();
  renderTracks();
});
$('bulkMove').addEventListener('click', async () => {
  const albumId = $('bulkAlbum').value || null;
  try {
    const { moved } = await api('POST', '/tracks/album', { ids: [...selected], albumId });
    const name = albums.find((a) => a.id === albumId)?.title;
    toast(albumId ? `Moved ${moved} song(s) into "${name}"` : `Removed ${moved} song(s) from their album`);
    selected.clear();
    await refreshTracks();
    refreshAlbums();
  } catch (e) {
    toast(e.message, true);
  }
});

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

// --- uploads ----------------------------------------------------------------------------
const uploadQueue = [];
let uploading = false;

function addFiles(files) {
  for (const file of files) {
    const bar = el('progress', { max: '100', value: '0' });
    const state = el('span', { class: 'state', text: 'Waiting' });
    const row = el('div', { class: 'upload' }, [el('span', { class: 'name', text: file.name }), bar, state]);
    $('uploads').prepend(row);
    // Remember the album chosen at drop time, even if the picker changes later.
    uploadQueue.push({ file, row, bar, state, albumId: $('uploadAlbum').value || null });
  }
  pumpUploads();
}

function pumpUploads() {
  if (uploading || !uploadQueue.length) return;
  uploading = true;
  const job = uploadQueue.shift();
  const fd = new FormData();
  fd.append('audio', job.file);
  if (job.albumId) fd.append('albumId', job.albumId);
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
  albumOptions($('editAlbum'));
  f.albumId.value = t.albumId || '';
  for (const k of linkKeys) f[`link_${k}`].value = t.links[k] || '';
  renderEditArt(t);
  $('editDialog').showModal();
}

/** Artwork section of the Edit dialog: shows what listeners see and where it comes from. */
function renderEditArt(t) {
  const album = albums.find((a) => a.id === t.albumId);
  $('editArtPreview').replaceChildren(t.cover ? el('img', { src: t.cover, alt: '' }) : el('span', { text: 'No artwork' }));
  $('editArtNote').textContent = t.coverCustom
    ? 'This song uses its own artwork.'
    : album?.cover
      ? `Using the artwork of the album "${album.title}".`
      : t.cover
        ? 'Using the artwork embedded in the song file.'
        : 'No artwork yet. Upload one, or add the song to an album that has artwork.';
  $('editArtReset').hidden = !(t.coverCustom && album?.cover);
}

$('editArtInput').addEventListener('change', async () => {
  const file = $('editArtInput').files[0];
  $('editArtInput').value = '';
  if (!file || !editing) return;
  const fd = new FormData();
  fd.append('cover', file);
  try {
    await api('POST', `/tracks/${editing.id}/cover`, fd);
    await refreshTracks();
    editing = tracks.find((t) => t.id === editing.id) || editing;
    renderEditArt(editing);
    toast('Artwork updated');
  } catch (e) {
    toast(e.message, true);
  }
});

$('editArtReset').addEventListener('click', async () => {
  try {
    await api('DELETE', `/tracks/${editing.id}/cover`);
    await refreshTracks();
    editing = tracks.find((t) => t.id === editing.id) || editing;
    renderEditArt(editing);
  } catch (e) {
    toast(e.message, true);
  }
});

$('editDialog').addEventListener('close', async () => {
  if ($('editDialog').returnValue !== 'save' || !editing) return;
  const f = $('editForm').elements;
  const links = {};
  for (const k of linkKeys) links[k] = f[`link_${k}`].value.trim();
  try {
    await api('PATCH', `/tracks/${editing.id}`, { title: f.title.value, artist: f.artist.value, albumId: f.albumId.value || null, links });
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
  const r = s.reminder || {};
  f.reminderEnabled.checked = r.enabled !== false;
  f.reminderTitle.value = r.title || '';
  f.reminderMessage.value = r.message || '';
  // Keep a custom delay (set some other way) selectable.
  const delay = String(r.delaySec ?? 45);
  if (![...f.reminderDelay.options].some((o) => o.value === delay)) {
    f.reminderDelay.append(el('option', { value: delay, text: `${delay} seconds of listening` }));
  }
  f.reminderDelay.value = delay;
  $('reminderHint').textContent = !Object.keys(s.socials || {}).length
    ? 'Add at least one social link above. The reminder only appears once there is somewhere to send people.'
    : s.socials.discord ? 'Leads with your Discord link.' : 'No Discord link yet, so it leads with your first social link.';
  renderBgPreview(s.background);
  $('logoPreview').replaceChildren(
    s.logo ? el('img', { src: `/logo/${s.logo.file}?v=${s.logo.rev}`, alt: 'Current logo' }) : document.createTextNode('No logo yet'),
  );
  $('logoRemove').disabled = !s.logo;
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
      reminder: {
        enabled: f.reminderEnabled.checked,
        title: f.reminderTitle.value,
        message: f.reminderMessage.value,
        delaySec: Number(f.reminderDelay.value),
      },
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

$('logoInput').addEventListener('change', async () => {
  const file = $('logoInput').files[0];
  $('logoInput').value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('logo', file);
  try {
    await api('POST', '/settings/logo', fd);
    toast('Logo updated. Listeners see it right away.');
    await loadSettings();
    refreshStatus();
  } catch (e) {
    toast(e.message, true);
  }
});

$('logoRemove').addEventListener('click', async () => {
  if (!confirm('Remove the logo? The radio goes back to the default mark.')) return;
  try {
    await api('DELETE', '/settings/logo');
    await loadSettings();
    refreshStatus();
  } catch (e) {
    toast(e.message, true);
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

// --- likes & favorites summary ------------------------------------------------------------
let engagement = null;
let engKey = '';
const ICON = {
  heart: 'M12 20.5s-7.5-4.6-9.3-9.4C1.6 8.2 3.4 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.6 0 5.4 3.7 4.3 6.6-1.8 4.8-9.3 9.4-9.3 9.4z',
  star: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z',
  train: 'M6 16V7a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v9M6 12h12M8 20l-2 2M16 20l2 2M9 16.5h.01M15 16.5h.01',
  people: 'M16 19v-1a4 4 0 0 0-8 0v1M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 19v-1a3 3 0 0 0-2.4-2.9M17 4.2a3 3 0 0 1 0 5.6',
};
function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}
const num = (n) => Number(n || 0).toLocaleString();

function statCard(kind, iconPath, label, value, sub) {
  return el('div', { class: `stat-card ${kind}` }, [
    el('span', { class: 'label' }, [icon(iconPath), el('span', { text: label })]),
    el('span', { class: 'value', text: value }),
    sub ? el('span', { class: 'sub', text: sub }) : null,
  ]);
}

async function refreshEngagement() {
  engagement = await api('GET', '/engagement');
  renderEngagement();
}

function renderEngagement() {
  const e = engagement;
  if (!e) return;
  const sort = $('engSort').value;
  const key = JSON.stringify([e, sort]);
  if (key === engKey) return;
  engKey = key;

  const week = e.daily.slice(-7).reduce((n, d) => n + d.likes, 0);
  $('statGrid').replaceChildren(
    statCard('likes', ICON.heart, 'Total likes', num(e.totalLikes), `${num(e.likesToday)} today · ${num(week)} this week`),
    statCard('favs', ICON.star, 'Favorites', num(e.totalFavorites), `saved by ${num(e.favoritingListeners)} listener${e.favoritingListeners === 1 ? '' : 's'}`),
    statCard('hype', ICON.train, 'Hype trains today', num(e.hypeToday), `${num(e.daily.reduce((n, d) => n + d.hype, 0))} in the last 14 days`),
    statCard('hype', ICON.train, 'Record hype train', e.record ? `Lv ${e.record.level}` : '-', e.record ? `${e.record.title} · ${new Date(e.record.at).toLocaleDateString()}` : 'No hype trains yet'),
  );

  const rate = (s) => (s.plays ? s.likes / s.plays : 0);
  const songs = [...e.songs].sort((a, b) =>
    sort === 'favorites' ? b.favorites - a.favorites || b.likes - a.likes
    : sort === 'plays' ? b.plays - a.plays
    : sort === 'rate' ? rate(b) - rate(a)
    : b.likes - a.likes || b.favorites - a.favorites,
  );
  $('engEmpty').hidden = songs.length > 0;
  $('engRows').replaceChildren(
    ...songs.map((s) => {
      const thumb = el('span');
      if (s.cover) thumb.style.backgroundImage = `url("${s.cover}")`;
      return el('tr', {}, [
        el('td', { class: 'thumb-cell' }, thumb),
        el('td', { class: 't-title' }, [el('b', { text: s.title }), el('span', { text: s.artist || 'Unknown artist' })]),
        el('td', { class: 'num likes', text: s.likes ? `♥ ${num(s.likes)}` : '-' }),
        el('td', { class: 'num favs', text: s.favorites ? `★ ${num(s.favorites)}` : '-' }),
        el('td', { class: 'num muted hide-sm', text: num(s.plays) }),
        el('td', { class: 'num muted hide-sm', text: s.plays ? rate(s).toFixed(1) : '-' }),
        el('td', {}, el('div', { class: 'actions' }, [
          el('button', { class: 'btn sm ghost danger', text: 'Reset likes', disabled: !s.likes, onclick: () => resetLikes(s) }),
        ])),
      ]);
    }),
  );
}
$('engSort').addEventListener('change', renderEngagement);

async function resetLikes(s) {
  if (!confirm(`Reset all ${num(s.likes)} likes on "${s.title}"? This can't be undone.`)) return;
  try {
    await api('POST', '/likes/reset', { trackId: s.id });
    toast(`Likes reset for "${s.title}"`);
    refreshEngagement();
    refreshTracks();
  } catch (err) {
    toast(err.message, true);
  }
}

$('resetAllLikes').addEventListener('click', async () => {
  const total = engagement?.totalLikes || 0;
  if (!confirm(`Reset ALL likes on every song (${num(total)} total), the leaderboard, daily stats and the hype train record? Favorites are not affected. This can't be undone.`)) return;
  try {
    await api('POST', '/likes/reset', { all: true });
    toast('All likes reset');
    refreshEngagement();
    refreshTracks();
  } catch (err) {
    toast(err.message, true);
  }
});

// Load when the tab opens, and keep it fresh while it's visible.
document.querySelector('[data-tab=engagement]').addEventListener('click', () => refreshEngagement().catch((e) => toast(e.message, true)));
setInterval(() => {
  if (!document.querySelector('[data-panel=engagement]').hidden && !$('appView').hidden) refreshEngagement().catch(() => {});
}, 5000);

// --- bulk delete (Library) --------------------------------------------------------------------
$('bulkDelete').addEventListener('click', async () => {
  const ids = [...selected];
  if (!ids.length) return;
  const names = tracks.filter((t) => selected.has(t.id)).map((t) => `• ${t.title}`);
  const preview = names.slice(0, 8).join('\n') + (names.length > 8 ? `\n…and ${names.length - 8} more` : '');
  if (!confirm(`Delete ${ids.length} song${ids.length === 1 ? '' : 's'} from the station? Their files, likes and favorite counts are removed. This can't be undone.\n\n${preview}`)) return;
  try {
    const { deleted } = await api('POST', '/tracks/delete', { ids });
    selected.clear();
    toast(`Deleted ${deleted} song${deleted === 1 ? '' : 's'}`);
    await refreshTracks();
    refreshAlbums();
  } catch (err) {
    toast(err.message, true);
  }
});

boot().catch((e) => toast(e.message, true));
