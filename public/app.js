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

$('btn-settings').addEventListener('click', async () => {
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

/* ---------- go ---------- */

api('/api/state').then(s => { state = s; render() }).catch(() => {})
connect()
