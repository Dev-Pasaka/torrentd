'use strict'

const $ = id => document.getElementById(id)

let state = { torrents: [], totals: {}, settings: {} }
let filter = 'all'
let browsePath = null

/* ---------- formatting ---------- */

function bytes (n) {
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  const v = n / 1024 ** i
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

const speed = n => `${bytes(n)}/s`

function duration (ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** Trims a long path from the left, so the folder you are standing in stays visible. */
function elideLeft (text, max = 58) {
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`
}

function shortMagnet (magnet) {
  const m = /xt=urn:btih:([^&]+)/i.exec(magnet)
  return m ? `${m[1].slice(0, 16)}…` : magnet.slice(0, 40)
}

/* ---------- toasts ---------- */

function toast (message, kind = '') {
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = message
  $('toasts').append(el)
  setTimeout(() => {
    el.style.transition = 'opacity .3s'
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 300)
  }, 4200)
}

/* ---------- api ---------- */

// The UI is served from wherever it is mounted: "/" when you hit the container
// directly, "/torrentd/" behind a reverse proxy. Resolving every request
// against this script's own URL keeps both working. Root-absolute "/api/…"
// would escape the mount point and hit whatever the proxy serves at the site
// root instead — nginx answers a POST there with 405, not a torrentd error.
const BASE = new URL('.', document.currentScript?.src || location.href)

const url = path => new URL(path.replace(/^\//, ''), BASE)

async function api (path, options = {}) {
  const res = await fetch(url(path), {
    headers: { 'content-type': 'application/json' },
    ...options
  })
  let body = null
  try { body = await res.json() } catch {}
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`)
  return body
}

/* ---------- websocket ---------- */

let ws = null
let retryDelay = 1000

async function connect () {
  try {
    const { token } = await api('/api/ws-token')
    const wsUrl = url('/ws')
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    wsUrl.searchParams.set('token', token)
    ws = new WebSocket(wsUrl)
  } catch {
    setConn(false)
    return void setTimeout(connect, retryDelay = Math.min(retryDelay * 2, 15000))
  }

  ws.onopen = () => { retryDelay = 1000; setConn(true) }
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.type === 'state') {
      state = msg
      render()
    }
  }
  ws.onclose = () => {
    setConn(false)
    setTimeout(connect, retryDelay = Math.min(retryDelay * 2, 15000))
  }
  ws.onerror = () => ws.close()
}

function setConn (live) {
  const dot = $('conn-dot')
  dot.className = `brand-dot ${live ? 'live' : 'dead'}`
  dot.title = live ? 'connected — live updates' : 'disconnected — retrying…'
}

/* ---------- render ---------- */

// One DOM node per torrent, reused across updates and keyed by id. Rebuilding
// the list's innerHTML each tick replayed the card's entry animation once a
// second (visible flicker) and threw away the progress bar mid-transition, so
// the bar could never animate between two values.
const nodes = new Map() // id -> { el, parts, cache }

function render () {
  const { totals, torrents } = state
  $('g-down').textContent = speed(totals.downloadSpeed || 0)
  $('g-up').textContent = speed(totals.uploadSpeed || 0)
  $('g-active').textContent = totals.active ?? 0
  $('g-queued').textContent = totals.queued ?? 0
  $('g-done').textContent = totals.done ?? 0

  const visible = torrents.filter(t => filter === 'all' || t.status === filter)
  $('empty').hidden = visible.length > 0
  if (!visible.length) {
    const label = filter === 'all' ? 'Nothing in the queue yet.' : `No ${filter} items.`
    $('empty').querySelector('p').textContent = label
  }

  const list = $('list')
  const seen = new Set()

  visible.forEach((t, index) => {
    seen.add(t.id)
    let node = nodes.get(t.id)
    if (!node) {
      node = createNode(t.id)
      nodes.set(t.id, node)
    }
    updateNode(node, t)
    // Only touch the DOM order when it is actually wrong — re-inserting a node
    // that is already in place restarts its CSS animations.
    if (list.children[index] !== node.el) {
      list.insertBefore(node.el, list.children[index] || null)
    }
  })

  for (const [id, node] of nodes) {
    if (!seen.has(id)) {
      node.el.remove()
      nodes.delete(id)
    }
  }
}

function createNode (id) {
  const el = document.createElement('div')
  el.className = 'item'
  el.dataset.id = id
  // The meta row's spans exist up front and only ever have their text swapped.
  // Rebuilding it from a string each tick churned ~7 elements per second, which
  // drops any text selection the user is making.
  el.innerHTML = `
    <div class="item-top">
      <div class="item-name"></div>
      <span class="pill"></span>
      <div class="actions"></div>
    </div>
    <div class="bar"><div class="bar-fill"></div></div>
    <div class="meta">
      <span class="m-pct"><b></b></span>
      <span class="m-size"></span>
      <span class="m-down sp-down"></span>
      <span class="m-up sp-up"></span>
      <span class="m-peers"></span>
      <span class="m-eta"></span>
      <span class="m-note"></span>
      <span class="m-err err"></span>
      <span class="path m-path"></span>
    </div>`

  return {
    el,
    parts: {
      name: el.querySelector('.item-name'),
      pill: el.querySelector('.pill'),
      actions: el.querySelector('.actions'),
      fill: el.querySelector('.bar-fill'),
      pct: el.querySelector('.m-pct b'),
      pctWrap: el.querySelector('.m-pct'),
      size: el.querySelector('.m-size'),
      down: el.querySelector('.m-down'),
      up: el.querySelector('.m-up'),
      peers: el.querySelector('.m-peers'),
      eta: el.querySelector('.m-eta'),
      note: el.querySelector('.m-note'),
      err: el.querySelector('.m-err'),
      path: el.querySelector('.m-path')
    },
    cache: {}
  }
}

