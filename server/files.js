// File manager for host media libraries. Deliberately NOT a general
// filesystem browser like /api/fs (which walks anywhere the server process
// can read, for picking a download folder): this only ever operates inside
// a fixed set of named roots configured via LIBRARY_DIRS, each backed by its
// own explicit Docker volume mount. Every path from a client is resolved
// against one of those roots and verified — via realpath, so a symlink can't
// be used to step outside it either — to still be inside it before any read,
// delete, copy, or move touches the disk.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

function parseLibraries () {
  const raw = process.env.LIBRARY_DIRS || 'Downloads:/downloads'
  const libraries = new Map()

  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':')
    if (sep === -1) {
      console.error(`[files] ignoring malformed LIBRARY_DIRS entry "${entry}" (expected Name:/path)`)
      continue
    }
    const name = entry.slice(0, sep).trim()
    const dir = entry.slice(sep + 1).trim()
    if (!name || !dir) continue

    try {
      const real = fs.realpathSync(dir)
      if (!fs.statSync(real).isDirectory()) throw new Error('not a directory')
      libraries.set(name, real)
    } catch (err) {
      console.error(`[files] skipping library "${name}" (${dir}): ${err.message}`)
    }
  }

  return libraries
}

const libraries = parseLibraries()

export function listLibraries () {
  return [...libraries.keys()]
}

function badRequest (message) {
  const err = new Error(message)
  err.status = 400
  return err
}

function libraryRoot (name) {
  const root = libraries.get(name)
  if (!root) throw badRequest(`Unknown library "${name}"`)
  return root
}

/** Resolves a client-supplied relative path against a library root without touching the disk yet. */
function resolveLexical (root, relPath) {
  const resolved = path.resolve(root, '.' + path.sep + String(relPath || ''))
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw badRequest('Path escapes the library root')
  return resolved
}

/** Confirms a path that must already exist is still inside root once symlinks are resolved. */
function assertWithinRoot (root, resolved) {
  let real
  try {
    real = fs.realpathSync(resolved)
  } catch (err) {
    if (err.code === 'ENOENT') throw badRequest('No such file or folder')
    throw err
  }
  const realRoot = fs.realpathSync(root)
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw badRequest('Path escapes the library root')
  }
  return real
}

function resolveExisting (name, relPath) {
  const root = libraryRoot(name)
  return assertWithinRoot(root, resolveLexical(root, relPath))
}

export function list (name, relPath) {
  const real = resolveExisting(name, relPath)
  const entries = fs.readdirSync(real, { withFileTypes: true })

  return entries
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const full = path.join(real, e.name)
      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        return null // vanished or a broken symlink between readdir and stat
      }
      return {
        name: e.name,
        isDir: e.isDirectory(),
        size: e.isDirectory() ? null : stat.size,
        mtime: stat.mtimeMs
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
}

export async function mkdir (name, relPath, dirName) {
  const parent = resolveExisting(name, relPath)
  if (!dirName || dirName.includes(path.sep) || dirName === '.' || dirName === '..') {
    throw badRequest('Invalid folder name')
  }
  await fsp.mkdir(path.join(parent, dirName))
}

export async function remove (name, relPath) {
  const root = libraryRoot(name)
  const real = resolveExisting(name, relPath)
  if (real === fs.realpathSync(root)) throw badRequest('Cannot delete a library root')
  await fsp.rm(real, { recursive: true })
}

/**
 * Runs an item-at-a-time operation over a multi-select and collects
 * per-item success/failure instead of letting one bad item (a stale
 * selection, a name collision) abort the whole batch.
 */
async function eachItem (items, fn) {
  const ok = []
  const failed = []
  for (const item of items) {
    try {
      ok.push({ item, ...(await fn(item)) })
    } catch (err) {
      failed.push({ item, reason: err.message })
    }
  }
  return { ok, failed }
}

export const removeMany = items => eachItem(items, item => remove(item.library, item.path))
export const moveMany = (items, dest) => eachItem(items, item => move(item, dest))
export const copyMany = (items, dest) => eachItem(items, item => copy(item, dest))

function planTransfer (src, dest) {
  const srcReal = resolveExisting(src.library, src.path)
  const destDirReal = resolveExisting(dest.library, dest.path)
  const basename = path.basename(srcReal)
  const target = path.join(destDirReal, basename)

  if (target === srcReal || target.startsWith(srcReal + path.sep)) {
    throw badRequest('Cannot move or copy a folder into itself')
  }
  if (fs.existsSync(target)) throw Object.assign(new Error(`"${basename}" already exists at the destination`), { status: 409 })

  return { srcReal, target, name: basename, destDirReal }
}

export async function copy (src, dest) {
  const { srcReal, target, name, destDirReal } = planTransfer(src, dest)
  await fsp.cp(srcReal, target, { recursive: true, errorOnExist: true })
  return { name, destDirReal }
}

export async function move (src, dest) {
  const { srcReal, target, name, destDirReal } = planTransfer(src, dest)
  try {
    await fsp.rename(srcReal, target)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err // different filesystem/mount — fall back to copy + delete
    await fsp.cp(srcReal, target, { recursive: true, errorOnExist: true })
    await fsp.rm(srcReal, { recursive: true })
  }
  return { name, destDirReal }
}

/** Maps an absolute path to its {library, path} within a configured root, or null if it's outside all of them. */
export function locate (absolutePath) {
  let real
  try {
    real = fs.realpathSync(absolutePath)
  } catch {
    return null
  }
  for (const [name, root] of libraries) {
    const realRoot = fs.realpathSync(root)
    if (real === realRoot) return { library: name, path: '' }
    if (real.startsWith(realRoot + path.sep)) return { library: name, path: path.relative(realRoot, real) }
  }
  return null
}
