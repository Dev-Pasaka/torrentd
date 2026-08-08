import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const DATA_DIR = process.env.TORRENTD_DATA || path.join(process.cwd(), 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(path.join(DATA_DIR, 'torrentd.db'))
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS torrents (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    magnet           TEXT NOT NULL,
    info_hash        TEXT,
    name             TEXT,
    status           TEXT NOT NULL DEFAULT 'queued',
    save_path        TEXT NOT NULL,
    total_bytes      INTEGER NOT NULL DEFAULT 0,
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    progress         REAL    NOT NULL DEFAULT 0,
    error            TEXT,
    position         INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    started_at       INTEGER,
    completed_at     INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_torrents_info_hash
    ON torrents(info_hash) WHERE info_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_torrents_status ON torrents(status);
`)

/* ---------- password hashing ---------- */

export function hashPassword (password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const key = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${key}`
}

export function verifyPassword (password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false
  const [salt, key] = stored.split(':')
  let expected
  try {
    expected = Buffer.from(key, 'hex')
  } catch {
    return false
  }
  const actual = crypto.scryptSync(password, salt, expected.length)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

/* ---------- settings ---------- */

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?')
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`)

export function getSetting (key, fallback = null) {
  const row = getSettingStmt.get(key)
  return row ? row.value : fallback
}

export function setSetting (key, value) {
  setSettingStmt.run(key, String(value))
}

export const DEFAULT_DOWNLOAD_PATH = path.join(os.homedir(), 'Downloads', 'torrentd')

/**
 * Seeds settings on first run. Returns the generated password if one was
 * created, so the caller can print it once.
 */
export function initSettings () {
  let generatedPassword = null

  if (getSetting('download_path') === null) {
    setSetting('download_path', process.env.DOWNLOAD_DIR || DEFAULT_DOWNLOAD_PATH)
  }
  if (getSetting('max_concurrent') === null) setSetting('max_concurrent', '1')
  if (getSetting('seed_after_download') === null) setSetting('seed_after_download', '0')

  if (getSetting('auth_user') === null || getSetting('auth_hash') === null) {
    const user = process.env.TORRENTD_USER || 'admin'
    const pass = process.env.TORRENTD_PASS || crypto.randomBytes(9).toString('base64url')
    setSetting('auth_user', user)
    setSetting('auth_hash', hashPassword(pass))
    if (!process.env.TORRENTD_PASS) generatedPassword = pass
  }

  return generatedPassword
}

export function getSettings () {
  return {
    downloadPath: getSetting('download_path', DEFAULT_DOWNLOAD_PATH),
    maxConcurrent: Number(getSetting('max_concurrent', '1')),
    seedAfterDownload: getSetting('seed_after_download', '0') === '1',
    username: getSetting('auth_user', 'admin')
  }
}

/* ---------- torrents ---------- */

export const q = {
  all: db.prepare('SELECT * FROM torrents ORDER BY position ASC, id ASC'),
  byId: db.prepare('SELECT * FROM torrents WHERE id = ?'),
  byInfoHash: db.prepare('SELECT * FROM torrents WHERE info_hash = ?'),

  insert: db.prepare(`
    INSERT INTO torrents (magnet, info_hash, name, status, save_path, position, created_at)
    VALUES (@magnet, @info_hash, @name, 'queued', @save_path, @position, @created_at)
  `),

  nextQueued: db.prepare(`
    SELECT * FROM torrents WHERE status = 'queued'
    ORDER BY position ASC, id ASC LIMIT 1
  `),
  countByStatus: db.prepare("SELECT COUNT(*) AS n FROM torrents WHERE status = ?"),
  maxPosition: db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM torrents'),

  setStatus: db.prepare('UPDATE torrents SET status = ? WHERE id = ?'),
  setError: db.prepare("UPDATE torrents SET status = 'error', error = ? WHERE id = ?"),
  setPosition: db.prepare('UPDATE torrents SET position = ? WHERE id = ?'),

  markStarted: db.prepare(`
    UPDATE torrents SET status = 'downloading', started_at = ?, error = NULL WHERE id = ?
  `),
  markDone: db.prepare(`
    UPDATE torrents
    SET status = 'done', progress = 1, completed_at = ?,
        downloaded_bytes = total_bytes, error = NULL
    WHERE id = ?
  `),
  updateMeta: db.prepare(`
    UPDATE torrents SET name = ?, info_hash = COALESCE(info_hash, ?), total_bytes = ? WHERE id = ?
  `),
  updateProgress: db.prepare(`
    UPDATE torrents SET progress = ?, downloaded_bytes = ? WHERE id = ?
  `),

  delete: db.prepare('DELETE FROM torrents WHERE id = ?'),
  deleteCompleted: db.prepare("DELETE FROM torrents WHERE status = 'done'"),

  // Recover from an unclean shutdown: nothing can still be running.
  resetRunning: db.prepare(`
    UPDATE torrents SET status = 'queued' WHERE status = 'downloading'
  `)
}