/** Sets text only when it changed, and hides the span when there is nothing to say. */
function field (el, text) {
  const show = text !== null && text !== undefined && text !== ''
  if (el.hidden === show) el.hidden = !show
  if (show && el.textContent !== text) el.textContent = text
}

/** Writes only the fields that actually changed, so untouched DOM stays put. */
function updateNode ({ el, parts, cache }, t) {
  const pct = Math.round((t.progress || 0) * 1000) / 10
  const label = t.seeding ? 'seeding' : t.status

  const className = `item is-${t.status}`
  if (cache.className !== className) {
    el.className = className
    cache.className = className
  }

  const name = t.name || shortMagnet(t.magnet)
  if (cache.name !== name) {
    parts.name.textContent = name
    parts.name.title = t.name || t.magnet
    parts.name.classList.toggle('pending', !t.name)
    cache.name = name
  }

  if (cache.label !== label) {
    parts.pill.textContent = label
    parts.pill.className = `pill ${label}`
    cache.label = label
  }

  // The queued bar is a CSS-driven waiting sweep with no meaningful width, so
  // any inline width from a previous status has to come back off.
  if (t.status === 'queued') {
    if (cache.width !== null) {
      parts.fill.style.removeProperty('width')
      cache.width = null
    }
  } else if (cache.width !== pct) {
    parts.fill.style.width = `${pct}%`
    cache.width = pct
  }

  const actionsHtml = actions(t)
  if (cache.actions !== actionsHtml) {
    parts.actions.innerHTML = actionsHtml
    cache.actions = actionsHtml
  }

  updateMeta(parts, t, pct)
}

function updateMeta (parts, t, pct) {
  if (t.status === 'error') {
    field(parts.err, `✕ ${t.error || 'Download failed'}`)
    for (const key of ['pctWrap', 'size', 'down', 'up', 'peers', 'eta', 'note', 'path']) {
      field(parts[key], null)
    }
    return
  }
  field(parts.err, null)

  const queued = t.status === 'queued'
  if (parts.pctWrap.hidden !== queued) parts.pctWrap.hidden = queued
  if (!queued) {
    const text = `${pct.toFixed(1)}%`
    if (parts.pct.textContent !== text) parts.pct.textContent = text
  }

  field(parts.size, queued
    ? null
    : t.totalBytes
      ? `${bytes(t.downloadedBytes)} of ${bytes(t.totalBytes)}`
      : 'fetching metadata…')

  const live = t.status === 'downloading'
  field(parts.down, live ? `↓ ${speed(t.downloadSpeed)}` : null)
  field(parts.up, live || t.seeding ? `↑ ${speed(t.uploadSpeed)}` : null)
  field(parts.peers, live || t.seeding ? `${t.peers} peer${t.peers === 1 ? '' : 's'}` : null)
  field(parts.eta, live ? `ETA ${duration(t.timeRemaining)}` : null)

  field(parts.note, queued
    ? 'Waiting for a free slot'
    : t.status === 'done' && t.completedAt && t.startedAt
      ? `finished in ${duration(t.completedAt - t.startedAt)}`
      : null)

  field(parts.path, elideLeft(t.savePath, 64))
  parts.path.title = t.savePath
}

function actions (t) {
  const btn = (action, title, glyph) =>
    `<button class="icon-btn" data-action="${action}" title="${title}">${glyph}</button>`

  const out = []
  if (t.status === 'downloading' || t.status === 'queued') out.push(btn('pause', 'Pause', '⏸'))
  if (t.status === 'paused') out.push(btn('resume', 'Resume', '▶'))
  if (t.status === 'error') out.push(btn('retry', 'Retry', '↻'))
  if (t.status === 'queued' || t.status === 'paused') {
    out.push(btn('up', 'Move up', '↑'))
    out.push(btn('down', 'Move down', '↓'))
  }
  if (t.status === 'done') out.push(btn('relocate', 'Move to a library folder…', '🗂'))
  out.push(btn('remove', 'Remove from list (keeps files)', '✕'))
  return out.join('')
}

/* ---------- item actions ---------- */

$('list').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]')
  if (!button) return
  const id = button.closest('.item').dataset.id
  const action = button.dataset.action

  try {
    if (action === 'remove') {
      const item = state.torrents.find(t => String(t.id) === id)
      const withFiles = item && (item.status === 'done' || item.progress > 0)
        ? confirm(`Remove "${item.name || 'this item'}" from the list.\n\nOK = also delete downloaded files\nCancel = keep the files on disk`)
        : false
      await api(`/api/torrents/${id}?files=${withFiles ? '1' : '0'}`, { method: 'DELETE' })
    } else if (action === 'up' || action === 'down') {
      await api(`/api/torrents/${id}/move`, {
        method: 'POST',
        body: JSON.stringify({ direction: action })
      })
    } else if (action === 'relocate') {
      const item = state.torrents.find(t => String(t.id) === id)
      openRelocatePicker(Number(id), item?.name || 'this download')
    } else {
      await api(`/api/torrents/${id}/${action}`, { method: 'POST' })
    }
  } catch (err) {
    toast(err.message, 'error')
  }
})

/* ---------- add ---------- */

async function addMagnets () {
  const input = $('magnet-input')
  const value = input.value.trim()
  if (!value) return toast('Paste a magnet link first', 'error')

  const button = $('btn-add')
  button.disabled = true
  try {
    const result = await api('/api/torrents', {
      method: 'POST',
      body: JSON.stringify({ magnets: value })
    })
    if (result.added) {
      toast(`Added ${result.added} torrent${result.added === 1 ? '' : 's'} to the queue`, 'ok')
      input.value = ''
    }
    result.skipped?.forEach(s => toast(s.reason, ''))
    result.failed?.forEach(f => toast(f.reason, 'error'))
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    button.disabled = false
  }
}

$('btn-add').addEventListener('click', addMagnets)
$('magnet-input').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') addMagnets()
})

