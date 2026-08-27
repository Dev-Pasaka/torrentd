// Thin wrapper around TMDB's read API. Used only for metadata (titles, air
// dates, season/episode listings, posters) — never anything torrent-related.
// Get a free "API Read Access Token" (v4 auth) at
// https://www.themoviedb.org/settings/api and set TMDB_API_KEY — it's a JWT,
// sent as a Bearer token, not the older v3 api_key query param.

const API = 'https://api.themoviedb.org/3'
const IMG = 'https://image.tmdb.org/t/p/w342'
const BACKDROP = 'https://image.tmdb.org/t/p/w1280'

function apiKey () {
  const key = process.env.TMDB_API_KEY
  if (!key) {
    const err = new Error('TMDB_API_KEY is not set — add one to .env to enable search (see README)')
    err.status = 501
    throw err
  }
  return key
}

async function tmdb (path, params = {}) {
  const url = new URL(API + path)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey()}`, accept: 'application/json' }
  })
  if (!res.ok) {
    const err = new Error(`TMDB request failed (${res.status})`)
    err.status = res.status === 401 ? 502 : 400
    throw err
  }
  return res.json()
}

const poster = path => path ? IMG + path : null

function toItem (raw) {
  const isMovie = raw.media_type ? raw.media_type === 'movie' : raw.title !== undefined
  if (raw.media_type && raw.media_type !== 'movie' && raw.media_type !== 'tv') return null
  return {
    id: raw.id,
    type: isMovie ? 'movie' : 'tv',
    title: isMovie ? raw.title : raw.name,
    year: (isMovie ? raw.release_date : raw.first_air_date)?.slice(0, 4) || null,
    overview: raw.overview || '',
    poster: poster(raw.poster_path),
    rating: raw.vote_average || null
  }
}

/** Picks the best YouTube trailer out of TMDB's video list, falling back to a teaser. */
function pickTrailer (videos) {
  const youtube = (videos?.results || []).filter(v => v.site === 'YouTube')
  const preferenceOrder = [
    v => v.type === 'Trailer' && v.official,
    v => v.type === 'Trailer',
    v => v.type === 'Teaser' && v.official,
    v => v.type === 'Teaser'
  ]
  for (const matches of preferenceOrder) {
    const found = youtube.find(matches)
    if (found) return { key: found.key, url: `https://www.youtube.com/watch?v=${found.key}` }
  }
  return null
}

export async function search (query, type = 'multi') {
  const path = type === 'movie' ? '/search/movie' : type === 'tv' ? '/search/tv' : '/search/multi'
  const data = await tmdb(path, { query, include_adult: false })
  return data.results
    .map(r => toItem(type === 'multi' ? r : { ...r, media_type: type }))
    .filter(Boolean)
}

export async function trending (window = 'week') {
  const data = await tmdb(`/trending/all/${window === 'day' ? 'day' : 'week'}`)
  return data.results.map(toItem).filter(Boolean)
}

// TMDB network IDs for a handful of well-known TV platforms. Curated rather
// than a free-text lookup, since /discover/tv's with_networks takes numeric
// TMDB network IDs that aren't obvious from a provider's name.
export const NETWORKS = [
  { id: 213, name: 'Netflix' },
  { id: 1024, name: 'Prime Video' },
  { id: 2552, name: 'Apple TV+' },
  { id: 49, name: 'HBO' },
  { id: 2739, name: 'Disney+' },
  { id: 453, name: 'Hulu' },
  { id: 4330, name: 'Paramount+' }
]

export async function byNetwork (networkId) {
  const data = await tmdb('/discover/tv', { with_networks: networkId, sort_by: 'popularity.desc' })
  return data.results.map(r => toItem({ ...r, media_type: 'tv' })).filter(Boolean)
}

/**
 * Full detail page for one title: overview, rating, cast, and legal
 * watch/rent/buy providers (via TMDB's JustWatch-backed data) for a region.
 * Never touches anything torrent-related.
 */
export async function titleDetails (type, id, region = 'US') {
  if (type !== 'movie' && type !== 'tv') {
    const err = new Error('type must be "movie" or "tv"')
    err.status = 400
    throw err
  }

  const data = await tmdb(`/${type}/${id}`, { append_to_response: 'credits,watch/providers,external_ids,videos' })
  const isMovie = type === 'movie'
  const providers = data['watch/providers']?.results?.[region]
  const mapProviders = list => (list || []).map(p => ({ name: p.provider_name, logo: poster(p.logo_path) }))

  return {
    id: data.id,
    type,
    title: isMovie ? data.title : data.name,
    year: (isMovie ? data.release_date : data.first_air_date)?.slice(0, 4) || null,
    imdbId: data.external_ids?.imdb_id || null,
    trailer: pickTrailer(data.videos),
    tagline: data.tagline || '',
    overview: data.overview || '',
    genres: (data.genres || []).map(g => g.name),
    rating: { average: data.vote_average || null, count: data.vote_count || 0 },
    runtime: isMovie ? data.runtime || null : null,
    seasonCount: isMovie ? null : data.number_of_seasons || null,
    poster: poster(data.poster_path),
    backdrop: data.backdrop_path ? BACKDROP + data.backdrop_path : null,
    cast: (data.credits?.cast || []).slice(0, 12).map(c => ({
      name: c.name,
      character: c.character || '',
      photo: poster(c.profile_path)
    })),
    watch: providers
      ? {
          link: providers.link,
          flatrate: mapProviders(providers.flatrate),
          rent: mapProviders(providers.rent),
          buy: mapProviders(providers.buy)
        }
      : null
  }
}

/** Season number + episode number/title list, for building S01E09-style names. */
export async function tvSeason (id, seasonNumber) {
  const [show, season] = await Promise.all([
    tmdb(`/tv/${id}`),
    tmdb(`/tv/${id}/season/${seasonNumber}`)
  ])
  return {
    id: show.id,
    title: show.name,
    seasonNumber,
    seasonCount: show.number_of_seasons,
    episodes: (season.episodes || []).map(e => ({
      episodeNumber: e.episode_number,
      name: e.name,
      airDate: e.air_date
    }))
  }
}
