"""Value creation analytics of docs/08 section 8, worked in exact fractions.

The EBITDA bridge is written here as the substitution itself: the equity value is recomputed
after each input changes (EBITDA, then the multiple, then net debt) and a driver is the difference
between two steps. Fractions keep every step exact; a part is rounded once, half up, to the places
the specification names, and the last part of a split is what remains of the whole.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, localcontext
from fractions import Fraction
from itertools import pairwise

from calc_check import CTX

SPLIT_PLACES = 20
RESULT_PLACES = 10
_QUANTUM = Decimal(1).scaleb(-SPLIT_PLACES)
_RESULT_QUANTUM = Decimal(1).scaleb(-RESULT_PLACES)


def _rounded(value: Fraction, quantum: Decimal) -> Decimal:
    with localcontext() as ctx:
        ctx.prec = 200
        exact = Decimal(value.numerator) / Decimal(value.denominator)
        return exact.quantize(quantum, rounding=ROUND_HALF_UP)


def _held(value: Fraction) -> Decimal:
    """A fraction as a decimal held to the split places, rounded half up, in one rounding."""
    return _rounded(value, _QUANTUM)


def _travels(value: Fraction) -> Decimal:
    """A fraction as a decimal at the ten places a result travels with, rounded half up."""
    return _rounded(value, _RESULT_QUANTUM)


def _ratio(numerator: Decimal, denominator: Decimal) -> Decimal:
    with localcontext(CTX):
        return numerator / denominator


def bridge(
    entry: dict[str, Decimal | None], current: dict[str, Decimal | None]
) -> dict[str, Decimal | dict[str, Decimal] | None] | None:
    """None when an EBITDA is not positive (the caller reports non_positive_ebitda)."""
    e0, ev0, d0 = entry["ebitda"], entry["ev"], entry["netDebt"]
    e1, ev1, d1 = current["ebitda"], current["ev"], current["netDebt"]
    assert e0 is not None and ev0 is not None and d0 is not None
    assert e1 is not None and ev1 is not None and d1 is not None
    if e0 <= 0 or e1 <= 0:
        return None
    x0 = Fraction(ev0) / Fraction(e0)
    x1 = Fraction(ev1) / Fraction(e1)
    equity0 = Fraction(e0) * x0 - Fraction(d0)
    after_ebitda = Fraction(e1) * x0 - Fraction(d0)
    after_multiple = Fraction(e1) * x1 - Fraction(d0)
    equity1 = Fraction(e1) * x1 - Fraction(d1)

    ebitda_growth = _held(after_ebitda - equity0)
    debt_paydown = _held(equity1 - after_multiple)
    total = _held(equity1 - equity0)

    revenue_growth: Decimal | None = None
    margin_change: Decimal | None = None
    r0, r1 = entry.get("revenue"), current.get("revenue")
    if r0 is not None and r1 is not None and r0 > 0 and r1 > 0:
        margin0 = Fraction(e0) / Fraction(r0)
        after_revenue = Fraction(r1) * margin0 * x0 - Fraction(d0)
        revenue_growth = _held(after_revenue - equity0)

    shares: dict[str, Decimal] | None = None
    with localcontext(CTX):
        multiple_expansion = total - ebitda_growth - debt_paydown
        if revenue_growth is not None:
            margin_change = ebitda_growth - revenue_growth
        if total != 0:
            shares = {
                "ebitdaGrowth": ebitda_growth / total,
                "multipleExpansion": multiple_expansion / total,
                "debtPaydown": debt_paydown / total,
            }
    return {
        "equityAtEntry": _held(equity0),
        "equityCurrent": _held(equity1),
        "ebitdaGrowth": ebitda_growth,
        "multipleExpansion": multiple_expansion,
        "debtPaydown": debt_paydown,
        "total": total,
        "shares": shares,
        "revenueGrowth": revenue_growth,
        "marginChange": margin_change,
    }


def total_gain(distributions: Decimal, nav: Decimal, invested: Decimal) -> Decimal | None:
    paid = abs(invested)
    if paid == 0:
        return None
    with localcontext(CTX):
        return distributions + nav - paid


def entry_stake(invested: Decimal | None, equity_at_entry: Decimal | None) -> Decimal | None:
    """Our invested capital over the company's equity value at entry; None when either is not."""
    if invested is None or equity_at_entry is None:
        return None
    paid = abs(invested)
    if paid == 0 or equity_at_entry <= 0:
        return None
    return _ratio(paid, equity_at_entry)