$('btn-clear').addEventListener('click', async () => {
  try {
    await api('/api/clear-completed', { method: 'POST' })
    toast('Cleared completed items (files kept)', 'ok')
  } catch (err) {
    toast(err.message, 'error')
  }
})

$('filters').addEventListener('click', event => {
  const tab = event.target.closest('.tab')
  if (!tab) return
  filter = tab.dataset.filter
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab))
  render()
})

/* ---------- modals ---------- */

function open (id) { $(id).hidden = false }
function close (id) { $(id).hidden = true }

document.addEventListener('click', event => {
  const closer = event.target.closest('[data-close]')
  if (closer) close(closer.dataset.close)
  if (event.target.classList.contains('modal-backdrop')) event.target.hidden = true
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop').forEach(m => { m.hidden = true })
})

/* ---------- settings ---------- */

// Delegated for the same reason as the nav handler above — both nav bars
// have a "Settings" entry marked with data-open-settings.
document.addEventListener('click', async event => {
  if (!event.target.closest('[data-open-settings]')) return
  try {
    const s = await api('/api/settings')
    $('s-path').value = s.downloadPath
    $('s-concurrent').value = s.maxConcurrent
    $('s-seed').value = s.seedAfterDownload ? '1' : '0'
    $('s-user').value = s.username
    $('s-pass').value = ''
    $('settings-msg').textContent = ''
    open('settings-modal')
  } catch (err) {
    toast(err.message, 'error')
  }
})

$('btn-save-settings').addEventListener('click', async () => {
  const msg = $('settings-msg')
  msg.className = 'modal-msg'
  msg.textContent = ''

  const payload = {
    downloadPath: $('s-path').value.trim(),
    maxConcurrent: Number($('s-concurrent').value),
    seedAfterDownload: $('s-seed').value === '1',
    username: $('s-user').value.trim()
  }
  if ($('s-pass').value) payload.password = $('s-pass').value

  try {
    const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) })
    close('settings-modal')
    toast('Settings saved', 'ok')
    if (result.credentialsChanged && $('s-pass').value) {
      toast('Login changed — reload the page to sign in again', '')
    }
  } catch (err) {
    msg.textContent = err.message
  }
})

/* ---------- folder picker ---------- */

async function browse (target) {
  const msg = $('browse-msg')
  msg.className = 'modal-msg'
  try {
    const data = await api(`/api/fs?path=${encodeURIComponent(target ?? '')}`)
    browsePath = data.path
    $('browse-path').textContent = elideLeft(data.path)
    $('browse-path').title = data.path
    $('btn-up').disabled = !data.parent
    $('btn-up').dataset.parent = data.parent || ''
    $('btn-pick').disabled = !data.writable
    msg.textContent = data.writable ? '' : 'This folder is not writable'

    $('browse-list').innerHTML = data.dirs.length
      ? data.dirs.map(d =>
          `<button class="dir-row" data-path="${escapeHtml(d.path)}"><span>📁</span>${escapeHtml(d.name)}</button>`
        ).join('')
      : '<div class="dir-empty">No sub-folders here</div>'
  } catch (err) {
    msg.textContent = err.message
  }
}

$('btn-browse').addEventListener('click', () => {
  open('browse-modal')
  browse($('s-path').value.trim() || undefined)
})

$('browse-list').addEventListener('click', event => {
  const dir = event.target.closest('[data-path]')
  if (dir) browse(dir.dataset.path)
})

$('btn-up').addEventListener('click', () => {
  const parent = $('btn-up').dataset.parent
  if (parent) browse(parent)
})

$('btn-home').addEventListener('click', () => browse())

$('btn-mkdir').addEventListener('click', async () => {
  const name = $('new-folder').value.trim()
  if (!name) return
  try {
    const { path } = await api('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ parent: browsePath, name })
    })
    $('new-folder').value = ''
    browse(path)
  } catch (err) {
    $('browse-msg').textContent = err.message
  }
})

$('btn-pick').addEventListener('click', () => {
  $('s-path').value = browsePath
  close('browse-modal')
})

/* ---------- library files (scoped to LIBRARY_DIRS — browse, delete, copy, move) ---------- */

let libraries = []
let currentLibrary = null
let currentPath = ''
let currentEntries = [] // last-fetched listing, re-rendered locally on selection changes (no refetch)
let confirmingDelete = null // relative path of the row currently showing "delete this?"
let selected = new Set() // relative paths selected for a bulk action, scoped to the current folder
let confirmingBulkDelete = false

const pathUp = p => p.split('/').filter(Boolean).slice(0, -1).join('/')
const joinPath = (p, name) => (p ? `${p}/${name}` : name)
const dateStr = ms => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

function fileRowHtml (entry) {
  const rel = joinPath(currentPath, entry.name)
  const meta = entry.isDir ? '' : `${bytes(entry.size)} · ${dateStr(entry.mtime)}`
  const actions = confirmingDelete === rel
    ? `
      <span class="file-confirm">Delete permanently?</span>
      <button class="btn small danger" data-confirm-delete="${escapeHtml(rel)}">Yes</button>
      <button class="btn small ghost" data-cancel-delete>No</button>`
    : `
      <button class="icon-btn" data-copy-item="${escapeHtml(rel)}" data-is-dir="${entry.isDir}" title="Copy to…">⧉</button>
      <button class="icon-btn" data-move-item="${escapeHtml(rel)}" data-is-dir="${entry.isDir}" title="Move to…">⇢</button>
      <button class="icon-btn" data-delete-item="${escapeHtml(rel)}" title="Delete">🗑</button>`

  return `
    <div class="file-row${entry.isDir ? ' file-row-dir' : ''}" data-path="${escapeHtml(rel)}" data-is-dir="${entry.isDir}">
      <input type="checkbox" class="file-select" data-select="${escapeHtml(rel)}"${selected.has(rel) ? ' checked' : ''}>
      <span class="file-icon">${entry.isDir ? '📁' : '📄'}</span>
      <span class="file-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
      <span class="file-meta">${meta}</span>
      <span class="file-actions">${actions}</span>
    </div>`
}

