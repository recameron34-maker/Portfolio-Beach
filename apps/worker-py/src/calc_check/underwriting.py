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

from calc_check import bridge as vc
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


DRIVERS = ("ebitdaGrowth", "multipleExpansion", "debtPaydown", "total")
_BAD_CASE = "invalid_underwriting_case"


def _checked(case: dict[str, Any]) -> tuple[Decimal, Fraction, Fraction | None]:
    """The underwritten IRR and MOIC and an equity case's exit multiple; bad ones are refused."""
    rate, target = Decimal(case["grossIrr"]), Fraction(case["grossMoic"])
    if rate <= -1 or target <= 0:
        raise PlanError("an underwritten IRR is above -100% and a MOIC above zero", _BAD_CASE)
    if case["form"] == "credit":
        return rate, target, None
    multiple = None if case["exitMultiple"] is None else Fraction(case["exitMultiple"])
    if multiple is None or multiple <= 0:
        raise PlanError("an equity case has an exit multiple above zero", _BAD_CASE)
    dates = [p["periodEnd"] for p in case["points"]]
    if len(set(dates)) != len(dates):
        raise PlanError("two plan points on one date", "duplicate_plan_date")
    return rate, target, multiple


def path_value(flows: list[dict[str, str]], rate: Decimal, as_of: str) -> Decimal:
    """What the flows would be worth on a day had each grown at the rate since it was paid."""
    if rate <= -1:
        raise PlanError("an underwritten IRR is above -100%", _BAD_CASE)
    with localcontext() as ctx:
        ctx.prec = 60
        growth = Decimal(1) + rate
        worth = Decimal(0)
        for flow in flows:
            years = Decimal(days_between(flow["date"], as_of)) / Decimal(365)
            worth -= Decimal(flow["amount"]) * growth**years
        rounded = worth.quantize(_QUANTUM, rounding=ROUND_HALF_UP)
    return Decimal(0) if rounded == 0 else rounded


def returns(case: dict[str, Any], inp: dict[str, Any], irr_tolerance: Fraction) -> Row:
    """Our IRR against the underwritten one, and our MOIC against the path or the exit target."""
    rate, target, _ = _checked(case)
    irr = None if inp["grossIrr"] is None else Fraction(inp["grossIrr"])
    moic = None if inp["grossMoic"] is None else Fraction(inp["grossMoic"])
    gap = None if irr is None else _held(irr - Fraction(rate))
    judged = None if gap is None or inp["irrFlag"] is not None else status(gap, irr_tolerance)

    on_path: Fraction | None = None
    against: Fraction | None = None
    reason: str | None = None
    if not inp["isActive"]:
        against = target
    elif inp["asOf"] > case["plannedExitDate"]:
        reason = "past_plan_end"
    elif inp["invested"] is None or inp["distributions"] is None or Fraction(inp["invested"]) == 0:
        reason = "no_invested_capital"
    else:
        worth = Fraction(path_value(inp["flows"], rate, inp["asOf"]))
        on_path = _held((Fraction(inp["distributions"]) + worth) / abs(Fraction(inp["invested"])))
        against = on_path
    return {
        "grossIrr": None if irr is None else travels(irr),
        "irrGap": None if gap is None else travels(gap),
        "irrStatus": judged,
        "irrFlag": inp["irrFlag"],
        "grossMoic": None if moic is None else travels(moic),
        "moicOnPath": None if on_path is None else travels(on_path),
        "moicGap": None if moic is None or against is None else travels(moic - against),
        "pathNotCalculable": reason,
    }


def _planned(
    case: dict[str, Any], multiple: Fraction, entry: dict[str, Any] | None
) -> tuple[dict[str, Decimal] | None, str | None]:
    """The bridge the sponsor planned, from the entry snapshot to the point on the planned exit."""
    if entry is None:
        return None, "no_entry_snapshot"
    if entry["ebitdaLtm"] is None or entry["ev"] is None or entry["netDebt"] is None:
        return None, "missing_figures"
    at_exit = [p for p in case["points"] if p["periodEnd"] == case["plannedExitDate"]]
    if not at_exit or at_exit[0]["ebitdaLtm"] is None or at_exit[0]["netDebt"] is None:
        return None, "missing_plan_figure"
    with localcontext() as ctx:
        ctx.prec = 80
        exit_ebitda = Decimal(at_exit[0]["ebitdaLtm"])
        exit_ev = exit_ebitda * Decimal(multiple.numerator) / Decimal(multiple.denominator)
    found = vc.bridge(
        {
            "ebitda": Decimal(entry["ebitdaLtm"]),
            "ev": Decimal(entry["ev"]),
            "netDebt": Decimal(entry["netDebt"]),
        },
        {"ebitda": exit_ebitda, "ev": exit_ev, "netDebt": Decimal(at_exit[0]["netDebt"])},
    )
    if found is None:
        return None, "non_positive_ebitda"
    return {key: travels(Fraction(str(found[key]))) for key in DRIVERS}, None


