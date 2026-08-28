"""FastAPI wrapper around a small torrent-search engine registry (see engines/).

RARBG's own API (torrentapi.org) shut down along with RARBG in 2023, so this
scrapes live mirrors' HTML search UIs directly instead. See engines/rargb.py
for how fragile that makes it: any markup change on the source site's end can
break parsing here — and see engines/__init__.py before adding a new engine,
some popular torrent indexes sit behind bot-detection that's out of scope to
defeat.

Every search endpoint takes an optional `engine` slug (see GET /engines for
the list). Omit it to try each configured engine in order and return the
first one with a match — a caller wanting a specific source's results (or to
know which source came up empty) should pass `engine` explicitly.
"""

from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

import engines

app = FastAPI(
    title="moviesapi",
    description="FastAPI wrapper that scrapes torrent search engines (see /engines)",
    version="3.0.0",
)


class Torrent(BaseModel):
    filename: Optional[str] = None
    category: Optional[str] = None
    download: Optional[str] = None
    size: Optional[int] = None
    pubdate: Optional[str] = None
    seeders: Optional[int] = None
    leechers: Optional[int] = None
    uploader: Optional[str] = None
    page: Optional[str] = None


class SearchResult(BaseModel):
    engine: str
    results: List[Torrent]


def to_torrent(row: dict) -> Torrent:
    return Torrent(
        filename=row.get("filename"),
        category=row.get("category"),
        download=row.get("download"),
        size=row.get("size"),
        pubdate=row.get("pubdate"),
        seeders=row.get("seeders"),
        leechers=row.get("leechers"),
        uploader=row.get("uploader"),
        page=row.get("detail_url"),
    )


def run(**kwargs) -> SearchResult:
    try:
        outcome = engines.search(**kwargs)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except engines.ScrapeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return SearchResult(engine=outcome["engine"], results=[to_torrent(row) for row in outcome["results"]])


@app.get("/")
def root():
    return {"service": "moviesapi", "engines": [e["slug"] for e in engines.list_engines()]}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/engines")
def list_engines():
    return {"engines": engines.list_engines(), "fallback_order": engines.FALLBACK_ORDER}


@app.get("/categories")
def categories():
    # rargb is the only engine today, so its category list is also the
    # overall one; this becomes an intersection (or a per-engine map) once a
    # second engine with a different category set is added.
    return engines.ENGINES[engines.FALLBACK_ORDER[0]].CATEGORIES


@app.get("/search", response_model=SearchResult)
def search_torrents(
    q: str = "",
    category: Optional[str] = None,
    sort: str = Query("seeders", pattern="^(seeders|leechers|size|data)$"),
    limit: int = 15,
    engine: Optional[str] = None,
):
    return run(query=q, category=category, sort=sort, limit=limit, engine=engine)


@app.get("/movies/search", response_model=SearchResult)
def search_movies(
    q: str,
    sort: str = Query("seeders", pattern="^(seeders|leechers|size|data)$"),
    limit: int = 15,
    engine: Optional[str] = None,
):
    if not q.strip():
        raise HTTPException(status_code=400, detail="q is required")
    return run(query=q, category="movies", sort=sort, limit=limit, engine=engine)


@app.get("/movies/latest", response_model=SearchResult)
def latest_movies(
    sort: str = Query("seeders", pattern="^(seeders|leechers|size|data)$"),
    limit: int = 15,
    engine: Optional[str] = None,
):
    return run(query="", category="movies", sort=sort, limit=limit, engine=engine)


if __name__ == "__main__":
    import os
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