function renderSelectionBar () {
  const bar = $('files-selection-bar')
  bar.hidden = selected.size === 0
  if (!selected.size) return

  $('files-selection-count').textContent = `${selected.size} selected`
  const allSelected = currentEntries.length > 0 && currentEntries.every(e => selected.has(joinPath(currentPath, e.name)))
  $('files-select-all').checked = allSelected

  bar.querySelector('.selection-actions').innerHTML = confirmingBulkDelete
    ? `
      <span class="file-confirm">Delete ${selected.size} item${selected.size === 1 ? '' : 's'} permanently?</span>
      <button class="btn small danger" id="files-bulk-delete-confirm">Yes</button>
      <button class="btn small ghost" id="files-bulk-delete-cancel">No</button>`
    : `
      <button class="btn small" id="files-bulk-move">Move…</button>
      <button class="btn small danger" id="files-bulk-delete">Delete</button>
      <button class="btn small ghost" id="files-clear-selection">Cancel</button>`
}

function renderFileList () {
  $('files-list').innerHTML = currentEntries.length
    ? currentEntries.map(fileRowHtml).join('')
    : '<div class="dir-empty">Empty folder</div>'
  renderSelectionBar()
}

async function ensureLibraries () {
  if (libraries.length) return
  try {
    const { libraries: list } = await api('/api/files/libraries')
    libraries = list
  } catch {
    libraries = []
  }
}

async function loadFileLibraries () {
  await ensureLibraries()
  if (!currentLibrary || !libraries.includes(currentLibrary)) currentLibrary = libraries[0] || null
  $('library-tabs').innerHTML = libraries.map(name =>
    `<button class="tab${name === currentLibrary ? ' active' : ''}" data-library="${escapeHtml(name)}">${escapeHtml(name)}</button>`
  ).join('')

  if (!libraries.length) {
    $('files-msg').textContent = 'No library directories configured — set LIBRARY_DIRS to enable this page.'
    currentEntries = []
    $('files-list').innerHTML = ''
    $('files-selection-bar').hidden = true
    return
  }
  loadFiles('')
}

async function loadFiles (relPath) {
  confirmingDelete = null
  confirmingBulkDelete = false
  selected = new Set() // selections are scoped to one folder listing — navigating clears them
  const msg = $('files-msg')
  msg.textContent = ''
  try {
    const { entries } = await api(`/api/files/list?library=${encodeURIComponent(currentLibrary)}&path=${encodeURIComponent(relPath)}`)
    currentPath = relPath
    currentEntries = entries
    $('files-path').textContent = `${currentLibrary}/${currentPath}`
    $('files-up').disabled = !currentPath
    renderFileList()
  } catch (err) {
    msg.textContent = err.message
  }
}

$('files-back').addEventListener('click', event => {
  event.preventDefault()
  location.hash = ''
})

$('library-tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-library]')
  if (!tab) return
  currentLibrary = tab.dataset.library
  document.querySelectorAll('#library-tabs .tab').forEach(t => t.classList.toggle('active', t === tab))
  loadFiles('')
})

$('files-up').addEventListener('click', () => loadFiles(pathUp(currentPath)))
$('files-home').addEventListener('click', () => loadFiles(''))

$('files-mkdir').addEventListener('click', async () => {
  const input = $('files-new-folder')
  const name = input.value.trim()
  if (!name) return
  try {
    await api('/api/files/mkdir', {
      method: 'POST',
      body: JSON.stringify({ library: currentLibrary, path: currentPath, name })
    })
    input.value = ''
    loadFiles(currentPath)
  } catch (err) {
    $('files-msg').textContent = err.message
  }
})

$('files-list').addEventListener('change', event => {
  const box = event.target.closest('[data-select]')
  if (!box) return
  if (box.checked) selected.add(box.dataset.select)
  else selected.delete(box.dataset.select)
  renderSelectionBar()
})

$('files-list').addEventListener('click', event => {
  if (event.target.closest('[data-select]')) return // handled by the 'change' listener above

  const confirmBtn = event.target.closest('[data-confirm-delete]')
  if (confirmBtn) {
    api(`/api/files/item?library=${encodeURIComponent(currentLibrary)}&path=${encodeURIComponent(confirmBtn.dataset.confirmDelete)}`, { method: 'DELETE' })
      .then(() => { toast('Deleted', 'ok'); loadFiles(currentPath) })
      .catch(err => { $('files-msg').textContent = err.message })
    return
  }
  if (event.target.closest('[data-cancel-delete]')) {
    confirmingDelete = null
    renderFileList()
    return
  }
  const deleteBtn = event.target.closest('[data-delete-item]')
  if (deleteBtn) {
    confirmingDelete = deleteBtn.dataset.deleteItem
    renderFileList()
    return
  }
  const copyBtn = event.target.closest('[data-copy-item]')
  if (copyBtn) return openFileTransferPicker('copy', copyBtn.dataset.copyItem)
  const moveBtn = event.target.closest('[data-move-item]')
  if (moveBtn) return openFileTransferPicker('move', moveBtn.dataset.moveItem)

  const row = event.target.closest('.file-row-dir')
  if (row) loadFiles(row.dataset.path)
})

/* ---------- multi-select bulk actions ---------- */

$('files-select-all').addEventListener('change', event => {
  if (event.target.checked) {
    currentEntries.forEach(e => selected.add(joinPath(currentPath, e.name)))
  } else {
    selected.clear()
  }
  renderFileList()
})

