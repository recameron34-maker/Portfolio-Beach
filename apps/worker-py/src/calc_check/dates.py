"""Calendar-date helpers on ISO strings. No time zones, no datetime.now()."""

from __future__ import annotations

import calendar
from datetime import date


def parse(iso: str) -> date:
    return date.fromisoformat(iso)


def days_between(a: str, b: str) -> int:
    return (parse(b) - parse(a)).days


def add_months(iso: str, months: int) -> str:
    d = parse(iso)
    index = d.year * 12 + (d.month - 1) + months
    year, month = divmod(index, 12)
    month += 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day).isoformat()


def add_years(iso: str, years: int) -> str:
    return add_months(iso, years * 12)
