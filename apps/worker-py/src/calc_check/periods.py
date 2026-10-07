from __future__ import annotations

from typing import TypedDict

from calc_check.dates import add_years, days_between


class PeriodRow(TypedDict, total=False):
    periodEnd: str
    status: str
    isEntrySnapshot: bool


def same_quarter_prior_year(
    rows: list[PeriodRow], target: str, tolerance_days: int = 7
) -> PeriodRow | None:
    wanted = add_years(target, -1)
    best: PeriodRow | None = None
    best_distance = tolerance_days + 1
    for row in rows:
        if row.get("isEntrySnapshot", False):
            continue
        distance = abs(days_between(wanted, row["periodEnd"]))
        if distance <= tolerance_days and distance < best_distance:
            best, best_distance = row, distance
    return best


def latest_period(rows: list[PeriodRow], reporting_date: str) -> PeriodRow | None:
    best: PeriodRow | None = None
    for row in rows:
        if row.get("isEntrySnapshot", False) or row.get("status") != "approved":
            continue
        if row["periodEnd"] > reporting_date:
            continue
        if best is None or row["periodEnd"] > best["periodEnd"]:
            best = row
    return best


def entry_snapshot(rows: list[PeriodRow]) -> PeriodRow | None:
    flagged = [r for r in rows if r.get("isEntrySnapshot", False)]
    if len(flagged) > 1:
        raise ValueError("multiple_entry_snapshots")
    return flagged[0] if flagged else None
