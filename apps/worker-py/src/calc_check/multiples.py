from __future__ import annotations

from decimal import Decimal, localcontext

from calc_check import CTX
from calc_check.dates import days_between


def paid_in(contributions: Decimal) -> Decimal | None:
    pi = abs(contributions)
    return None if pi == 0 else pi


def dpi(distributions: Decimal, contributions: Decimal) -> Decimal | None:
    pi = paid_in(contributions)
    return None if pi is None else distributions / pi


def rvpi(nav: Decimal, contributions: Decimal) -> Decimal | None:
    pi = paid_in(contributions)
    return None if pi is None else nav / pi


def tvpi(distributions: Decimal, nav: Decimal, contributions: Decimal) -> Decimal | None:
    pi = paid_in(contributions)
    return None if pi is None else (distributions + nav) / pi


def moic(realized: Decimal, unrealized: Decimal, invested: Decimal) -> Decimal | None:
    inv = abs(invested)
    return None if inv == 0 else (realized + unrealized) / inv


def value_change(current: Decimal | None, prior: Decimal | None) -> Decimal | None:
    """Mark-to-mark change (current - prior) / prior; None when a value is missing or prior is 0."""
    if current is None or prior is None or prior == 0:
        return None
    with localcontext(CTX):
        return (current - prior) / prior


def unfunded(
    commitment: Decimal | None, contributions: Decimal, recallable: Decimal = Decimal(0)
) -> Decimal | None:
    if commitment is None:
        return None
    return commitment - abs(contributions) + abs(recallable)


def holding_period_years(first_contribution: str | None, exit_or_as_of: str) -> Decimal | None:
    if first_contribution is None:
        return None
    return Decimal(days_between(first_contribution, exit_or_as_of)) / Decimal(365)