$('files-selection-bar').addEventListener('click', event => {
  if (event.target.closest('#files-clear-selection')) {
    selected = new Set()
    renderFileList()
    return
  }
  if (event.target.closest('#files-bulk-delete')) {
    confirmingBulkDelete = true
    renderSelectionBar()
    return
  }
  if (event.target.closest('#files-bulk-delete-cancel')) {
    confirmingBulkDelete = false
    renderSelectionBar()
    return
  }
  if (event.target.closest('#files-bulk-delete-confirm')) {
    const items = [...selected].map(p => ({ library: currentLibrary, path: p }))
    api('/api/files/bulk-delete', { method: 'POST', body: JSON.stringify({ items }) })
      .then(({ deleted, failed }) => {
        toast(failed.length ? `Deleted ${deleted}, ${failed.length} failed` : `Deleted ${deleted}`, failed.length ? 'error' : 'ok')
        loadFiles(currentPath)
      })
      .catch(err => { $('files-msg').textContent = err.message })
    return
  }
  if (event.target.closest('#files-bulk-move')) {
    const items = [...selected].map(p => ({ library: currentLibrary, path: p }))
    openDestPicker({
      title: `Move ${items.length} item${items.length === 1 ? '' : 's'} to…`,
      confirmLabel: 'Move here',
      initialLibrary: currentLibrary,
      initialPath: currentPath,
      onConfirm: async ({ destLibrary, destPath }) => {
        const { moved, failed } = await api('/api/files/bulk-move', {
          method: 'POST',
          body: JSON.stringify({ items, destLibrary, destPath })
        })
        toast(failed.length ? `Moved ${moved}, ${failed.length} failed` : `Moved ${moved}`, failed.length ? 'error' : 'ok')
        selected = new Set()
        loadFiles(currentPath)
      }
    })
  }
})

/* ---------- destination picker (shared: Files copy/move, torrent relocate) ---------- */

let destLibrary = null
let destPath = ''
let destOnConfirm = null // async ({ destLibrary, destPath }) => void

async function openDestPicker ({ title, confirmLabel, initialLibrary, initialPath, onConfirm }) {
  await ensureLibraries()
  if (!libraries.length) return toast('No library directories configured (set LIBRARY_DIRS)', 'error')

  destLibrary = initialLibrary && libraries.includes(initialLibrary) ? initialLibrary : libraries[0]
  destPath = initialPath || ''
  destOnConfirm = onConfirm

  $('files-dest-title').textContent = title
  $('dest-confirm').textContent = confirmLabel
  $('dest-msg').textContent = ''
  $('dest-library-tabs').innerHTML = libraries.map(name =>
    `<button class="tab${name === destLibrary ? ' active' : ''}" data-dest-library="${escapeHtml(name)}">${escapeHtml(name)}</button>`
  ).join('')
  loadDestFiles(destPath)
  open('files-dest-modal')
}

function openFileTransferPicker (action, srcPath) {
  openDestPicker({
    title: action === 'copy' ? 'Copy to…' : 'Move to…',
    confirmLabel: action === 'copy' ? 'Copy here' : 'Move here',
    initialLibrary: currentLibrary,
    initialPath: currentPath,
    onConfirm: async ({ destLibrary, destPath }) => {
      await api(`/api/files/${action}`, {
        method: 'POST',
        body: JSON.stringify({ srcLibrary: currentLibrary, srcPath, destLibrary, destPath })
      })
      toast(action === 'copy' ? 'Copied' : 'Moved', 'ok')
      loadFiles(currentPath)
    }
  })
}

function openRelocatePicker (id, name) {
  openDestPicker({
    title: `Move "${name}" to…`,
    confirmLabel: 'Move here',
    initialLibrary: null,
    initialPath: '',
    onConfirm: async ({ destLibrary, destPath }) => {
      await api(`/api/torrents/${id}/relocate`, {
        method: 'POST',
        body: JSON.stringify({ destLibrary, destPath })
      })
      toast('Moved', 'ok')
    }
  })
}

async function loadDestFiles (relPath) {
  const msg = $('dest-msg')
  try {
    const { entries } = await api(`/api/files/list?library=${encodeURIComponent(destLibrary)}&path=${encodeURIComponent(relPath)}`)
    destPath = relPath
    $('dest-path').textContent = `${destLibrary}/${destPath}`
    $('dest-up').disabled = !destPath
    const dirs = entries.filter(e => e.isDir)
    $('dest-list').innerHTML = dirs.length
      ? dirs.map(d => `<button class="dir-row" data-path="${escapeHtml(joinPath(destPath, d.name))}"><span>📁</span>${escapeHtml(d.name)}</button>`).join('')
      : '<div class="dir-empty">No sub-folders here</div>'
  } catch (err) {
    msg.textContent = err.message
  }
}

$('dest-library-tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-dest-library]')
  if (!tab) return
  destLibrary = tab.dataset.destLibrary
  document.querySelectorAll('#dest-library-tabs .tab').forEach(t => t.classList.toggle('active', t === tab))
  loadDestFiles('')
})

$('dest-list').addEventListener('click', event => {
  const dir = event.target.closest('[data-path]')
  if (dir) loadDestFiles(dir.dataset.path)
})

$('dest-up').addEventListener('click', () => loadDestFiles(pathUp(destPath)))
$('dest-home').addEventListener('click', () => loadDestFiles(''))

$('dest-mkdir').addEventListener('click', async () => {
  const input = $('dest-new-folder')
  const name = input.value.trim()
  if (!name) return
  try {
    await api('/api/files/mkdir', {
      method: 'POST',
      body: JSON.stringify({ library: destLibrary, path: destPath, name })
    })
    input.value = ''
    loadDestFiles(joinPath(destPath, name)) // step into the new folder — it's almost always the intended destination
  } catch (err) {
    $('dest-msg').textContent = err.message
  }
})

$('dest-confirm').addEventListener('click', async () => {
  const button = $('dest-confirm')
  button.disabled = true
  try {
    await destOnConfirm({ destLibrary, destPath })
    close('files-dest-modal')
  } catch (err) {
    $('dest-msg').textContent = err.message
  } finally {
    button.disabled = false
  }
})

/* ---------- media browse (search + Jellyfin-style naming) ---------- */

