from __future__ import annotations

from decimal import Decimal, localcontext

from calc_check import CTX
from calc_check.irr import Flow, IrrResult, xirr

IndexSeries = list[tuple[str, Decimal]]


def index_at(series: IndexSeries, date: str) -> Decimal:
    best: tuple[str, Decimal] | None = None
    for d, level in series:
        if d <= date and (best is None or d > best[0]):
            best = (d, level)
    if best is None:
        raise ValueError("index_missing")
    return best[1]


def ks_pme(flows: list[Flow], nav: Decimal, nav_date: str, index: IndexSeries) -> Decimal | None:
    with localcontext(CTX):
        end = index_at(index, nav_date)
        contributions = Decimal(0)
        distributions = Decimal(0)
        for d, a in flows:
            factor = end / index_at(index, d)
            if a < 0:
                contributions += abs(a) * factor
            else:
                distributions += a * factor
        if contributions == 0:
            return None
        return (distributions + nav) / contributions


def direct_alpha(
    flows: list[Flow], nav: Decimal, nav_date: str, index: IndexSeries
) -> tuple[Decimal | None, IrrResult]:
    with localcontext(CTX):
        end = index_at(index, nav_date)
        adjusted: list[Flow] = [(d, a * end / index_at(index, d)) for d, a in flows]
        adjusted.append((nav_date, nav))
        irr = xirr(adjusted)
        if irr.value is None:
            return None, irr
        return (Decimal(1) + irr.value).ln(), irr
