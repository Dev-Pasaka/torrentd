import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'

import { initSettings, getSettings, setSetting, hashPassword, q } from './db.js'
import { basicAuth, issueToken, consumeToken } from './auth.js'
import { DownloadManager } from './manager.js'
import * as tmdb from './tmdb.js'
import * as rarbg from './rarbg.js'
import * as files from './files.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const PORT = Number(process.env.PORT) || 8080
const HOST = process.env.HOST || '127.0.0.1'

const generatedPassword = initSettings()
const manager = new DownloadManager()

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(basicAuth)
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }))

const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)

/* ---------- torrents ---------- */

app.get('/api/state', (req, res) => res.json(manager.snapshot()))

app.get('/api/ws-token', (req, res) => res.json({ token: issueToken() }))

app.post('/api/torrents', wrap(async (req, res) => {
  const input = req.body?.magnets ?? req.body?.magnet ?? ''
  const links = String(input)
    .split(/[\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean)

  if (!links.length) return res.status(400).json({ error: 'No magnet links given' })

  const added = []
  const skipped = []
  const failed = []

  for (const link of links) {
    try {
      added.push(await manager.add(link))
    } catch (err) {
      if (err.duplicate) skipped.push({ link, reason: err.message })
      else failed.push({ link, reason: err.message })
    }
  }

  res.status(failed.length && !added.length ? 400 : 200)
    .json({ added: added.length, skipped, failed })
}))

app.post('/api/torrents/:id/relocate', wrap(async (req, res) => {
  const { destLibrary, destPath } = req.body || {}
  await manager.relocate(Number(req.params.id), { destLibrary, destPath: destPath || '' })
  res.json({ ok: true })
}))

app.post('/api/torrents/:id/:action', wrap((req, res) => {
  const id = Number(req.params.id)
  const { action } = req.params

  switch (action) {
    case 'pause': manager.pause(id); break
    case 'resume': manager.resume(id); break
    case 'retry': manager.resume(id); break
    case 'move': manager.move(id, req.body?.direction === 'up' ? 'up' : 'down'); break
    default: return res.status(404).json({ error: `Unknown action "${action}"` })
  }
  res.json({ ok: true })
}))

app.delete('/api/torrents/:id', wrap((req, res) => {
  manager.remove(Number(req.params.id), req.query.files === '1')
  res.json({ ok: true })
}))

app.post('/api/clear-completed', wrap((req, res) => {
  manager.clearCompleted()
  res.json({ ok: true })
}))

app.get('/api/torrents/search', wrap(async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) return res.status(400).json({ error: 'q is required' })
  const category = req.query.type === 'tv' ? 'tv' : 'movies'
  res.json({ results: await rarbg.search({ query, category }) })
}))

/* ---------- settings ---------- */

app.get('/api/settings', (req, res) => res.json(getSettings()))

app.put('/api/settings', wrap(async (req, res) => {
  const { downloadPath, maxConcurrent, seedAfterDownload, username, password } = req.body ?? {}

  if (downloadPath !== undefined) {
    const resolved = path.resolve(String(downloadPath))
    try {
      await fsp.mkdir(resolved, { recursive: true })
      await fsp.access(resolved, fs.constants.W_OK)
    } catch (err) {
      return res.status(400).json({ error: `Cannot use that folder: ${err.message}` })
    }
    setSetting('download_path', resolved)
  }

  if (maxConcurrent !== undefined) {
    const n = Number(maxConcurrent)
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return res.status(400).json({ error: 'Concurrent downloads must be between 1 and 10' })
    }
    setSetting('max_concurrent', n)
  }

  if (seedAfterDownload !== undefined) {
    setSetting('seed_after_download', seedAfterDownload ? '1' : '0')
  }

  if (username !== undefined && String(username).trim()) {
    setSetting('auth_user', String(username).trim())
  }

  if (password) {
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }
    setSetting('auth_hash', hashPassword(String(password)))
  }

  manager.pump()
  manager.emit('change')
  res.json({ ...getSettings(), credentialsChanged: Boolean(password || username) })
}))

/* ---------- movie/show lookup (metadata only, for Jellyfin-style naming) ---------- */

app.get('/api/browse/trending', wrap(async (req, res) => {
  res.json({ results: await tmdb.trending() })
}))

app.get('/api/browse/search', wrap(async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) return res.json({ results: [] })
  const type = ['movie', 'tv'].includes(req.query.type) ? req.query.type : 'multi'
  res.json({ results: await tmdb.search(query, type) })
}))

app.get('/api/browse/tv/:id/season/:season', wrap(async (req, res) => {
  res.json(await tmdb.tvSeason(Number(req.params.id), Number(req.params.season)))
}))