let mediaType = 'multi'
let mediaResults = []
let networks = []
let activeNetwork = null

const pad2 = n => String(n).padStart(2, '0')

/** Turns a title into dot-separated words the way scene/Jellyfin names do. */
function slug (text) {
  return String(text || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[’'"!?,:]/g, '')
    .trim()
    .replace(/[\s._-]+/g, '.')
}

const movieName = item => slug(item.title) + (item.year ? `.${item.year}` : '')
const episodeName = (showTitle, season, ep) => `${slug(showTitle)}.S${pad2(season)}E${pad2(ep)}`
const seasonName = (showTitle, season) => `${slug(showTitle)}.Season.${season}`

async function copyText (text) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`Copied "${text}"`, 'ok')
  } catch {
    toast('Could not copy — clipboard access was denied', 'error')
  }
}

function mediaCardHtml (item) {
  const poster = item.poster
    ? `<img src="${item.poster}" alt="" loading="lazy">`
    : `<div class="no-poster">${item.type === 'movie' ? '🎬' : '📺'}</div>`
  const rating = item.rating ? `<span class="media-card-rating">★ ${item.rating.toFixed(1)}</span>` : ''
  const overview = item.overview
    ? `<div class="media-card-overview">${escapeHtml(item.overview)}</div>`
    : ''
  return `
    <button class="media-card" data-id="${item.id}" data-type="${item.type}">
      <div class="media-card-poster">
        ${poster}
        ${rating}
        ${overview}
      </div>
      <div class="media-card-info">
        <div class="media-card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="media-card-year">${item.year || '—'} · ${item.type === 'movie' ? 'Movie' : 'Show'}</div>
      </div>
    </button>`
}

function renderMediaGrid () {
  $('media-grid').innerHTML = mediaResults.length
    ? mediaResults.map(mediaCardHtml).join('')
    : '<div class="dir-empty">No results</div>'
}

async function loadTrending () {
  activeNetwork = null
  renderNetworkChips()
  $('media-heading').textContent = 'Trending this week'
  try {
    const { results } = await api('/api/browse/trending')
    mediaResults = results
  } catch (err) {
    $('media-heading').textContent = err.message
    mediaResults = []
  }
  renderMediaGrid()
}

let mediaSearchTimer = null
const scheduleMediaSearch = () => {
  clearTimeout(mediaSearchTimer)
  mediaSearchTimer = setTimeout(runMediaSearch, 300)
}

async function runMediaSearch () {
  const query = $('media-query').value.trim()
  if (!query) return loadTrending()

  activeNetwork = null
  renderNetworkChips()
  $('media-heading').textContent = `Results for "${query}"`
  try {
    const { results } = await api(`/api/browse/search?q=${encodeURIComponent(query)}&type=${mediaType}`)
    mediaResults = results
  } catch (err) {
    $('media-heading').textContent = err.message
    mediaResults = []
  }
  renderMediaGrid()
}

function renderNetworkChips () {
  const chips = [{ id: null, name: 'All' }, ...networks]
  $('network-row').innerHTML = chips.map(n => `
    <button class="network-chip${activeNetwork === n.id ? ' active' : ''}" data-network="${n.id ?? ''}">${escapeHtml(n.name)}</button>`
  ).join('')
}

async function loadNetworkChips () {
  if (networks.length) return
  try {
    const { networks: list } = await api('/api/browse/networks')
    networks = list
  } catch {
    networks = []
  }
  renderNetworkChips()
}

async function loadNetwork (id) {
  const network = networks.find(n => n.id === id)
  if (!network) return loadTrending()

  activeNetwork = id
  renderNetworkChips()
  mediaType = 'tv'
  document.querySelectorAll('#media-type .tab').forEach(t => t.classList.toggle('active', t.dataset.type === 'tv'))
  $('media-query').value = ''
  $('media-heading').textContent = `Popular on ${network.name}`
  try {
    const { results } = await api(`/api/browse/network/${id}`)
    mediaResults = results
  } catch (err) {
    $('media-heading').textContent = err.message
    mediaResults = []
  }
  renderMediaGrid()
}

// Delegated so it covers both .topnav (desktop) and .bottom-nav (mobile) —
// they share the same data-nav values rather than duplicating handlers.
const NAV_HASH = { home: '', browse: '#/browse', files: '#/files' }
document.addEventListener('click', event => {
  const navBtn = event.target.closest('[data-nav]')
  if (navBtn) location.hash = NAV_HASH[navBtn.dataset.nav]
})

$('media-back').addEventListener('click', event => {
  event.preventDefault()
  location.hash = ''
})

$('media-query').addEventListener('input', scheduleMediaSearch)

$('media-type').addEventListener('click', event => {
  const tab = event.target.closest('.tab')
  if (!tab) return
  mediaType = tab.dataset.type
  document.querySelectorAll('#media-type .tab').forEach(t => t.classList.toggle('active', t === tab))
  activeNetwork = null
  renderNetworkChips()
  if ($('media-query').value.trim()) runMediaSearch()
})

$('network-row').addEventListener('click', event => {
  const chip = event.target.closest('.network-chip')
  if (!chip) return
  loadNetwork(chip.dataset.network ? Number(chip.dataset.network) : null)
})

$('media-grid').addEventListener('click', event => {
  const card = event.target.closest('.media-card')
  if (!card) return
  location.hash = `#/title/${card.dataset.type}/${card.dataset.id}`
})

/* ---------- title page ---------- */

let pageData = null
const pageSeasonCache = new Map() // `${id}:${season}` -> data

