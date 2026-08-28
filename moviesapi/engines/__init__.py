"""Registry of scrapable torrent search engines.

Adding a new engine: drop a module in this package exposing SLUG, NAME,
CATEGORIES, SORTS, and a `search(query, category, sort, limit) -> list[dict]`
function returning the same result shape as engines/rargb.py (filename,
detail_url, category, pubdate, size, seeders, leechers, uploader, download),
then register it in ENGINES below. `search` should raise ValueError for bad
arguments and engines.errors.ScrapeError for anything network/parsing related
— main.py maps those to 400 and 502 respectively.

Before adding one: confirm the site can actually be fetched with a plain HTTP
client first (see the note at the top of engines/rargb.py) — several popular
torrent indexes (ext.to, 1337x.to) sit behind an interactive bot-challenge
that a simple scraper can't and shouldn't try to get through.
"""

from typing import List, Optional

from . import bitsearch, rargb
from .errors import ScrapeError

ENGINES = {
    rargb.SLUG: rargb,
    bitsearch.SLUG: bitsearch,
}

# Order fallback tries engines in when the caller doesn't pick one. rargb goes
# first since it also supports the empty-query "browse latest" mode that
# /movies/latest uses; bitsearch requires a real search term (see its
# module docstring) so it's only reached for an actual query.
FALLBACK_ORDER = [rargb.SLUG, bitsearch.SLUG]


def list_engines() -> List[dict]:
    return [{"slug": slug, "name": mod.NAME} for slug, mod in ENGINES.items()]


def search(
    query: str = "",
    category: str = "movies",
    sort: str = "seeders",
    limit: int = 15,
    engine: Optional[str] = None,
) -> dict:
    """Runs a search against one named engine, or tries each in FALLBACK_ORDER
    in turn and returns the first non-empty result set.

    Returns {"engine": <slug used>, "results": [...]}. A specific engine that
    finds nothing still returns that engine's slug with an empty list — only
    the no-engine-named "try them all" mode falls through to the next one.
    """
    if engine:
        mod = ENGINES.get(engine)
        if not mod:
            raise ValueError(f"Unknown engine \"{engine}\" (available: {', '.join(ENGINES)})")
        return {"engine": engine, "results": mod.search(query=query, category=category, sort=sort, limit=limit)}

    last_error = None
    last_empty = None  # {"engine": slug, "results": []} from the last engine that at least responded
    for slug in FALLBACK_ORDER:
        mod = ENGINES[slug]
        try:
            results = mod.search(query=query, category=category, sort=sort, limit=limit)
        except (ScrapeError, ValueError) as exc:
            # ScrapeError: this engine is down. ValueError: this request
            # doesn't suit this engine (e.g. bitsearch needs a non-empty
            # query) — either way, try the next one rather than failing the
            # whole auto search over one engine's quirk.
            last_error = exc
            continue
        if results:
            return {"engine": slug, "results": results}
        last_empty = {"engine": slug, "results": []}

    if last_empty:
        return last_empty  # every engine responded, none had a match
    raise last_error  # every engine in FALLBACK_ORDER errored out
