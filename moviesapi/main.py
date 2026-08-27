"""FastAPI wrapper around a small rargb.to scraper (see scraper.py).

RARBG's own API (torrentapi.org) shut down along with RARBG in 2023, so this
talks to rargb.to's HTML search UI directly and pulls magnet links off each
result's detail page. See scraper.py for how fragile that makes it: any
markup change on rargb.to's end can break parsing here.
"""

from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

import scraper

app = FastAPI(
    title="moviesapi",
    description="FastAPI wrapper that scrapes rargb.to for torrent search",
    version="2.0.0",
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


def run(**kwargs) -> List[Torrent]:
    try:
        rows = scraper.search(**kwargs)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except scraper.ScrapeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return [to_torrent(row) for row in rows]


@app.get("/")
def root():
    return {"service": "moviesapi", "upstream": "rargb.to"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/categories")
def categories():
    return scraper.CATEGORIES


@app.get("/search", response_model=List[Torrent])
def search_torrents(
    q: str = "",
    category: Optional[str] = None,
    sort: str = Query("seeders", pattern="^(seeders|leechers|size|data)$"),
    limit: int = 15,
):
    return run(query=q, category=category, sort=sort, limit=limit)


@app.get("/movies/search", response_model=List[Torrent])
def search_movies(
    q: str,
    sort: str = Query("seeders", pattern="^(seeders|leechers|size|data)$"),
    limit: int = 15,
):
    if not q.strip():
        raise HTTPException(status_code=400, detail="q is required")
    return run(query=q, category="movies", sort=sort, limit=limit)


@app.get("/movies/latest", response_model=List[Torrent])
def latest_movies(
    sort: str = Query("seeders", pattern="^(seeders|leechers|size|data)$"),
    limit: int = 15,
):
    return run(query="", category="movies", sort=sort, limit=limit)


if __name__ == "__main__":
    import os
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