function renderNaming (data) {
  const container = $('title-naming')
  if (data.type === 'movie') {
    const name = movieName(data)
    container.innerHTML = `
      <h3>Copy for Jellyfin</h3>
      <div class="copy-row">
        <code class="copy-name">${escapeHtml(name)}</code>
        <button class="btn primary" data-copy="${escapeHtml(name)}">Copy</button>
      </div>`
    return
  }

  container.innerHTML = `
    <h3>Copy for Jellyfin</h3>
    <div class="season-row">
      <label class="field season-select">
        <span class="field-label">Season</span>
        <select id="page-season"></select>
      </label>
      <button class="btn small" id="btn-find-season">Find season torrents</button>
    </div>
    <div id="page-episodes">Loading episodes…</div>`

  loadPageSeason(data, 1)
}

async function loadPageSeason (data, season) {
  const key = `${data.id}:${season}`
  let seasonData = pageSeasonCache.get(key)
  if (!seasonData) {
    try {
      seasonData = await api(`/api/browse/tv/${data.id}/season/${season}`)
      pageSeasonCache.set(key, seasonData)
    } catch (err) {
      $('page-episodes').textContent = err.message
      return
    }
  }
  if (pageData !== data) return // navigated elsewhere while this was in flight

  const select = $('page-season')
  if (!select.dataset.filled) {
    select.innerHTML = Array.from({ length: seasonData.seasonCount }, (_, i) => i + 1)
      .map(n => `<option value="${n}"${n === season ? ' selected' : ''}>Season ${n}</option>`)
      .join('')
    select.dataset.filled = '1'
    select.addEventListener('change', () => loadPageSeason(data, Number(select.value)))
  } else {
    select.value = season
  }

  $('page-episodes').innerHTML = seasonData.episodes.length
    ? seasonData.episodes.map(ep => {
        const name = episodeName(seasonData.title, season, ep.episodeNumber)
        return `
          <div class="episode-row">
            <span class="episode-label"><b>E${pad2(ep.episodeNumber)}</b> ${escapeHtml(ep.name || 'Untitled')}</span>
            <code class="copy-name">${escapeHtml(name)}</code>
            <button class="icon-btn" data-copy="${escapeHtml(name)}" title="Copy">⧉</button>
            <button class="icon-btn" data-find-episode="${season}:${ep.episodeNumber}" title="Find torrents">🔎</button>
          </div>`
      }).join('')
    : '<div class="dir-empty">No episodes listed for this season</div>'
}

$('title-naming').addEventListener('click', event => {
  if (!pageData || pageData.type !== 'tv') return

  if (event.target.closest('#btn-find-season')) {
    const season = Number($('page-season').value || 1)
    findTorrents(seasonName(pageData.title, season).replace(/\./g, ' '), 'tv', `Season ${season}`)
    return
  }

  const epBtn = event.target.closest('[data-find-episode]')
  if (epBtn) {
    const [season, episode] = epBtn.dataset.findEpisode.split(':').map(Number)
    findTorrents(episodeName(pageData.title, season, episode).replace(/\./g, ' '), 'tv', `S${pad2(season)}E${pad2(episode)}`)
  }
})

function renderCast (cast) {
  const section = $('title-cast-section')
  if (!cast.length) { section.hidden = true; return }
  section.hidden = false
  $('title-cast').innerHTML = cast.map(c => `
    <div class="cast-card">
      ${c.photo ? `<img src="${c.photo}" alt="" loading="lazy">` : '<div class="cast-photo-placeholder">🎭</div>'}
      <div class="cast-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>
      <div class="cast-character" title="${escapeHtml(c.character)}">${escapeHtml(c.character)}</div>
    </div>`).join('')
}

function renderWatch (watch) {
  const section = $('title-watch-section')
  const hasAny = watch && (watch.flatrate.length || watch.rent.length || watch.buy.length)
  if (!hasAny) { section.hidden = true; return }
  section.hidden = false

  const group = (label, list) => !list.length ? '' : `
    <div class="watch-group">
      <span class="watch-label">${label}</span>
      <div class="watch-providers">
        ${list.map(p => `
          <a class="watch-provider" href="${watch.link}" target="_blank" rel="noopener" title="${escapeHtml(p.name)}">
            ${p.logo ? `<img src="${p.logo}" alt="${escapeHtml(p.name)}">` : escapeHtml(p.name)}
          </a>`).join('')}
      </div>
    </div>`

  $('title-watch').innerHTML = group('Stream', watch.flatrate) + group('Rent', watch.rent) + group('Buy', watch.buy)
}

/* ---------- torrents (moviesapi) ---------- */

function torrentRowHtml (t) {
  const meta = [t.seeders != null ? `▲${t.seeders}` : null, t.leechers != null ? `▼${t.leechers}` : null, t.size ? bytes(t.size) : null]
    .filter(Boolean).join(' · ')
  return `
    <div class="torrent-row">
      <span class="torrent-name" title="${escapeHtml(t.filename || '')}">${escapeHtml(t.filename || 'Untitled')}</span>
      <span class="torrent-meta">${meta}</span>
      <button class="btn small" data-magnet="${escapeHtml(t.magnet)}">Add</button>
    </div>`
}

function renderTorrents (results) {
  $('torrents-list').innerHTML = results.length
    ? results.map(torrentRowHtml).join('')
    : '<div class="dir-empty">No torrents found</div>'
}

let torrentSearchToken = 0
let torrentEngines = [] // [{slug, name}, ...] — loaded once, cached for the session

async function loadTorrentEngines () {
  if (torrentEngines.length) return
  try {
    const { engines } = await api('/api/torrents/engines')
    torrentEngines = engines
  } catch {
    torrentEngines = []
  }
  const select = $('torrents-engine')
  const current = select.value
  select.innerHTML = '<option value="">Auto (try each)</option>' +
    torrentEngines.map(e => `<option value="${escapeHtml(e.slug)}">${escapeHtml(e.name)}</option>`).join('')
  select.value = current // keep whatever the user had picked, if it still exists
}

