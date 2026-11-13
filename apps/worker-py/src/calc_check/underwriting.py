"""Performance against the underwritten base case of docs/08 section 11, worked in exact fractions.

A plan is a list of dated points. Each figure is worked out as a fraction and rounded once, half
up, to the ten places a result travels with before it is used again, which is what the
specification says ("held as it travels"). Nothing here shares code with the TypeScript library.
"""

from __future__ import annotations

from bisect import bisect_left
from decimal import ROUND_HALF_UP, Decimal, localcontext
from fractions import Fraction
from typing import Any

from calc_check.dates import days_between

METRICS = ("ebitda", "revenue", "net_debt")
_COLUMN = {"ebitda": "ebitdaLtm", "revenue": "revenueLtm", "net_debt": "netDebt"}
_QUANTUM = Decimal(1).scaleb(-10)

Point = dict[str, str | None]
Row = dict[str, Any]


class PlanError(ValueError):
    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


def travels(value: Fraction) -> Decimal:
    """A fraction at ten places, rounded half up; what rounds to nothing is a plain zero."""
    with localcontext() as ctx:
        ctx.prec = 200
        exact = Decimal(value.numerator) / Decimal(value.denominator)
        rounded = exact.quantize(_QUANTUM, rounding=ROUND_HALF_UP)
    return Decimal(0) if rounded == 0 else rounded


def _held(value: Fraction) -> Fraction:
    return Fraction(travels(value))


def _figure(point: Point, metric: str) -> Fraction | None:
    raw = point[_COLUMN[metric]]
    return None if raw is None else Fraction(raw)


def plan_at(points: list[Point], metric: str, day: str) -> tuple[Fraction | None, bool, str | None]:
    """The plan figure on a day: (figure, whether it is a straight line, the reason for none)."""
    plan = sorted(points, key=lambda p: str(p["periodEnd"]))
    dates = [str(p["periodEnd"]) for p in plan]
    if len(set(dates)) != len(dates):
        raise PlanError("two plan points on one date", "duplicate_plan_date")
    if not plan:
        return None, False, "missing_plan_figure"
    if day < dates[0]:
        return None, False, "before_plan_start"
    if day > dates[-1]:
        return None, False, "past_plan_end"
    at = bisect_left(dates, day)
    if dates[at] == day:
        own = _figure(plan[at], metric)
        return (None, False, "missing_plan_figure") if own is None else (own, False, None)
    left, right = _figure(plan[at - 1], metric), _figure(plan[at], metric)
    if left is None or right is None:
        return None, False, "missing_plan_figure"
    share = Fraction(days_between(dates[at - 1], day), days_between(dates[at - 1], dates[at]))
    return _held(left + (right - left) * share), True, None


def status(favourable: Fraction, tolerance: Fraction) -> str:
    """Ahead above the tolerance, behind below its negative; either edge is on plan."""
    if tolerance < 0:
        raise PlanError("a tolerance cannot be below zero", "invalid_plan_tolerance")
    if favourable > tolerance:
        return "ahead"
    return "behind" if favourable < -tolerance else "on_plan"


def _metric_row(points: list[Point], metric: str, quarter: Point | None, tol: Fraction) -> Row:
    row: Row = {
        "metric": metric,
        "actual": None,
        "plan": None,
        "interpolated": False,
        "variance": None,
        "variancePct": None,
        "status": None,
        "notCalculable": None,
    }
    if quarter is None:
        row["notCalculable"] = "no_current_quarter"
        return row
    actual = _figure(quarter, metric)
    plan, line, reason = plan_at(points, metric, str(quarter["periodEnd"]))
    row["actual"] = None if actual is None else travels(actual)
    row["plan"] = None if plan is None else travels(plan)
    row["interpolated"] = line
    if plan is None:
        row["notCalculable"] = reason
    elif actual is None:
        row["notCalculable"] = "missing_actual"
    else:
        row["variance"] = travels(actual - plan)
        if plan <= 0:
            row["notCalculable"] = "non_positive_plan"
        else:
            pct = _held((actual - plan) / plan)
            row["variancePct"] = travels(pct)
            # Less net debt than planned is the good side, so its percent is read negated.
            row["status"] = status(-pct if metric == "net_debt" else pct, tol)
    return row


def plan_metrics(points: list[Point], quarter: Point | None, tolerance: str) -> list[Row]:
    """The quarter against plan, one row a metric, EBITDA first."""
    tol = Fraction(tolerance)
    status(Fraction(0), tol)
    return [_metric_row(points, metric, quarter, tol) for metric in METRICS]


def headline(rows: list[Row]) -> str | None:
    """The status of EBITDA: the one figure a comparison leads with."""
    for row in rows:
        if row["metric"] == "ebitda":
            found: str | None = row["status"]
            return found
    return None


NUMBERS = ("actual", "plan", "variance", "variancePct")
EXACT = ("metric", "interpolated", "status", "notCalculable")


def row_differences(mine: Row, theirs: dict[str, Any], tol: Decimal, label: str) -> list[str]:
    """Where a row of ours differs from a row as it travelled: words exactly, numbers within tol."""
    found: list[str] = []
    for key in EXACT:
        if mine[key] != theirs[key]:
            found.append(f"{label} {key} {mine[key]} vs {theirs[key]}")
    for key in NUMBERS:
        a: Decimal | None = mine[key]
        b = None if theirs[key] is None else Decimal(theirs[key])
        if a is None or b is None:
            if a is not None or b is not None:
                found.append(f"{label} {key} {a} vs {b}")
        elif abs(a - b) > tol * max(Decimal(1), abs(a), abs(b)):
            found.append(f"{label} {key} {a} vs {b}")
    return found