def gain_by_driver(
    gain: Decimal | None,
    invested: Decimal | None,
    equity_at_entry: Decimal,
    ebitda_growth: Decimal,
    multiple_expansion: Decimal,
    debt_paydown: Decimal,
    revenue_growth: Decimal | None,
) -> dict[str, Decimal | None] | str:
    """Our gain against the company's drivers at our entry stake, or the reason there is none.

    Each driver part is the stake times the driver, rounded once to the places a result travels
    with; what remains of the gain is the part the company's change does not explain.
    """
    if gain is None or invested is None or invested == 0:
        return "no_gain"
    stake = entry_stake(invested, equity_at_entry)
    if stake is None:
        return "non_positive_entry_equity"
    ours = Fraction(abs(invested)) / Fraction(equity_at_entry)

    def part(driver: Decimal) -> Decimal:
        return _travels(ours * Fraction(driver))

    from_ebitda = part(ebitda_growth)
    from_multiple = part(multiple_expansion)
    from_debt = part(debt_paydown)
    from_revenue = None if revenue_growth is None else part(revenue_growth)
    with localcontext(CTX):
        return {
            "stake": stake,
            "ebitdaGrowth": from_ebitda,
            "multipleExpansion": from_multiple,
            "debtPaydown": from_debt,
            "other": gain - from_ebitda - from_multiple - from_debt,
            "revenueGrowth": from_revenue,
            "marginChange": None if from_revenue is None else from_ebitda - from_revenue,
        }


def _growth(current: Decimal | None, base: Decimal | None) -> Decimal | None:
    if current is None or base is None or base <= 0:
        return None
    with localcontext(CTX):
        return current / base - 1


def _per_ebitda(figure: Decimal | None, ebitda: Decimal | None) -> Decimal | None:
    if figure is None or ebitda is None or ebitda <= 0:
        return None
    return _ratio(figure, ebitda)


def _less(a: Decimal | None, b: Decimal | None) -> Decimal | None:
    if a is None or b is None:
        return None
    with localcontext(CTX):
        return a - b


def since_entry(
    entry: dict[str, Decimal | None], current: dict[str, Decimal | None]
) -> dict[str, Decimal | None]:
    equity0 = _less(entry["ev"], entry["netDebt"])
    equity1 = _less(current["ev"], current["netDebt"])
    return {
        "ebitdaGrowth": _growth(current["ebitda"], entry["ebitda"]),
        "evGrowth": _growth(current["ev"], entry["ev"]),
        "equityValueGrowth": _growth(equity1, equity0),
        "multipleChange": _less(
            _per_ebitda(current["ev"], current["ebitda"]),
            _per_ebitda(entry["ev"], entry["ebitda"]),
        ),
        "netLeverageChange": _less(
            _per_ebitda(current["netDebt"], current["ebitda"]),
            _per_ebitda(entry["netDebt"], entry["ebitda"]),
        ),
        "netDebtChange": _less(current["netDebt"], entry["netDebt"]),
        "ebitdaIndex": indexed_level(current["ebitda"], entry["ebitda"]),
        "evIndex": indexed_level(current["ev"], entry["ev"]),
        "equityValueIndex": indexed_level(equity1, equity0),
    }


def indexed_level(current: Decimal | None, base: Decimal | None) -> Decimal | None:
    if current is None or base is None or base <= 0:
        return None
    with localcontext(CTX):
        return current * 100 / base


class BandEdgesError(ValueError):
    code = "invalid_band_edges"


def _checked(edges: list[Decimal]) -> list[Decimal]:
    if not edges or any(b <= a for a, b in pairwise(edges)):
        raise BandEdgesError(edges)
    return edges


def _turns(edge: Decimal) -> str:
    exponent = edge.normalize().as_tuple().exponent
    places = -exponent if isinstance(exponent, int) and exponent < 0 else 0
    return f"{edge:.{max(places, 1)}f}x"


def band_labels(edges: list[Decimal]) -> list[str]:
    e = _checked(edges)
    middle = [f"{_turns(a)} to {_turns(b)}" for a, b in pairwise(e)]
    return [f"Under {_turns(e[0])}", *middle, f"{_turns(e[-1])} and over"]


def band_index(value: Decimal, edges: list[Decimal]) -> int:
    """Bands are closed below and open above, so a value sits past every edge it has reached."""
    index = 0
    for edge in _checked(edges):
        if value >= edge:
            index += 1
    return index


def weighted_average(items: list[tuple[Decimal, Decimal]]) -> Decimal | None:
    with localcontext(CTX):
        weight = sum((w for w, _ in items), Decimal(0))
        if weight == 0:
            return None
        return sum((w * v for w, v in items), Decimal(0)) / weight