async function findTorrents (query, category, label) {
  const token = ++torrentSearchToken
  const status = $('torrents-status')
  const button = $('btn-find-torrents')
  const engine = $('torrents-engine').value
  button.disabled = true
  status.className = 'torrents-status'
  status.textContent = `Searching for "${label}"…`
  $('torrents-list').innerHTML = ''
  $('title-torrents-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' })

  try {
    const query_ = `/api/torrents/search?q=${encodeURIComponent(query)}&type=${category === 'tv' ? 'tv' : 'movie'}${engine ? `&engine=${encodeURIComponent(engine)}` : ''}`
    const { engine: usedEngine, results } = await api(query_)
    if (token !== torrentSearchToken) return // superseded by a later search
    const engineName = torrentEngines.find(e => e.slug === usedEngine)?.name || usedEngine
    status.textContent = results.length
      ? `${results.length} found for "${label}" (${engineName})`
      : `No torrents found for "${label}"${engine ? '' : ` (tried ${engineName})`}`
    renderTorrents(results)
  } catch (err) {
    if (token !== torrentSearchToken) return
    status.className = 'torrents-status error'
    status.textContent = err.message
  } finally {
    if (token === torrentSearchToken) button.disabled = false
  }
}

$('btn-find-torrents').addEventListener('click', () => {
  if (!pageData) return
  const query = pageData.type === 'movie' ? movieName(pageData).replace(/\./g, ' ') : pageData.title
  findTorrents(query, pageData.type === 'tv' ? 'tv' : 'movies', pageData.title)
})

$('torrents-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-magnet]')
  if (!button) return
  button.disabled = true
  try {
    const result = await api('/api/torrents', {
      method: 'POST',
      body: JSON.stringify({ magnet: button.dataset.magnet })
    })
    if (result.added) {
      button.textContent = 'Added'
      toast('Added to the queue', 'ok')
    } else {
      button.disabled = false
      toast(result.skipped?.[0]?.reason || result.failed?.[0]?.reason || 'Could not add', 'error')
    }
  } catch (err) {
    button.disabled = false
    toast(err.message, 'error')
  }
})

function renderTitlePage (data) {
  $('title-name').textContent = data.title
  $('title-backdrop').style.backgroundImage = data.backdrop ? `url("${data.backdrop}")` : 'none'
  if (data.poster) { $('title-poster').src = data.poster } else { $('title-poster').removeAttribute('src') }

  const bits = []
  if (data.year) bits.push(data.year)
  if (data.type === 'movie' && data.runtime) bits.push(`${data.runtime} min`)
  if (data.type === 'tv' && data.seasonCount) bits.push(`${data.seasonCount} season${data.seasonCount === 1 ? '' : 's'}`)
  if (data.rating?.average) bits.push(`★ ${data.rating.average.toFixed(1)} (${data.rating.count.toLocaleString()})`)
  if (data.genres.length) bits.push(data.genres.join(', '))
  $('title-meta').textContent = bits.join(' · ')

  field($('title-tagline'), data.tagline)
  $('title-overview').textContent = data.overview

  const trailerBtn = $('title-trailer')
  if (data.trailer) {
    trailerBtn.href = data.trailer.url
    trailerBtn.hidden = false
  } else {
    trailerBtn.hidden = true
    trailerBtn.removeAttribute('href')
  }

  renderNaming(data)
  renderCast(data.cast)
  renderWatch(data.watch)
}

async function showTitlePage (type, id) {
  $('app-main').hidden = true
  $('title-page').hidden = false
  window.scrollTo(0, 0)

  $('title-name').textContent = 'Loading…'
  $('title-meta').textContent = ''
  $('title-overview').textContent = ''
  $('title-backdrop').style.backgroundImage = 'none'
  $('title-poster').removeAttribute('src')
  field($('title-tagline'), null)
  $('title-trailer').hidden = true
  $('title-trailer').removeAttribute('href')
  $('title-naming').innerHTML = ''
  $('title-cast-section').hidden = true
  $('title-watch-section').hidden = true
  $('torrents-list').innerHTML = ''
  $('torrents-status').className = 'torrents-status'
  $('torrents-status').textContent = ''
  $('btn-find-torrents').disabled = false
  loadTorrentEngines()

  try {
    const data = await api(`/api/browse/title/${type}/${id}`)
    pageData = data
    renderTitlePage(data)
  } catch (err) {
    $('title-name').textContent = 'Could not load'
    $('title-overview').textContent = err.message
  }
}

function parseRoute () {
  if (location.hash === '#/browse') return { page: 'browse' }
  if (location.hash === '#/files') return { page: 'files' }
  const m = /^#\/title\/(movie|tv)\/(\d+)$/.exec(location.hash)
  if (m) return { page: 'title', type: m[1], id: Number(m[2]) }
  return { page: 'home' }
}

let lastPage = 'home' // where "← Back" on the title page should return to

function applyRoute () {
  const route = parseRoute()
  $('app-main').hidden = route.page !== 'home'
  $('media-page').hidden = route.page !== 'browse'
  $('files-page').hidden = route.page !== 'files'
  $('title-page').hidden = route.page !== 'title'

  const activeNav = route.page === 'title' ? lastPage : route.page
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.classList.toggle('active', el.dataset.nav === activeNav)
  })

  if (route.page === 'browse') {
    window.scrollTo(0, 0)
    loadNetworkChips()
    if (!mediaResults.length) loadTrending()
  } else if (route.page === 'files') {
    window.scrollTo(0, 0)
    loadFileLibraries()
  } else if (route.page === 'title') {
    showTitlePage(route.type, route.id)
  }

  if (route.page !== 'title') lastPage = route.page
}

window.addEventListener('hashchange', applyRoute)

$('title-back').addEventListener('click', event => {
  event.preventDefault()
  location.hash = lastPage === 'browse' ? '#/browse' : ''
})

$('title-page').addEventListener('click', event => {
  const btn = event.target.closest('[data-copy]')
  if (btn) copyText(btn.dataset.copy)
})

/* ---------- go ---------- */

api('/api/state').then(s => { state = s; render() }).catch(() => {})
connect()
applyRoute()
