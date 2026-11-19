"""Valuation suggestions of docs/08 section 12, worked in exact fractions.

A suggested mark is one figure from one source: the ending balance of a capital account statement
at our share, or our last Locked mark scaled by the change in the company's equity value. Each is
worked out as a fraction and rounded once, half up, to the cent; what sits beside it (a change, a
percent, a difference) starts from the rounded figure. Nothing here shares code with the
TypeScript library.
"""

from __future__ import annotations

from decimal import Decimal
from fractions import Fraction
from typing import Any

Row = dict[str, Any]

SPONSOR_MARK = "valuation_method.sponsor_mark"
REPORT_INDICATION = "valuation_method.report_indication"

# Dollars in one of each unit a statement line may be read in, finest first.
_DOLLARS = {"USD": 1, "USD_K": 1_000, "USD_M": 1_000_000, "USD_B": 1_000_000_000}
_BALANCE_LINES = (
    "beginningBalance",
    "contributionsInPeriod",
    "distributionsInPeriod",
    "netGainLoss",
    "endingBalance",
)


class SuggestionError(ValueError):
    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


def _half_up(value: Fraction, places: int) -> Fraction:
    """Rounded to a number of places, a tie going away from zero, with whole numbers only."""
    scale = 10**places
    size = abs(value) * scale
    whole = (2 * size.numerator + size.denominator) // (2 * size.denominator)
    return Fraction(whole if value >= 0 else -whole, scale)


def cents(value: Fraction) -> Fraction:
    return _half_up(value, 2)


