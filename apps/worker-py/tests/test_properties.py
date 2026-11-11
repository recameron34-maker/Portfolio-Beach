from datetime import date, timedelta
from decimal import Decimal
from fractions import Fraction
from typing import cast

from hypothesis import assume, given, settings
from hypothesis import strategies as st

from calc_check import attribution, bridge, credit, multiples
from calc_check.irr import Flow, npv, xirr


@st.composite
def flows(draw: st.DrawFn) -> list[Flow]:
    start = date(2015, 1, 1)
    items = draw(
        st.lists(st.tuples(st.integers(0, 3650), st.integers(1, 5_000_000)), min_size=1, max_size=4)
    )
    out: list[Flow] = [(start.isoformat(), Decimal(-1_000_000))]
    for day, amount in items:
        out.append(((start + timedelta(days=day + 1)).isoformat(), Decimal(amount)))
    return out


@settings(max_examples=40, deadline=None)
@given(flows(), st.integers(2, 1000))
def test_irr_scale_invariant(fs: list[Flow], k: int) -> None:
    a = xirr(fs)
    b = xirr([(d, amt * k) for d, amt in fs])
    if a.value is None or b.value is None:
        assert a.reason == b.reason
        return
    assert abs(a.value - b.value) < Decimal("1e-9")


@settings(max_examples=40, deadline=None)
@given(flows())
def test_npv_at_irr_is_zero(fs: list[Flow]) -> None:
    r = xirr(fs)
    if r.value is not None:
        assert abs(npv(fs, r.value)) <= Decimal("1e-8")


@given(st.integers(1, 1_000_000), st.integers(0, 1_000_000), st.integers(0, 1_000_000))
def test_tvpi_is_dpi_plus_rvpi(pi: int, dist: int, nav: int) -> None:
    t = multiples.tvpi(Decimal(dist), Decimal(nav), Decimal(pi))
    d = multiples.dpi(Decimal(dist), Decimal(pi))
    r = multiples.rvpi(Decimal(nav), Decimal(pi))
    assert t is not None and d is not None and r is not None
    assert abs(t - (d + r)) <= Decimal("1e-22") * max(Decimal(1), t)


@given(st.integers(1, 100_000_000), st.integers(0, 2000))
def test_par_never_falls_on_pik(par: int, bps: int) -> None:
    after = credit.capitalize_pik(Decimal(par), Decimal(bps) / Decimal(10000), "quarterly")
    assert after >= Decimal(par)


@given(st.integers(1, 900_000_000), st.integers(0, 900_000_000), st.integers(0, 99))
def test_value_change_rebuilds_the_current_value(prior: int, current: int, cents: int) -> None:
    now = Decimal(current) + Decimal(cents) / Decimal(100)
    change = multiples.value_change(now, Decimal(prior))
    assert change is not None
    rebuilt = Decimal(prior) * (change + 1)
    assert abs(rebuilt - now) <= (now + Decimal(prior)) * Decimal("1e-25")
    assert (change > 0) == (now > prior)
    assert (change < 0) == (now < prior)


@given(st.integers(0, 1_000_000))
def test_value_change_is_none_without_a_base(current: int) -> None:
    assert multiples.value_change(Decimal(current), Decimal(0)) is None
    assert multiples.value_change(None, Decimal(10)) is None
    assert multiples.value_change(Decimal(current), None) is None


def cents(lo: int, hi: int) -> st.SearchStrategy[Decimal]:
    """Dollars and cents between two whole-dollar bounds."""
    return st.integers(lo * 100, hi * 100).map(lambda c: Decimal(c) / Decimal(100))


@st.composite
def company(draw: st.DrawFn) -> dict[str, Decimal | None]:
    """A company at one date: positive EBITDA, EV of 2 to 40 turns, net cash to 90% net debt."""
    ebitda = draw(cents(100_000, 2_000_000_000))
    ev = (ebitda * draw(st.integers(200, 4000)) / Decimal(100)).quantize(Decimal("0.01"))
    net_debt = (ev * draw(st.integers(-20, 90)) / Decimal(100)).quantize(Decimal("0.01"))
    revenue = (ebitda * draw(st.integers(150, 2000)) / Decimal(100)).quantize(Decimal("0.01"))
    return {"ebitda": ebitda, "ev": ev, "netDebt": net_debt, "revenue": revenue}


DRIVERS = ("ebitdaGrowth", "multipleExpansion", "debtPaydown")


def whole(*parts: Decimal) -> Fraction:
    """The exact sum of decimals, free of any rounding context."""
    return sum((Fraction(p) for p in parts), Fraction(0))


