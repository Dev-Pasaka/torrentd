import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import { q, getSettings, getSetting } from './db.js'

// Public trackers appended to every torrent. Bare magnets (xt only, no `tr`)
// often have no announce list at all and would otherwise rely on DHT alone.
// WebTorrent concatenates these onto whatever the magnet already carries, so
// nothing is lost for torrents that name their own trackers.
//
// The http:// entries are not redundant. UDP trackers and DHT both need
// outbound UDP, which plenty of VPNs and corporate networks drop entirely — on
// such a connection a udp-only list finds zero peers. HTTP trackers announce
// over TCP and keep working there.
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'http://nyaa.tracker.wf:7777/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'https://tracker.tamersunion.org:443/announce',
  'http://open.acgnxtracker.com:80/announce'
]

const STATS_INTERVAL = 1000
// Progress is written to sqlite every Nth tick; the live numbers go over the
// websocket, so the DB only needs to be good enough to survive a restart.
const PERSIST_EVERY = 5

export class DownloadManager extends EventEmitter {
  constructor () {
    super()
    // NAT port mapping is opt-in: nat-api never attaches an 'error' listener to
    // its NAT-PMP socket, so a bind conflict (port 5350 is commonly taken on
    // macOS) becomes an unhandled 'error' event that kills the process. DHT and
    // outgoing peer connections work without it.
    this.client = new WebTorrent({
      torrentPort: Number(process.env.TORRENT_PORT) || 0,
      dhtPort: Number(process.env.DHT_PORT) || 0,
      // WebTorrent's default of 55 is a client-wide cap, not per torrent, and
      // it is the main thing holding back throughput on well-seeded content.
      maxConns: Number(process.env.MAX_CONNS) || 150,
      natUpnp: process.env.NAT_UPNP === '1',
      natPmp: process.env.NAT_PMP === '1'
    })
    this.client.on('error', err => {
      console.error('[webtorrent]', err.message)
    })
    // Best-effort guard for anyone who opts back in.
    this.client.natTraversal?.on?.('error', err => {
      console.error('[nat]', err.message)
    })

    /** @type {Map<number, import('webtorrent').Torrent>} id -> torrent */
    this.active = new Map()
    /** @type {Map<number, object>} id -> live stats */
    this.stats = new Map()
    this._ticks = 0

    q.resetRunning.run()
    this._timer = setInterval(() => this._tick(), STATS_INTERVAL)
    this.pump()
  }

  /* ---------- queue ---------- */

  /**
   * Starts queued torrents until the concurrency limit is reached. The limit
   * counts in-flight downloads only — seeding torrents stay attached to the
   * client after finishing, so `this.active.size` would wrongly hold the queue.
   */
  pump () {
    const limit = Math.max(1, getSettings().maxConcurrent)
    while (q.countByStatus.get('downloading').n < limit) {
      const next = q.nextQueued.get()
      if (!next) break
      this._start(next)
    }
  }

  async add (input) {
    const raw = String(input).trim()
    if (!raw) throw new Error('Empty link')

    let parsed
    try {
      parsed = await parseTorrent(raw)
    } catch {
      throw new Error('Not a valid magnet link or torrent URL')
    }
    if (!parsed?.infoHash) throw new Error('Could not read an info hash from that link')

    const existing = q.byInfoHash.get(parsed.infoHash)
    if (existing) {
      const err = new Error(`Already in the list: ${existing.name || parsed.infoHash}`)
      err.duplicate = true
      err.existing = existing
      throw err
    }

    const savePath = getSetting('download_path')
    fs.mkdirSync(savePath, { recursive: true })

    const info = q.insert.run({
      magnet: raw,
      info_hash: parsed.infoHash,
      name: parsed.name || null,
      save_path: savePath,
      position: q.maxPosition.get().p + 1,
      created_at: Date.now()
    })

    this.pump()
    return q.byId.get(info.lastInsertRowid)
  }

  _start (row) {
    q.markStarted.run(Date.now(), row.id)
    this.stats.set(row.id, { peers: 0, downloadSpeed: 0, uploadSpeed: 0, timeRemaining: null })

    let torrent
    try {
      torrent = this.client.add(row.magnet, {
        path: row.save_path,
        announce: DEFAULT_TRACKERS
      })
    } catch (err) {
      this._fail(row.id, err.message)
      return
    }

    this.active.set(row.id, torrent)

    torrent.on('metadata', () => {
      q.updateMeta.run(torrent.name, torrent.infoHash, torrent.length, row.id)
      this.emit('change')
    })

    torrent.on('done', () => {
      q.markDone.run(Date.now(), row.id)
      if (!getSettings().seedAfterDownload) {
        // destroyStore stays false, so the finished files are left on disk.
        torrent.destroy({ destroyStore: false }, () => {})
        this.active.delete(row.id)
      }
      this.stats.delete(row.id)
      this.emit('change')
      this.pump()
    })

    torrent.on('error', err => {
      this._fail(row.id, err.message || String(err))
    })

    this.emit('change')
  }

