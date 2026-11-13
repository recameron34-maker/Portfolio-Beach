from datetime import date, timedelta
from decimal import Decimal
from fractions import Fraction
from typing import Any, cast

from hypothesis import assume, given, settings
from hypothesis import strategies as st

from calc_check import attribution, bridge, credit, multiples, rollup
from calc_check import underwriting as uw
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


def split_of(
    b: dict[str, Decimal | dict[str, Decimal] | None], gain: Decimal, invested: Decimal
) -> dict[str, Decimal | None] | str:
    return bridge.gain_by_driver(
        gain,
        invested,
        cast(Decimal, b["equityAtEntry"]),
        cast(Decimal, b["ebitdaGrowth"]),
        cast(Decimal, b["multipleExpansion"]),
        cast(Decimal, b["debtPaydown"]),
        cast(Decimal | None, b["revenueGrowth"]),
    )


@settings(max_examples=150, deadline=None)
@given(company(), company(), cents(1, 2_000_000_000), cents(-2_000_000_000, 2_000_000_000))
def test_gain_parts_with_the_remainder_sum_exactly_to_the_gain(
    entry: dict[str, Decimal | None],
    current: dict[str, Decimal | None],
    invested: Decimal,
    gain: Decimal,
) -> None:
    b = bridge.bridge(entry, current)
    assert b is not None
    equity = cast(Decimal, b["equityAtEntry"])
    split = split_of(b, gain, invested)
    if equity <= 0:
        assert split == "non_positive_entry_equity"
        return
    assert not isinstance(split, str)
    parts = [cast(Decimal, split[k]) for k in DRIVERS]
    other = cast(Decimal, split["other"])
    # Any stake, any gain, any company total (zero included).
    assert whole(*parts, other) == Fraction(gain)
    stake = Fraction(invested) / Fraction(equity)
    for key, part in zip(DRIVERS, parts, strict=True):
        exact = stake * Fraction(cast(Decimal, b[key]))
        assert abs(Fraction(part) - exact) <= Fraction(1, 2 * 10**10)
    revenue, margin = cast(Decimal, split["revenueGrowth"]), cast(Decimal, split["marginChange"])
    assert whole(revenue, margin) == Fraction(parts[0])


@settings(max_examples=150, deadline=None)
@given(
    company(),
    company(),
    cents(1, 20_000_000),
    cents(-2_000_000_000, 2_000_000_000),
    st.integers(2, 100),
)
def test_driver_parts_scale_linearly_with_the_stake(
    entry: dict[str, Decimal | None],
    current: dict[str, Decimal | None],
    invested: Decimal,
    gain: Decimal,
    k: int,
) -> None:
    b = bridge.bridge(entry, current)
    assert b is not None
    assume(cast(Decimal, b["equityAtEntry"]) > 0)
    one = split_of(b, gain, invested)
    many = split_of(b, gain, invested * k)
    assert not isinstance(one, str) and not isinstance(many, str)
    # One rounding at the tenth place on each side: k halves and one more.
    tol = Fraction(k + 1, 2 * 10**10)
    for key in DRIVERS:
        scaled = Fraction(cast(Decimal, one[key])) * k
        assert abs(Fraction(cast(Decimal, many[key])) - scaled) <= tol


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


@st.composite
def rollup_row(draw: st.DrawFn) -> dict[str, Any]:
    """A position row as it travels: our figures, the parts of its gain and its signed flows."""
    invested = draw(cents(1, 60_000_000))
    received = draw(st.one_of(st.none(), cents(1, 80_000_000)))
    nav = draw(st.one_of(st.none(), cents(0, 90_000_000)))
    distributions = received or Decimal(0)
    gain = None if nav is None else distributions + nav - invested
    parts = [draw(cents(-40_000_000, 40_000_000)) for _ in range(3)]
    split = None
    if gain is not None and draw(st.booleans()):
        split = {
            "ebitdaGrowth": str(parts[0]),
            "multipleExpansion": str(parts[1]),
            "debtPaydown": str(parts[2]),
            "other": str(gain - parts[0] - parts[1] - parts[2]),
            "revenueGrowth": None,
            "marginChange": None,
        }
    flows = [{"date": "2020-03-31", "amount": str(-invested)}]
    if received is not None:
        flows.append({"date": "2023-09-30", "amount": str(received)})
    reason = "no_gain" if gain is None else "missing_figures"
    return {
        "isActive": True,
        "invested": str(invested),
        "nav": None if nav is None else str(nav),
        "distributions": str(distributions),
        "gain": None if gain is None else str(gain),
        "gainByDriver": split,
        "gainNotCalculable": None if split is not None else reason,
        "growth": {"ebitdaGrowth": None},
        "flows": flows,
        "entryMultipleBand": "band_0",
        "entryLeverageBand": "band_0",
    }


