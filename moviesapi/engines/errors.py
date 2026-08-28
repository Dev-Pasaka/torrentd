class ScrapeError(Exception):
    """An engine's site was unreachable, or its markup no longer matches what we parse."""
