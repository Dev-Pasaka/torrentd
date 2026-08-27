// Thin proxy to the moviesapi service (see ../moviesapi, which scrapes
// rargb.to). Kept server-to-server, same pattern as tmdb.js, so the browser
// never talks to moviesapi directly and MOVIESAPI_URL can point at a
// container on the internal Docker network.

const BASE = process.env.MOVIESAPI_URL || 'http://localhost:8000'

async function fetchResults (query, category) {
  const url = new URL('/search', BASE)
  url.searchParams.set('q', query)
  if (category) url.searchParams.set('category', category)
  url.searchParams.set('sort', 'seeders')
  url.searchParams.set('limit', '25')

  let res
  try {
    res = await fetch(url)
  } catch (err) {
    const wrapped = new Error(`moviesapi is unreachable: ${err.message}`)
    wrapped.status = 502
    throw wrapped
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const err = new Error(body?.detail || `moviesapi request failed (${res.status})`)
    err.status = res.status === 400 ? 400 : 502
    throw err
  }

  const torrents = await res.json()
  return torrents.map(t => ({
    filename: t.filename,
    magnet: t.download,
    size: t.size,
    seeders: t.seeders,
    leechers: t.leechers,
    pubdate: t.pubdate
  }))
}

export async function search ({ query, category = 'movies' }) {
  if (!query) {
    const err = new Error('query is required')
    err.status = 400
    throw err
  }

  const results = await fetchResults(query, category)
  if (results.length) return results

  // Some titles (animated films especially) are filed under rargb's own
  // "anime" category rather than "movies"/"tv", so a categorized search can
  // come back empty for a torrent that does exist. Retry once across every
  // category before reporting no results.
  return fetchResults(query, null)
}