@settings(max_examples=100, deadline=None)
@given(st.lists(rollup_row(), max_size=8), st.lists(st.booleans(), min_size=8, max_size=8))
def test_rollup_parts_are_the_gain_and_add_over_any_split_of_the_rows(
    rows: list[dict[str, Any]], side: list[bool]
) -> None:
    def total(p: dict[str, Any], key: str) -> Fraction:
        return Fraction(0) if p[key] is None else Fraction(p[key])

    def part(p: dict[str, Any], key: str) -> Fraction:
        return Fraction(0) if p["gainByDriver"] is None else Fraction(p["gainByDriver"][key])

    everything = rollup.portfolio(rows)
    parts = sum((part(everything, k) for k in rollup.PARTS), Fraction(0))
    assert parts == total(everything, "gain")
    assert total(everything, "invested") + parts == total(everything, "totalValue")
    counted = sum(r["count"] for r in everything["notCalculable"])
    assert everything["positions"] + counted == len(rows)
    one = rollup.portfolio([r for r, s in zip(rows, side, strict=False) if s])
    other = rollup.portfolio([r for r, s in zip(rows, side, strict=False) if not s])
    for key in ("invested", "nav", "distributions", "totalValue", "gain"):
        assert total(everything, key) == total(one, key) + total(other, key)
    for key in rollup.PARTS:
        assert part(everything, key) == part(one, key) + part(other, key)


RANK = {"behind": 0, "on_plan": 1, "ahead": 2}


@st.composite
def plan_span(draw: st.DrawFn) -> tuple[list[dict[str, str | None]], str, str, str]:
    """Two plan points with every figure, and a day strictly between them."""
    start = date(2019, 1, 1) + timedelta(days=draw(st.integers(0, 2000)))
    length = draw(st.integers(2, 2000))
    day = start + timedelta(days=draw(st.integers(1, length - 1)))
    end = start + timedelta(days=length)

    def point(on: date) -> dict[str, str | None]:
        return {
            "periodEnd": on.isoformat(),
            "revenueLtm": str(draw(cents(1, 4_000_000_000))),
            "ebitdaLtm": str(draw(cents(1, 900_000_000))),
            "netDebt": str(draw(cents(-200_000_000, 3_000_000_000))),
        }

    return [point(start), point(end)], start.isoformat(), day.isoformat(), end.isoformat()


@given(plan_span(), st.sampled_from(uw.METRICS))
def test_plan_between_two_dates_lies_between_their_figures(
    span: tuple[list[dict[str, str | None]], str, str, str], metric: str
) -> None:
    points, start, day, end = span
    first, _, _ = uw.plan_at(points, metric, start)
    last, _, _ = uw.plan_at(points, metric, end)
    plan, line, reason = uw.plan_at(points, metric, day)
    assert first is not None and last is not None and plan is not None
    assert line and reason is None
    assert min(first, last) <= plan <= max(first, last)
    # Outside the two dates there is no figure, and none is borrowed from the nearest point.
    before = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
    after = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    assert uw.plan_at(points, metric, before) == (None, False, "before_plan_start")
    assert uw.plan_at(points, metric, after) == (None, False, "past_plan_end")


@given(plan_span(), cents(-900_000_000, 1_800_000_000), cents(-900_000_000, 1_800_000_000))
def test_a_higher_ebitda_never_reads_worse_and_a_higher_net_debt_never_better(
    span: tuple[list[dict[str, str | None]], str, str, str], a: Decimal, b: Decimal
) -> None:
    points, _, day, _ = span
    low, high = sorted((a, b))

    def rows(value: Decimal) -> dict[str, Any]:
        quarter: dict[str, str | None] = {
            "periodEnd": day,
            "revenueLtm": None,
            "ebitdaLtm": str(value),
            "netDebt": str(value),
        }
        return {r["metric"]: r for r in uw.plan_metrics(points, quarter, "0.05")}

    lower, higher = rows(low), rows(high)
    assert RANK[higher["ebitda"]["status"]] >= RANK[lower["ebitda"]["status"]]
    assert lower["revenue"]["notCalculable"] == "missing_actual"
    debt_low, debt_high = lower["net_debt"]["status"], higher["net_debt"]["status"]
    assert (debt_low is None) == (debt_high is None)
    if debt_low is not None:
        assert RANK[debt_high] <= RANK[debt_low]
    for row in (*lower.values(), *higher.values()):
        if row["variance"] is not None:
            assert row["variance"] == row["actual"] - row["plan"]
