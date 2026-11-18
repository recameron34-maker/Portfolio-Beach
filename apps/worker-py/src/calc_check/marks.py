"""Which marks and flows count for a suggestion's quarter (docs/08 section 12).

An implementation of its own, on calendar dates and a count of quarters, of the rules the
TypeScript library states on ISO strings (packages/calc/src/suggestion.ts): the latest Locked mark
of an earlier quarter, whether the quarter is already marked, and whether cash has moved between
two dates. A mark counts for the quarter end it is within the tolerance of, and for its own date
otherwise.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any


class MarksError(ValueError):
    """An input the rules do not accept."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


def _index(d: date) -> int:
    """The calendar quarter a date is in, counted from year zero."""
    return d.year * 4 + (d.month - 1) // 3


def _end_of(index: int) -> date:
    """The last day of a calendar quarter: the day before the next one starts."""
    year, quarter = divmod(index + 1, 4)
    return date(year, quarter * 3 + 1, 1) - timedelta(days=1)


def is_quarter_end(iso: str) -> bool:
    d = date.fromisoformat(iso)
    return _end_of(_index(d)) == d


def _require_quarter_end(iso: str) -> None:
    if not is_quarter_end(iso):
        raise MarksError(f"not a calendar quarter end: {iso}", "invalid_quarter_end")


def aligned_quarter_end(period_end: str, tolerance_days: int) -> str:
    """The quarter end a period end reports for: one within the tolerance, else the date itself."""
    d = date.fromisoformat(period_end)
    own = _end_of(_index(d))
    if own == d:
        return period_end
    before = _end_of(_index(d) - 1)
    after_before = (d - before).days
    until_own = (own - d).days
    # The nearer of the two; a date as far from both goes to the earlier one.
    nearest, distance = (before, after_before) if after_before <= until_own else (own, until_own)
    return nearest.isoformat() if distance <= tolerance_days else period_end


def previous_quarter_end(quarter_end: str) -> str:
    _require_quarter_end(quarter_end)
    return _end_of(_index(date.fromisoformat(quarter_end)) - 1).isoformat()


def quarters_between(start: str, end: str) -> int:
    """Whole calendar quarters from the quarter of one date to the quarter of another."""
    return _index(date.fromisoformat(end)) - _index(date.fromisoformat(start))


def latest_locked_before(
    marks: list[dict[str, Any]], quarter_end: str, tolerance_days: int
) -> dict[str, Any] | None:
    """The latest Locked mark that reports for a date before the quarter end, and how it stands.

    On equal period ends the first listed is kept.
    """
    _require_quarter_end(quarter_end)
    target = date.fromisoformat(quarter_end)
    best: dict[str, Any] | None = None
    best_reports_for = ""
    for mark in marks:
        if mark["state"] != "Locked":
            continue
        reports_for = aligned_quarter_end(mark["periodEnd"], tolerance_days)
        if date.fromisoformat(reports_for) >= target:
            continue
        if best is None or date.fromisoformat(mark["periodEnd"]) > date.fromisoformat(
            best["periodEnd"]
        ):
            best, best_reports_for = mark, reports_for
    if best is None:
        return None
    return {
        "mark": best,
        "reportsFor": best_reports_for,
        "previousQuarter": best_reports_for == previous_quarter_end(quarter_end),
        "ageQuarters": quarters_between(best_reports_for, quarter_end),
    }


def locked_for_or_after(marks: list[dict[str, Any]], quarter_end: str, tolerance_days: int) -> bool:
    """True when a Locked mark reports for the quarter end or a later date."""
    _require_quarter_end(quarter_end)
    target = date.fromisoformat(quarter_end)
    return any(
        mark["state"] == "Locked"
        and date.fromisoformat(aligned_quarter_end(mark["periodEnd"], tolerance_days)) >= target
        for mark in marks
    )


def has_flow_between(flows: list[dict[str, str]], after: str, on_or_before: str) -> bool:
    """True when a flow is dated after one date and on or before another."""
    start = date.fromisoformat(after)
    end = date.fromisoformat(on_or_before)
    return any(start < date.fromisoformat(flow["date"]) <= end for flow in flows)


def reference_answer(
    marks: list[dict[str, Any]], flows: list[dict[str, str]], quarter_end: str, tolerance_days: int
) -> dict[str, Any]:
    """What a suggestion's quarter is set against, as the fixture and the cross-check state it."""
    found = latest_locked_before(marks, quarter_end, tolerance_days)
    return {
        "reference": None
        if found is None
        else {
            "mark": found["mark"]["id"],
            "reportsFor": found["reportsFor"],
            "previousQuarter": found["previousQuarter"],
            "ageQuarters": found["ageQuarters"],
        },
        "lockedForOrAfter": locked_for_or_after(marks, quarter_end, tolerance_days),
        "flowsSinceReference": None
        if found is None
        else has_flow_between(flows, found["mark"]["periodEnd"], quarter_end),
    }
