# moviesapi

A small FastAPI service that searches torrent index sites ("engines", see `engines/`) and
resolves magnet links for the results. **This is scraping, not an API contract for either
engine** — either site can change its markup or block requests at any time without notice, which
would break parsing here.

## Engines

`engines/` is a small registry so a caller can either let it try each configured engine in order
(the default — stops at the first one with a match) or name a specific one via `?engine=<slug>`.
Two today:

- **`rargb`** — [rargb.to](https://rargb.to), a live RARBG-style mirror (RARBG's own API,
  torrentapi.org, has been dead since RARBG shut down in 2023). Listing pages don't carry magnet
  links, so a search fetches the listing page, then visits each result's own detail page (5 at a
  time) to pull one out. Supports an empty query to list a category's latest torrents.
- **`bitsearch`** — [bitsearch.eu](https://bitsearch.eu) (the same backend also served at
  solidtorrents.to). Magnet links are embedded directly in the search results, so no per-result
  detail-page hop is needed. Requires a non-empty query — an empty one raises `ValueError` rather
  than returning nothing, which the fallback loop treats as "skip this engine" without failing an
  auto search that also includes rargb.

See `engines/__init__.py` for the interface a new engine module needs, and the note there on why
not every torrent index qualifies: sites behind an interactive bot-challenge (Cloudflare's
"managed challenge" — `ext.to` and `1337x.to` both are, as of writing) require defeating that
challenge to scrape, which is out of scope regardless of how good a source the site would
otherwise be.

## Run locally

```bash
cd moviesapi
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Interactive docs at `http://localhost:8000/docs`.

## Run with Docker

```bash
cd moviesapi
docker build -t moviesapi .
docker run --rm -p 8000:8000 moviesapi
```

## Endpoints

| Method | Path              | Description                                                          |
| ------ | ----------------- | ---------------------------------------------------------------------|
| GET    | `/`               | Service info                                                         |
| GET    | `/health`         | Health check                                                         |
| GET    | `/engines`        | Configured engines (`slug`, `name`) and the fallback try-order        |
| GET    | `/categories`     | Category slugs the engine registry accepts (`movies`, `tv`, `games`, ...) |
| GET    | `/search`         | `q` (optional — omit to list a category's latest), `category`, `sort`, `limit`, `engine` |
| GET    | `/movies/search`  | `/search` pre-filtered to `category=movies`; `q` is required         |
| GET    | `/movies/latest`  | `/search` pre-filtered to `category=movies` with no query             |

Common query params: `sort` (`seeders`/`leechers`/`size`/`data` — `data` means date added),
`limit` (1–50, default 15, each unit is one extra detail-page fetch), `engine` (a slug from
`/engines` — omit to try each engine in turn and return the first non-empty result).

Every search response is `{"engine": "<slug that answered>", "results": [...]}` — the caller can
tell which engine actually produced the results even in auto mode. Each result: `filename`,
`category`, `download` (magnet link), `size` (bytes), `pubdate` (added date), `seeders`,
`leechers`, `uploader`, `page` (the engine's detail page URL).