@settings(max_examples=150, deadline=None)
@given(company(), company())
def test_bridge_drivers_sum_exactly_to_the_equity_change(
    entry: dict[str, Decimal | None], current: dict[str, Decimal | None]
) -> None:
    b = bridge.bridge(entry, current)
    assert b is not None
    parts = [cast(Decimal, b[k]) for k in DRIVERS]
    total = cast(Decimal, b["total"])
    assert whole(*parts) == Fraction(total)
    ev0, d0 = cast(Decimal, entry["ev"]), cast(Decimal, entry["netDebt"])
    ev1, d1 = cast(Decimal, current["ev"]), cast(Decimal, current["netDebt"])
    assert Fraction(total) == whole(ev1, -d1, -ev0, d0)
    assert Fraction(parts[2]) == whole(d0, -d1)
    # The remainder given to the multiple is the substitution step itself, to the held places.
    e0, e1 = cast(Decimal, entry["ebitda"]), cast(Decimal, current["ebitda"])
    step = Fraction(e1) * (Fraction(ev1) / Fraction(e1) - Fraction(ev0) / Fraction(e0))
    assert abs(Fraction(parts[1]) - step) <= Fraction(1, 10**20)
    shares = cast(dict[str, Decimal] | None, b["shares"])
    if shares is not None:
        largest = max(abs(Fraction(v)) for v in shares.values())
        assert abs(whole(*shares.values()) - 1) <= Fraction(1, 10**28) * max(largest, Fraction(1))


@settings(max_examples=150, deadline=None)
@given(company(), company())
def test_ebitda_step_is_the_revenue_step_plus_the_margin_step(
    entry: dict[str, Decimal | None], current: dict[str, Decimal | None]
) -> None:
    b = bridge.bridge(entry, current)
    four = attribution.attribution(
        {k: cast(Decimal, v) for k, v in entry.items()},
        {k: cast(Decimal, v) for k, v in current.items()},
    )
    assert b is not None and four is not None
    tol = Fraction(1, 10**12)

    def near(mine: object, *theirs: Decimal) -> bool:
        return abs(Fraction(cast(Decimal, mine)) - whole(*theirs)) <= tol

    assert near(b["ebitdaGrowth"], four["revenueGrowth"], four["marginChange"])
    assert near(b["multipleExpansion"], four["multipleChange"])
    assert near(b["debtPaydown"], four["netDebtChange"])
    assert near(b["revenueGrowth"], four["revenueGrowth"])
    revenue, margin = cast(Decimal, b["revenueGrowth"]), cast(Decimal, b["marginChange"])
    assert whole(revenue, margin) == Fraction(cast(Decimal, b["ebitdaGrowth"]))


@settings(max_examples=150, deadline=None)
@given(company(), company(), cents(-2_000_000_000, 2_000_000_000))
def test_gain_split_sums_exactly_to_the_gain(
    entry: dict[str, Decimal | None], current: dict[str, Decimal | None], gain: Decimal
) -> None:
    b = bridge.bridge(entry, current)
    assert b is not None
    split = bridge.gain_by_driver(
        gain,
        cast(Decimal, b["ebitdaGrowth"]),
        cast(Decimal, b["multipleExpansion"]),
        cast(Decimal, b["total"]),
        cast(Decimal | None, b["revenueGrowth"]),
    )
    if b["total"] == 0:
        assert split is None
        return
    assert split is not None
    parts = [cast(Decimal, split[k]) for k in DRIVERS]
    # Exact while every part stays below ten trillion (docs/08 section 8).
    assume(all(abs(part) < Decimal("1e13") for part in parts))
    assert whole(*parts) == Fraction(gain)
    revenue, margin = cast(Decimal, split["revenueGrowth"]), cast(Decimal, split["marginChange"])
    assert whole(revenue, margin) == Fraction(parts[0])


@given(
    st.lists(st.integers(1, 400), min_size=1, max_size=8, unique=True),
    st.integers(-5000, 50_000),
)
def test_bands_hold_every_value_exactly_once(tenths: list[int], hundredths: int) -> None:
    edges = [Decimal(t) / Decimal(10) for t in sorted(tenths)]
    value = Decimal(hundredths) / Decimal(100)
    index = bridge.band_index(value, edges)
    bounds: list[Decimal | None] = [None, *edges, None]

    def holds(i: int) -> bool:
        lower, upper = bounds[i], bounds[i + 1]
        return (lower is None or lower <= value) and (upper is None or value < upper)

    assert [i for i in range(len(edges) + 1) if holds(i)] == [index]
    labels = bridge.band_labels(edges)
    assert len(labels) == len(edges) + 1 and len(set(labels)) == len(labels)
    for i, edge in enumerate(edges):
        assert bridge.band_index(edge, edges) == i + 1
