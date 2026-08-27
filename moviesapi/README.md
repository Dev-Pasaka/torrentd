# moviesapi

A small FastAPI service that searches [rargb.to](https://rargb.to) (a live RARBG-style mirror)
and resolves magnet links for the results.

RARBG's own API (torrentapi.org) has been dead since RARBG shut down in 2023, so this talks to
rargb.to's HTML search UI directly (`scraper.py`) instead of a documented API. A search fetches
the listing page, then visits each result's own detail page (5 at a time) to pull out its magnet
link, since listing pages don't carry one. **This is scraping, not an API contract** — rargb.to
can change its markup or block requests at any time without notice, which would break parsing
here.

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
| GET    | `/categories`     | Category slugs rargb.to accepts (`movies`, `tv`, `games`, ...)       |
| GET    | `/search`         | `q` (optional — omit to list a category's latest), `category`, `sort`, `limit` |
| GET    | `/movies/search`  | `/search` pre-filtered to `category=movies`; `q` is required         |
| GET    | `/movies/latest`  | `/search` pre-filtered to `category=movies` with no query             |

Common query params: `sort` (`seeders`/`leechers`/`size`/`data` — `data` means date added),
`limit` (1–50, default 15, each unit is one extra detail-page fetch).

Each result: `filename`, `category`, `download` (magnet link), `size` (bytes), `pubdate`
(added date), `seeders`, `leechers`, `uploader`, `page` (rargb.to detail page URL).
