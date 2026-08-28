"""Scrapes bitsearch.eu's search results for magnet links.

Unlike rargb.to, bitsearch embeds the magnet link directly in each search
result card, so a search here is a single HTTP fetch — no per-result detail
page hop needed.

bitsearch.eu has no search-less "browse latest" mode (an empty query returns
zero results), unlike rargb's category listing pages — search() raises
ValueError for an empty query rather than silently returning nothing, so a
caller asking for it explicitly gets a clear 400 instead of a confusing empty
list, while the registry's auto-fallback (engines/__init__.py) treats that
ValueError the same as any other engine that can't serve this particular
request and moves on to the next one.

This is HTML scraping, not a documented API: bitsearch.eu can change its
markup or block requests at any time without notice, which would break
parsing here. See the note at the top of rargb.py before adding another
engine — some popular torrent indexes sit behind bot-detection that's out of
scope to defeat; this one doesn't (confirmed a plain HTTP GET works, and
robots.txt's default Content-Signal for a generic user-agent is
search=yes/use=reference, which this — an on-demand fetch triggered by one
user's search, not a bulk crawl — falls under).
"""

import re
from typing import List, Optional

import requests
from bs4 import BeautifulSoup

from .errors import ScrapeError

SLUG = "bitsearch"
NAME = "BitSearch"

BASE = "https://bitsearch.eu"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}
TIMEOUT = 15

# slug -> bitsearch's own numeric category id. bitsearch has no equivalent of
# rargb's "documentaries" category, so it's just absent here — see the note
# in engines/__init__.py on categories being per-engine.
CATEGORIES = ["movies", "tv", "anime", "games", "music", "apps", "other", "xxx"]
_CATEGORY_IDS = {
    "other": "1", "movies": "2", "tv": "3", "anime": "4",
    "apps": "5", "games": "6", "music": "7", "xxx": "10",
}

SORTS = ["seeders", "leechers", "size", "data"]
_SORT_KEYS = {"seeders": "seeders", "leechers": "leechers", "size": "size", "data": "created"}

_SIZE_UNITS = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}


def _parse_size(text: str) -> Optional[int]:
    m = re.match(r"([\d.]+)\s*([A-Za-z]+)", text.strip())
    if not m:
        return None
    value, unit = m.groups()
    factor = _SIZE_UNITS.get(unit.upper())
    return int(float(value) * factor) if factor else None


def _parse_stat(text: str) -> Optional[int]:
    """Pulls the leading number out of e.g. '2355seeders' (label glued to the count)."""
    m = re.match(r"(\d+)", text.strip())
    return int(m.group(1)) if m else None


def _parse_cards(soup: BeautifulSoup) -> List[dict]:
    results = []
    for title_link in soup.select('h3 a[href^="/torrent/"]'):
        card = title_link.find_parent("div", class_="rounded-lg")
        if not card:
            continue
        magnet = card.select_one('a[href^="magnet:"]')
        if not magnet:
            continue

        info = card.select_one("div.flex.flex-wrap.items-center.gap-4.mb-3")
        info_spans = info.find_all("span", recursive=False) if info else []
        category = info_spans[0].get_text(strip=True) if len(info_spans) > 0 else None
        size_text = info_spans[1].get_text(strip=True) if len(info_spans) > 1 else ""
        pubdate = info_spans[2].get_text(strip=True) if len(info_spans) > 2 else None

        stats = card.select_one("div.flex.flex-wrap.items-center.gap-4:not(.mb-3)")
        stat_spans = stats.find_all("span", recursive=False) if stats else []
        seeders = _parse_stat(stat_spans[0].get_text()) if len(stat_spans) > 0 else None
        leechers = _parse_stat(stat_spans[1].get_text()) if len(stat_spans) > 1 else None

        results.append({
            "filename": title_link.get_text(strip=True),
            "detail_url": BASE + title_link["href"],
            "category": category,
            "pubdate": pubdate,
            "size": _parse_size(size_text),
            "seeders": seeders,
            "leechers": leechers,
            "uploader": None,
            "download": magnet["href"],
        })
    return results


def search(query: str = "", category: str = "movies", sort: str = "seeders", limit: int = 15) -> List[dict]:
    """Searches bitsearch.eu. A query is required — see the module docstring
    for why an empty one raises rather than returning nothing.
    """
    if not query:
        raise ValueError("bitsearch requires a search query (no browse-latest mode)")
    if limit < 1 or limit > 50:
        raise ValueError("limit must be between 1 and 50")
    if sort not in SORTS:
        raise ValueError(f"sort must be one of {SORTS}")
    if category and category not in CATEGORIES:
        raise ValueError(f"category must be one of {CATEGORIES}")

    params = {"q": query, "sortBy": _SORT_KEYS[sort], "order": "desc"}
    if category:
        params["category"] = _CATEGORY_IDS[category]

    try:
        resp = requests.get(f"{BASE}/search", params=params, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise ScrapeError(f"bitsearch.eu request failed: {exc}") from exc

    return _parse_cards(BeautifulSoup(resp.text, "lxml"))[:limit]