  _fail (id, message) {
    q.setError.run(message, id)
    const torrent = this.active.get(id)
    if (torrent) {
      try { torrent.destroy({ destroyStore: false }, () => {}) } catch {}
    }
    this.active.delete(id)
    this.stats.delete(id)
    this.emit('change')
    this.pump()
  }

  /* ---------- per-item actions ---------- */

  pause (id) {
    const row = q.byId.get(id)
    if (!row) throw new Error('No such item')
    if (row.status !== 'downloading' && row.status !== 'queued') {
      throw new Error(`Cannot pause an item that is ${row.status}`)
    }
    this._detach(id)
    q.setStatus.run('paused', id)
    this.emit('change')
    this.pump()
  }

  resume (id) {
    const row = q.byId.get(id)
    if (!row) throw new Error('No such item')
    if (row.status === 'downloading' || row.status === 'done') return
    // Re-adding with the same save path makes WebTorrent verify the pieces
    // already on disk, so a resumed download picks up where it stopped.
    q.setStatus.run('queued', id)
    this.emit('change')
    this.pump()
  }

  remove (id, deleteFiles = false) {
    const row = q.byId.get(id)
    if (!row) throw new Error('No such item')
    const torrent = this.active.get(id)
    if (torrent) {
      try { torrent.destroy({ destroyStore: deleteFiles }, () => {}) } catch {}
    } else if (deleteFiles && row.name) {
      // Finished torrents are no longer held by the client, so they have to be
      // removed by path. The torrent name comes from the swarm, so confirm the
      // resolved target really sits inside the save folder before deleting.
      const base = path.resolve(row.save_path)
      const target = path.resolve(base, row.name)
      if (target.startsWith(base + path.sep) && target !== base) {
        try { fs.rmSync(target, { recursive: true, force: true }) } catch {}
      } else {
        console.error('[manager] refusing to delete outside the save folder:', target)
      }
    }
    this.active.delete(id)
    this.stats.delete(id)
    q.delete.run(id)
    this.emit('change')
    this.pump()
  }

  /** Moves an item up or down the queue by swapping positions with its neighbour. */
  move (id, direction) {
    const rows = q.all.all().filter(r => r.status === 'queued' || r.status === 'paused')
    const index = rows.findIndex(r => r.id === id)
    if (index === -1) throw new Error('Only queued or paused items can be reordered')
    const swapWith = direction === 'up' ? index - 1 : index + 1
    if (swapWith < 0 || swapWith >= rows.length) return

    const a = rows[index]
    const b = rows[swapWith]
    q.setPosition.run(b.position, a.id)
    q.setPosition.run(a.position, b.id)
    // Equal positions would leave the order undefined; nudge them apart.
    if (a.position === b.position) {
      q.setPosition.run(direction === 'up' ? a.position - 1 : a.position + 1, a.id)
    }
    this.emit('change')
  }

  clearCompleted () {
    q.deleteCompleted.run()
    this.emit('change')
  }

  /** Detaches an item from the client without touching its files or DB row. */
  _detach (id) {
    const torrent = this.active.get(id)
    if (torrent) {
      try { torrent.destroy({ destroyStore: false }, () => {}) } catch {}
    }
    this.active.delete(id)
    this.stats.delete(id)
  }

  /* ---------- stats ---------- */

  _tick () {
    this._ticks++
    const persist = this._ticks % PERSIST_EVERY === 0

    for (const [id, torrent] of this.active) {
      this.stats.set(id, {
        peers: torrent.numPeers,
        downloadSpeed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed,
        timeRemaining: Number.isFinite(torrent.timeRemaining) ? torrent.timeRemaining : null,
        ratio: torrent.ratio
      })
      if (persist && !torrent.done) {
        q.updateProgress.run(torrent.progress, torrent.downloaded, id)
      }
    }
    this.emit('tick')
  }

  /** Full state for the UI: DB rows merged with live counters. */
  snapshot () {
    const rows = q.all.all().map(row => {
      const torrent = this.active.get(row.id)
      const live = this.stats.get(row.id) || {}
      return {
        id: row.id,
        magnet: row.magnet,
        infoHash: row.info_hash,
        name: torrent?.name || row.name || null,
        status: row.status,
        savePath: row.save_path,
        totalBytes: torrent?.length ?? row.total_bytes,
        downloadedBytes: torrent?.downloaded ?? row.downloaded_bytes,
        progress: torrent?.progress ?? row.progress,
        error: row.error,
        createdAt: row.created_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        peers: live.peers ?? 0,
        downloadSpeed: live.downloadSpeed ?? 0,
        uploadSpeed: live.uploadSpeed ?? 0,
        timeRemaining: live.timeRemaining ?? null,
        seeding: row.status === 'done' && this.active.has(row.id)
      }
    })

    return {
      torrents: rows,
      totals: {
        downloadSpeed: this.client.downloadSpeed,
        uploadSpeed: this.client.uploadSpeed,
        active: rows.filter(r => r.status === 'downloading').length,
        queued: rows.filter(r => r.status === 'queued').length,
        done: rows.filter(r => r.status === 'done').length
      },
      settings: getSettings()
    }
  }

  destroy () {
    clearInterval(this._timer)
    return new Promise(resolve => this.client.destroy(() => resolve()))
  }
}
