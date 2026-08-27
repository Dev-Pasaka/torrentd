"""Scrapes rargb.to's search/category pages for magnet links.

RARBG's own API (torrentapi.org) has been dead since RARBG shut down in 2023.
rargb.to is a live mirror that still serves the classic search UI, but its
listing pages don't carry magnet links — those only appear on each torrent's
own detail page — so one search is one listing fetch plus one detail fetch
per result, done concurrently to keep latency reasonable.

This is HTML scraping, not a documented API: rargb.to can change its markup
or block scraping at any time without notice, which would break parsing here.
"""

import re
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE = "https://rargb.to"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}
TIMEOUT = 15
MAGNET_WORKERS = 5

CATEGORIES = ["movies", "tv", "games", "music", "anime", "apps", "documentaries", "other", "xxx"]
SORTS = ["seeders", "leechers", "size", "data"]

_SIZE_UNITS = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}


class ScrapeError(Exception):
    """rargb.to was unreachable, or its markup no longer matches what we parse."""


def _fetch(url: str, params: Optional[dict] = None) -> BeautifulSoup:
    try:
        resp = requests.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise ScrapeError(f"rargb.to request failed: {exc}") from exc
    return BeautifulSoup(resp.text, "lxml")


def _parse_size(text: str) -> Optional[int]:
    m = re.match(r"([\d.]+)\s*([A-Za-z]+)", text.strip())
    if not m:
        return None
    value, unit = m.groups()
    factor = _SIZE_UNITS.get(unit.upper())
    return int(float(value) * factor) if factor else None


def _parse_int(text: str) -> Optional[int]:
    text = text.strip()
    return int(text) if text.isdigit() else None


def _parse_rows(soup: BeautifulSoup) -> List[dict]:
    rows = soup.select("table.lista2t tr.lista2")
    results = []
    for row in rows:
        cells = row.find_all("td", recursive=False)
        if len(cells) < 8:
            continue
        link = cells[1].find("a", href=True)
        if not link:
            continue
        results.append({
            "filename": link.get("title") or link.get_text(strip=True),
            "detail_url": urljoin(BASE, link["href"]),
            "category": cells[2].get_text(" ", strip=True),
            "pubdate": cells[3].get_text(strip=True),
            "size": _parse_size(cells[4].get_text(strip=True)),
            "seeders": _parse_int(cells[5].get_text(strip=True)),
            "leechers": _parse_int(cells[6].get_text(strip=True)),
            "uploader": cells[7].get_text(strip=True),
        })
    return results


def _magnet(detail_url: str) -> Optional[str]:
    try:
        soup = _fetch(detail_url)
    except ScrapeError:
        return None
    link = soup.select_one('a[href^="magnet:"]')
    return link["href"] if link else None


def search(query: str = "", category: str = "movies", sort: str = "seeders", limit: int = 15) -> List[dict]:
    """Search rargb.to, or (with an empty query) list a category's latest torrents.

    Fetches the listing page, then resolves the magnet link for each of the
    top `limit` results by visiting its detail page (bounded concurrency).
    Rows whose detail page has no magnet link (removed/dead torrents) are
    dropped from the result.
    """
    if limit < 1 or limit > 50:
        raise ValueError("limit must be between 1 and 50")
    if sort not in SORTS:
        raise ValueError(f"sort must be one of {SORTS}")
    if category and category not in CATEGORIES:
        raise ValueError(f"category must be one of {CATEGORIES}")

    params = {"order": sort, "by": "DESC"}
    if query:
        params["search"] = query
        if category:
            params["category[]"] = category
        url = f"{BASE}/search/"
    else:
        url = f"{BASE}/{category or 'movies'}/"

    rows = _parse_rows(_fetch(url, params))[:limit]
    if not rows:
        return []

    with ThreadPoolExecutor(max_workers=MAGNET_WORKERS) as pool:
        magnets = list(pool.map(lambda r: _magnet(r["detail_url"]), rows))

    for row, magnet in zip(rows, magnets):
        row["download"] = magnet

    return [r for r in rows if r["download"]]
