from __future__ import annotations

from decimal import Decimal


def ev_to_ebitda(ev: Decimal, ebitda: Decimal | None) -> Decimal | None:
    if ebitda is None or ebitda <= 0:
        return None
    return ev / ebitda


def net_debt_to_ebitda(net_debt: Decimal, ebitda: Decimal | None) -> Decimal | None:
    if ebitda is None or ebitda <= 0:
        return None
    return net_debt / ebitda


def ebitda_margin(ebitda: Decimal, revenue: Decimal | None) -> Decimal | None:
    if revenue is None or revenue <= 0:
        return None
    return ebitda / revenue


def yoy_growth(current: Decimal | None, prior: Decimal | None) -> Decimal | None:
    if current is None or prior is None or prior <= 0:
        return None
    return current / prior - 1


def growth_since_entry(current: Decimal | None, entry: Decimal | None) -> Decimal | None:
    if current is None or entry is None or entry <= 0:
        return None
    return current / entry - 1