def travels(value: Fraction | None) -> Decimal | None:
    """A figure at the ten places it travels with; nothing stays nothing, and zero has no sign."""
    if value is None:
        return None
    held = _half_up(value, 10)
    # Built from its digits, so a figure of any size is exact whatever the decimal context.
    tenths = held.numerator * (10**10 // held.denominator)
    digits = tuple(int(digit) for digit in str(abs(tenths)))
    return Decimal((1 if tenths < 0 else 0, digits, -10))


def _held(value: Fraction) -> Fraction:
    return _half_up(value, 10)


def _opt(raw: str | None) -> Fraction | None:
    return None if raw is None else Fraction(raw)


def _not_negative(raw: str, what: str) -> Fraction:
    value = Fraction(raw)
    if value < 0:
        raise SuggestionError(f"{what} cannot be below zero", "invalid_suggestion_input")
    return value


def tie_tolerance(units: list[str], settings: dict[str, Any]) -> Fraction:
    """The dollars a statement's lines may be apart: by the coarsest unit a line was read in."""
    coarsest = "USD"
    for unit in units:
        if unit not in _DOLLARS:
            raise SuggestionError(f"unknown money unit: {unit}", "unknown_unit")
        if _DOLLARS[unit] > _DOLLARS[coarsest]:
            coarsest = unit
    if coarsest == "USD":
        return _not_negative(settings["rollForwardToleranceUsd"], "the roll-forward tolerance")
    by_unit = settings["tieToleranceByUnit"]
    if coarsest not in by_unit:
        raise SuggestionError(f"no tie tolerance for {coarsest}", "missing_tie_tolerance")
    return _not_negative(by_unit[coarsest], "the tie tolerance")


def statement_mark(
    lines: dict[str, str | None],
    record_contributions: str,
    tie_tolerance_usd: str,
    contributions_tolerance: str,
) -> Row:
    """Rule 12.1: the ending balance at our share, with the tie-out and the contributions check."""
    tolerance = _not_negative(tie_tolerance_usd, "the tie tolerance")
    contributions_edge = _not_negative(contributions_tolerance, "the contributions tolerance")
    record = _not_negative(record_contributions, "the contributions on record")
    figures = {key: _opt(lines[key]) for key in (*_BALANCE_LINES, "contributionsToDate")}
    own_account = lines["share"] is None
    share = Fraction(1) if lines["share"] is None else Fraction(lines["share"])
    usable = 0 < share <= 1

    def ours(key: str) -> Fraction | None:
        line = figures[key]
        return None if line is None or not usable else cents(line * share)

    ending = figures["endingBalance"]
    value: Fraction | None = None
    reason: str | None = None
    if ending is None:
        reason = "no_ending_balance"
    elif ending <= 0:
        reason = "non_positive_balance"
    elif not usable:
        reason = "share_out_of_range"
    else:
        value = ours("endingBalance")
        if value is None or value <= 0:
            value, reason = None, "value_not_positive"

    ties: bool | None = None
    apart: Fraction | None = None
    stated = [figures[key] for key in _BALANCE_LINES]
    if all(line is not None for line in stated):
        begin, paid_in, paid_out, gain, end = (line for line in stated if line is not None)
        apart = end - (begin + paid_in - paid_out + gain)
        ties = abs(apart) <= tolerance

    to_date = ours("contributionsToDate")
    check: Row = {
        "statement": travels(to_date),
        "record": travels(record),
        "difference": None,
        "differencePct": None,
        "differs": None,
        "notChecked": None,
    }
    if figures["contributionsToDate"] is None:
        check["notChecked"] = "contributions_not_stated"
    elif to_date is None:
        check["notChecked"] = "share_out_of_range"
    elif record == 0:
        check["notChecked"] = "no_recorded_contributions"
    else:
        pct = _held((to_date - record) / record)
        check["difference"] = travels(to_date - record)
        check["differencePct"] = travels(pct)
        check["differs"] = abs(pct) > contributions_edge

    return {
        "basis": "capital_account_balance",
        "method": SPONSOR_MARK,
        "value": travels(value),
        "reason": reason,
        "ownAccount": own_account,
        "ours": {
            "beginningBalance": travels(ours("beginningBalance")),
            "contributionsInPeriod": travels(ours("contributionsInPeriod")),
            "distributionsInPeriod": travels(ours("distributionsInPeriod")),
        },
        "ties": ties,
        "tieDifference": travels(apart),
        "contributionsCheck": check,
    }


def _equity(figures: dict[str, str | None] | None) -> Fraction | None:
    if figures is None or figures["ev"] is None or figures["netDebt"] is None:
        return None
    return Fraction(figures["ev"]) - Fraction(figures["netDebt"])


def _reference_reason(inp: dict[str, Any], equity: Fraction | None) -> str | None:
    """Why there is no mark to scale: the first of the four that applies, or nothing."""
    if inp["referenceMark"] is None:
        return "no_reference_mark"
    if inp["flowsSinceReferenceMark"]:
        return "flows_since_reference_mark"
    if equity is None:
        return "no_reference_figures"
    return "non_positive_reference_equity" if equity <= 0 else None


def _scaled(mark: Fraction, equity: Fraction, reference_equity: Fraction) -> Fraction | None:
    """The mark at the new equity value, to the cent; nothing when that is not above zero."""
    value = cents(mark * equity / reference_equity)
    return value if value > 0 else None


def stake_mark(inp: dict[str, Any]) -> Row:
    """Rule 12.2: our last Locked mark scaled by the change in the sponsor's equity value."""
    then = _equity(inp["reference"])
    out: Row = {
        "basis": "sponsor_equity_value",
        "method": REPORT_INDICATION,
        "value": None,
        "reason": _reference_reason(inp, then),
        "referenceEquity": travels(then),
        "equity": None,
    }
    if out["reason"] is not None or then is None:
        return out
    now = _equity(inp["current"])
    if now is None:
        out["reason"] = "no_net_debt"
        return out
    out["equity"] = travels(now)
    if now <= 0:
        out["reason"] = "non_positive_equity"
        return out
    value = _scaled(Fraction(inp["referenceMark"]), now, then)
    out["value"] = travels(value)
    out["reason"] = None if value is not None else "value_not_positive"
    return out


def held_multiple_mark(inp: dict[str, Any]) -> Row:
    """Rule 12.3: rule 12.2 with the new enterprise value at the earlier quarter's multiple."""
    then = _equity(inp["reference"])
    out: Row = {
        "basis": "held_multiple",
        "method": REPORT_INDICATION,
        "value": None,
        "reason": _reference_reason(inp, then),
        "referenceEquity": travels(then),
        "impliedEv": None,
        "equity": None,
    }
    if out["reason"] is not None or then is None:
        return out
    earnings_then = _opt(inp["reference"]["ebitda"])
    earnings_now = _opt(inp["current"]["ebitda"])
    if earnings_then is None or earnings_now is None:
        out["reason"] = "no_ebitda"
        return out
    if earnings_then <= 0 or earnings_now <= 0:
        out["reason"] = "non_positive_ebitda"
        return out
    multiple = Fraction(inp["reference"]["ev"]) / earnings_then
    implied = earnings_now * multiple
    out["impliedEv"] = travels(implied)
    debt_now = _opt(inp["current"]["netDebt"])
    if debt_now is None:
        out["reason"] = "no_net_debt"
        return out
    now = implied - debt_now
    out["equity"] = travels(now)
    if now <= 0:
        out["reason"] = "non_positive_equity"
        return out
    value = _scaled(Fraction(inp["referenceMark"]), now, then)
    out["value"] = travels(value)
    out["reason"] = None if value is not None else "value_not_positive"
    return out


def flagged(pct: Fraction | None, flag: Fraction) -> bool:
    """The board's variance rule: the percent as it travels, at or above the flag either way."""
    if flag < 0:
        raise SuggestionError("the variance flag cannot be below zero", "invalid_suggestion_input")
    return pct is not None and abs(_held(pct)) >= flag


def _ratio(part: Fraction, base: Fraction) -> Fraction | None:
    return None if base == 0 else part / base


def mark_comparison(inp: dict[str, Any], variance_flag: str) -> Row:
    """Rule 12.4: a value against the mark on record, and its change net of the quarter's flows."""
    flag = Fraction(variance_flag)
    flagged(None, flag)
    statement = inp["statement"]
    edge = None if statement is None else _not_negative(statement["tieToleranceUsd"], "tie")
    begin = None if statement is None else _opt(statement["beginningBalance"])
    out: Row = {
        "change": None,
        "changePct": None,
        "variance": False,
        "netOfFlows": None,
        "netOfFlowsPct": None,
        "beginningBalance": travels(begin),
    }
    suggested, current = _opt(inp["suggested"]), _opt(inp["current"])
    if suggested is None or current is None:
        return out
    change = suggested - current
    pct = _ratio(change, current)
    out["change"] = travels(change)
    out["changePct"] = travels(pct)
    previous = bool(inp["currentIsPreviousQuarter"])
    out["variance"] = previous and flagged(pct, flag)
    if not previous or statement is None or begin is None or edge is None:
        return out
    paid_in, paid_out = (
        _opt(statement["contributionsInPeriod"]),
        _opt(statement["distributionsInPeriod"]),
    )
    if paid_in is None or paid_out is None or abs(begin - current) > edge:
        return out
    net = change - paid_in + paid_out
    out["netOfFlows"] = travels(net)
    out["netOfFlowsPct"] = travels(_ratio(net, current))
    return out


def cross_check(other: str | None, suggested: str | None, variance_flag: str) -> Row:
    """Rule 12.5: another source's value against the suggested one."""
    flag = Fraction(variance_flag)
    flagged(None, flag)
    theirs, ours = _opt(other), _opt(suggested)
    if theirs is None or ours is None:
        return {"difference": None, "differencePct": None, "differs": False}
    pct = _ratio(theirs - ours, ours)
    return {
        "difference": travels(theirs - ours),
        "differencePct": travels(pct),
        "differs": flagged(pct, flag),
    }
