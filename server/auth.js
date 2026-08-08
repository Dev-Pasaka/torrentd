import crypto from 'node:crypto'
import { getSetting, verifyPassword } from './db.js'

const REALM = 'torrentd'

function safeEqual (a, b) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/** Checks an `Authorization: Basic ...` header against the stored credentials. */
export function checkBasicAuth (header) {
  if (!header || !header.startsWith('Basic ')) return false
  let decoded
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  } catch {
    return false
  }
  const sep = decoded.indexOf(':')
  if (sep === -1) return false

  const user = decoded.slice(0, sep)
  const pass = decoded.slice(sep + 1)
  const expectedUser = getSetting('auth_user', '')
  const storedHash = getSetting('auth_hash', '')

  // Both checks always run so a wrong username costs the same as a wrong password.
  const userOk = safeEqual(user, expectedUser)
  const passOk = verifyPassword(pass, storedHash)
  return userOk && passOk
}

export function basicAuth (req, res, next) {
  if (checkBasicAuth(req.headers.authorization)) return next()
  res.set('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`)
  res.status(401).type('text/plain').send('Authentication required')
}

/* ---------- short-lived tokens for the websocket handshake ---------- */

// Browsers cannot set an Authorization header on a WebSocket, so the page asks
// an authenticated endpoint for a one-shot token and passes it in the URL.
const tokens = new Map() // token -> expiry
const TOKEN_TTL = 60_000

export function issueToken () {
  const token = crypto.randomBytes(24).toString('base64url')
  tokens.set(token, Date.now() + TOKEN_TTL)
  return token
}

export function consumeToken (token) {
  if (!token) return false
  const expiry = tokens.get(token)
  if (expiry === undefined) return false
  tokens.delete(token)
  return expiry > Date.now()
}

setInterval(() => {
  const now = Date.now()
  for (const [token, expiry] of tokens) {
    if (expiry <= now) tokens.delete(token)
  }
}, TOKEN_TTL).unref()
