"""A clean starting point. Nothing here trips a rule."""

import logging

log = logging.getLogger(__name__)


def load_rows(raw: str) -> list[str]:
    rows = [line for line in raw.splitlines() if line.strip()]
    log.info("loaded %s rows", len(rows))
    return rows


def first_row(rows: list[str]) -> str | None:
    return rows[0] if rows else None