def value_creation(case: dict[str, Any], multiple: Fraction, inp: dict[str, Any]) -> Row:
    """The planned bridge beside the actual one, the share of each earned, and the time gone."""
    entry, current, given = inp["entry"], inp["current"], inp["bridge"]
    if given is None and inp["bridgeNotCalculable"] is None:
        raise PlanError("no bridge and no reason for it", "invalid_underwriting_inputs")
    planned, plan_reason = _planned(case, multiple, entry)
    actual = None if given is None else {key: travels(Fraction(given[key])) for key in DRIVERS}
    progress: dict[str, Decimal | None] | None = None
    if planned is not None and actual is not None:
        progress = {
            key: None
            if planned[key] <= 0
            else travels(Fraction(actual[key]) / Fraction(planned[key]))
            for key in DRIVERS
        }
    time_passed: Decimal | None = None
    if entry is not None and current is not None:
        whole = days_between(entry["periodEnd"], case["plannedExitDate"])
        gone = days_between(entry["periodEnd"], current["periodEnd"])
        # A quarter dated before the entry snapshot: none of the planned time has begun.
        if whole > 0 and gone >= 0:
            time_passed = travels(Fraction(gone, whole))
    return {
        "planned": planned,
        "actual": actual,
        "progress": progress,
        "timePassed": time_passed,
        "notCalculable": inp["bridgeNotCalculable"] if actual is None else plan_reason,
    }


def series(points: list[Point], quarters: list[Point], current: Point | None) -> list[Row]:
    """Actual and plan by date for each metric: the approved quarters so far and the plan dates."""
    counted: dict[str, Point] = {}
    if current is not None:
        cutoff = str(current["periodEnd"])
        earlier = [q for q in quarters if str(q["periodEnd"]) < cutoff]
        counted = {str(q["periodEnd"]): q for q in earlier}
        if len(counted) != len(earlier):
            raise PlanError("two quarters on one date", "duplicate_quarter_date")
        counted[cutoff] = current
    days = sorted(set(counted) | {str(p["periodEnd"]) for p in points})
    out: list[Row] = []
    for metric in METRICS:
        rows: list[Row] = []
        for day in days:
            quarter = counted.get(day)
            actual = None if quarter is None else _figure(quarter, metric)
            plan, line, _ = plan_at(points, metric, day)
            rows.append(
                {
                    "periodEnd": day,
                    "actual": None if actual is None else travels(actual),
                    "plan": None if plan is None else travels(plan),
                    "interpolated": line,
                }
            )
        out.append({"metric": metric, "points": rows})
    return out


def comparison(case: dict[str, Any], inp: dict[str, Any], tolerances: dict[str, str]) -> Row:
    """A position against its base case: everything for equity, the returns alone for a loan."""
    on_plan, irr_tolerance = (
        Fraction(tolerances["onPlanTolerance"]),
        Fraction(tolerances["irrTolerance"]),
    )
    status(Fraction(0), on_plan)
    status(Fraction(0), irr_tolerance)
    _, _, multiple = _checked(case)
    answer: Row = {
        "quarter": None,
        "metrics": [],
        "headline": None,
        "series": [],
        "valueCreation": None,
        "returns": returns(case, inp, irr_tolerance),
        "yieldToMaturity": None,
    }
    if multiple is None:
        given = inp["yieldToMaturity"]
        answer["yieldToMaturity"] = None if given is None else travels(Fraction(given))
        return answer
    current = inp["current"]
    rows = plan_metrics(case["points"], current, tolerances["onPlanTolerance"])
    answer["quarter"] = None if current is None else current["periodEnd"]
    answer["metrics"] = rows
    answer["headline"] = headline(rows)
    answer["series"] = series(case["points"], inp["quarters"], current)
    answer["valueCreation"] = value_creation(case, multiple, inp)
    return answer


def differences(mine: Any, theirs: Any, label: str) -> list[str]:
    """Where an answer of ours differs from one as it travelled.

    Ours holds a Decimal wherever the travelled one holds a number as text. Both sides are
    rounded half up to ten places from an exact or a high-precision figure, so they agree to the
    last place or they differ: no tolerance, which on a figure of hundreds of millions would let
    the last places slip. Everything else (dates, flags, statuses, reasons, nothing at all)
    agrees exactly too.
    """
    if isinstance(mine, dict) and isinstance(theirs, dict):
        if set(mine) != set(theirs):
            return [f"{label}: keys {sorted(mine)} vs {sorted(theirs)}"]
        return [d for key in mine for d in differences(mine[key], theirs[key], f"{label}.{key}")]
    if isinstance(mine, list) and isinstance(theirs, list):
        if len(mine) != len(theirs):
            return [f"{label}: {len(mine)} rows vs {len(theirs)}"]
        return [
            d
            for n, (a, b) in enumerate(zip(mine, theirs, strict=True))
            for d in differences(a, b, f"{label}[{n}]")
        ]
    if isinstance(mine, Decimal):
        if not isinstance(theirs, str):
            return [f"{label}: {mine} vs {theirs}"]
        other = Decimal(theirs)
        return [] if mine == other else [f"{label}: {mine} vs {other}"]
    return [] if mine == theirs and type(mine) is type(theirs) else [f"{label}: {mine} vs {theirs}"]