app.get('/api/browse/networks', (req, res) => res.json({ networks: tmdb.NETWORKS }))

app.get('/api/browse/network/:id', wrap(async (req, res) => {
  const id = Number(req.params.id)
  const network = tmdb.NETWORKS.find(n => n.id === id)
  if (!network) return res.status(400).json({ error: 'Unknown network id' })
  res.json({ network, results: await tmdb.byNetwork(id) })
}))

app.get('/api/browse/title/:type/:id', wrap(async (req, res) => {
  const { type, id } = req.params
  if (type !== 'movie' && type !== 'tv') return res.status(400).json({ error: 'type must be "movie" or "tv"' })
  const region = req.query.region ? String(req.query.region).toUpperCase() : undefined
  res.json(await tmdb.titleDetails(type, Number(id), region))
}))

/* ---------- host filesystem browser (for picking a download folder) ---------- */

app.get('/api/fs', wrap(async (req, res) => {
  const target = req.query.path ? path.resolve(String(req.query.path)) : os.homedir()

  let entries
  try {
    entries = await fsp.readdir(target, { withFileTypes: true })
  } catch (err) {
    return res.status(400).json({ error: `Cannot open ${target}: ${err.code || err.message}` })
  }

  // Directories only — this picker chooses a destination, it does not browse files.
  const dirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  let writable = true
  try {
    await fsp.access(target, fs.constants.W_OK)
  } catch {
    writable = false
  }

  res.json({
    path: target,
    parent: path.dirname(target) === target ? null : path.dirname(target),
    home: os.homedir(),
    writable,
    dirs
  })
}))

app.post('/api/fs/mkdir', wrap(async (req, res) => {
  const parent = path.resolve(String(req.body?.parent || os.homedir()))
  const name = String(req.body?.name || '').trim()
  if (!name || name.includes(path.sep) || name === '.' || name === '..') {
    return res.status(400).json({ error: 'Invalid folder name' })
  }
  const target = path.join(parent, name)
  try {
    await fsp.mkdir(target, { recursive: true })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
  res.json({ path: target })
}))

/* ---------- media library file manager (scoped to LIBRARY_DIRS, unlike /api/fs above) ---------- */

app.get('/api/files/libraries', (req, res) => res.json({ libraries: files.listLibraries() }))

app.get('/api/files/list', wrap((req, res) => {
  const library = String(req.query.library || '')
  const dirPath = String(req.query.path || '')
  res.json({ entries: files.list(library, dirPath) })
}))

app.post('/api/files/mkdir', wrap(async (req, res) => {
  const { library, path: dirPath, name } = req.body || {}
  await files.mkdir(library, dirPath, name)
  res.json({ ok: true })
}))

app.delete('/api/files/item', wrap(async (req, res) => {
  const library = String(req.query.library || '')
  const dirPath = String(req.query.path || '')
  await files.remove(library, dirPath)
  res.json({ ok: true })
}))

app.post('/api/files/copy', wrap(async (req, res) => {
  const { srcLibrary, srcPath, destLibrary, destPath } = req.body || {}
  res.json({ ok: true, ...await files.copy({ library: srcLibrary, path: srcPath }, { library: destLibrary, path: destPath }) })
}))

app.post('/api/files/move', wrap(async (req, res) => {
  const { srcLibrary, srcPath, destLibrary, destPath } = req.body || {}
  res.json({ ok: true, ...await files.move({ library: srcLibrary, path: srcPath }, { library: destLibrary, path: destPath }) })
}))

/* ---------- errors ---------- */

app.use((err, req, res, next) => {
  console.error('[api]', err.message)
  res.status(err.status || 400).json({ error: err.message })
})

/* ---------- websocket ---------- */

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname !== '/ws' || !consumeToken(url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})

function broadcast () {
  if (!wss.clients.size) return
  const payload = JSON.stringify({ type: 'state', ...manager.snapshot() })
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload)
  }
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'state', ...manager.snapshot() }))
})

manager.on('tick', broadcast)
manager.on('change', broadcast)

/* ---------- start ---------- */

server.listen(PORT, HOST, () => {
  const { downloadPath, username } = getSettings()
  console.log(`\n  torrentd  →  http://${HOST}:${PORT}`)
  console.log(`  downloads →  ${downloadPath}`)
  if (generatedPassword) {
    console.log('\n  ┌─ first run: generated login ───────────────')
    console.log(`  │  username: ${username}`)
    console.log(`  │  password: ${generatedPassword}`)
    console.log('  └─ change it under Settings in the UI ───────')
  } else {
    console.log(`  login     →  ${username}`)
  }
  console.log('')
})

async function shutdown () {
  console.log('\nshutting down…')
  q.resetRunning.run()
  await manager.destroy()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
