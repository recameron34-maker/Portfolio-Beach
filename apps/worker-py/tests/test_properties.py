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


@st.composite
def held_position(draw: st.DrawFn) -> dict[str, Any]:
    """Our flows on a position: a first funding, follow-ons and money back, read some days on."""
    funded = date(2015, 1, 1) + timedelta(days=draw(st.integers(0, 2500)))
    first = draw(cents(100_000, 60_000_000))
    paid: list[dict[str, str]] = [{"date": funded.isoformat(), "amount": str(-first)}]
    invested, distributions, last = first, Decimal(0), 0
    later = st.tuples(st.integers(1, 2400), st.booleans(), cents(1, 30_000_000))
    for day, follow_on, amount in draw(st.lists(later, max_size=5)):
        last = max(last, day)
        if follow_on:
            invested += amount
        else:
            distributions += amount
        on = (funded + timedelta(days=day)).isoformat()
        paid.append({"date": on, "amount": str(-amount if follow_on else amount)})
    return {
        "asOf": (funded + timedelta(days=last + draw(st.integers(0, 400)))).isoformat(),
        "flows": paid,
        "invested": str(invested),
        "distributions": str(distributions),
    }


def loan_against(position: dict[str, Any], rate: Decimal) -> dict[str, Any]:
    """A loan underwritten at a rate whose planned repayment is the day the position is read."""
    return {
        "form": "credit",
        "plannedExitDate": position["asOf"],
        "exitMultiple": None,
        "grossMoic": "1.5",
        "grossIrr": str(rate),
        "points": [],
    }


def returns_of(
    position: dict[str, Any], rate: Decimal, nav: Decimal, irr: Decimal | None
) -> dict[str, Any]:
    moic = (Fraction(position["distributions"]) + Fraction(nav)) / Fraction(position["invested"])
    inp = {
        **position,
        "isActive": True,
        "grossMoic": str(uw.travels(moic)),
        "grossIrr": None if irr is None else str(irr),
        "irrFlag": None,
    }
    return uw.returns(loan_against(position, rate), inp, Fraction(2, 100))


@settings(max_examples=150, deadline=None)
@given(held_position(), st.integers(-3000, 6000))
def test_a_nav_on_the_path_earns_the_underwritten_rate_and_closes_the_moic_gap(
    position: dict[str, Any], bp: int
) -> None:
    rate = Decimal(bp) / Decimal(10000)
    nav = uw.path_value(position["flows"], rate, position["asOf"])
    # With the path value as the terminal value, the flows are worth nothing at the rate: it is
    # their IRR. The value is held to ten places, and discounting can grow that last place.
    closed: list[Flow] = [(f["date"], Decimal(f["amount"])) for f in position["flows"]]
    closed.append((position["asOf"], nav))
    assert abs(npv(closed, rate)) <= Decimal("1e-7")
    answer = returns_of(position, rate, nav, None)
    assert answer["pathNotCalculable"] is None
    assert answer["moicOnPath"] == answer["grossMoic"]
    assert answer["moicGap"] == 0


@settings(max_examples=150, deadline=None)
@given(
    held_position(),
    st.integers(-3000, 6000),
    st.tuples(cents(0, 90_000_000), cents(0, 90_000_000)),
    st.tuples(st.integers(-9000, 30000), st.integers(-9000, 30000)),
)
def test_a_higher_nav_never_lowers_the_moic_gap_nor_a_higher_irr_its_status(
    position: dict[str, Any], bp: int, navs: tuple[Decimal, Decimal], irrs: tuple[int, int]
) -> None:
    rate = Decimal(bp) / Decimal(10000)
    low_irr, high_irr = (Decimal(i) / Decimal(10000) for i in sorted(irrs))
    lower = returns_of(position, rate, min(navs), low_irr)
    higher = returns_of(position, rate, max(navs), high_irr)
    assert higher["moicGap"] >= lower["moicGap"]
    assert RANK[higher["irrStatus"]] >= RANK[lower["irrStatus"]]
    # The gap is the IRR received less the underwritten one, in points, and the path is one path.
    assert higher["irrGap"] == high_irr - rate
    assert higher["moicOnPath"] == lower["moicOnPath"]
    # After the planned repayment there is no path to stand on, whatever the mark.
    late = {**position, "asOf": (date.fromisoformat(position["asOf"]) + timedelta(1)).isoformat()}
    case = loan_against(position, rate)
    inp = {**late, "isActive": True, "grossMoic": "1.2", "grossIrr": None, "irrFlag": None}
    assert uw.returns(case, inp, Fraction(2, 100))["pathNotCalculable"] == "past_plan_end"


@settings(max_examples=150, deadline=None)
@given(
    company(),
    company(),
    st.integers(300, 2500),
    st.tuples(*(cents(-900_000_000, 900_000_000) for _ in DRIVERS)),
)
def test_planned_bridge_adds_up_to_the_planned_equity_change(
    entry: dict[str, Decimal | None],
    at_exit: dict[str, Decimal | None],
    turns: int,
    earned: tuple[Decimal, ...],
) -> None:
    multiple = Fraction(turns, 100)
    case = {
        "plannedExitDate": "2026-06-30",
        "points": [
            {
                "periodEnd": "2026-06-30",
                "revenueLtm": None,
                "ebitdaLtm": str(at_exit["ebitda"]),
                "netDebt": str(at_exit["netDebt"]),
            }
        ],
    }
    actual = dict(zip(DRIVERS, earned, strict=True)) | {"total": sum(earned, Decimal(0))}
    inp = {
        "entry": {
            "periodEnd": "2021-06-30",
            "ebitdaLtm": str(entry["ebitda"]),
            "ev": str(entry["ev"]),
            "netDebt": str(entry["netDebt"]),
        },
        "current": {"periodEnd": "2024-06-30"},
        "bridge": {key: str(value) for key, value in actual.items()},
        "bridgeNotCalculable": None,
    }
    answer = uw.value_creation(case, multiple, inp)
    planned = answer["planned"]
    assert planned is not None and answer["notCalculable"] is None
    # The planned total is the planned change in equity value: exit EV less exit net debt, less
    # the same at entry. The three drivers are that total, within the last place each is held to.
    assert entry["ev"] is not None and entry["netDebt"] is not None
    assert at_exit["ebitda"] is not None and at_exit["netDebt"] is not None
    change = (
        multiple * Fraction(at_exit["ebitda"])
        - Fraction(at_exit["netDebt"])
        - (Fraction(entry["ev"]) - Fraction(entry["netDebt"]))
    )
    assert planned["total"] == uw.travels(change)
    assert abs(whole(*(planned[key] for key in DRIVERS)) - change) <= Fraction(2, 10**10)
    for key in uw.DRIVERS:
        share = answer["progress"][key]
        if planned[key] <= 0:
            assert share is None
        else:
            # Progress times the planned figure gives back what was earned, to the last place.
            rebuilt = Fraction(share) * Fraction(planned[key])
            assert abs(rebuilt - Fraction(actual[key])) <= Fraction(planned[key]) / 10**10
    assert answer["actual"] == actual
    assert answer["timePassed"] == uw.travels(Fraction(1096, 1826))


@settings(max_examples=150, deadline=None)
@given(
    st.lists(st.integers(0, 60), unique=True, max_size=6),
    st.lists(st.integers(0, 60), unique=True, max_size=8),
    st.one_of(st.none(), st.integers(0, 60)),
)
def test_series_holds_each_plan_date_and_each_quarter_so_far_once_and_in_order(
    plan_months: list[int], quarter_months: list[int], current_month: int | None
) -> None:
    def day(month: int) -> str:
        return (date(2021, 6, 30) + timedelta(days=30 * month)).isoformat()

    def figures(month: int, revenue: int | None) -> dict[str, str | None]:
        return {
            "periodEnd": day(month),
            "revenueLtm": None if revenue is None else f"{revenue + month}000000.00",
            "ebitdaLtm": f"{40 + month}000000.00",
            "netDebt": None,
        }

    points = [figures(m, 200) for m in plan_months]
    quarters = [figures(m, 190) for m in quarter_months]
    current = None if current_month is None else figures(current_month, None)
    # Without a current quarter no quarter counts; with one, those dated before it and itself.
    counted: dict[str, dict[str, str | None]] = {}
    if current is not None and current_month is not None:
        counted = {day(m): figures(m, 190) for m in quarter_months if m < current_month}
        counted[day(current_month)] = current
    want = sorted({day(m) for m in plan_months} | set(counted))
    out = uw.series(points, quarters, current)
    assert [s["metric"] for s in out] == list(uw.METRICS)
    for one in out:
        metric = str(one["metric"])
        column = {"ebitda": "ebitdaLtm", "revenue": "revenueLtm", "net_debt": "netDebt"}[metric]
        assert [row["periodEnd"] for row in one["points"]] == want
        for row in one["points"]:
            # An actual is a quarter's own figure or nothing: it is never read off a line.
            quarter = counted.get(row["periodEnd"])
            own = None if quarter is None else quarter[column]
            assert row["actual"] == (None if own is None else Decimal(own))
            plan, line, _ = uw.plan_at(points, metric, row["periodEnd"])
            assert row["plan"] == (None if plan is None else uw.travels(plan))
            assert row["interpolated"] is line
            if metric == "net_debt":
                assert row["plan"] is None and row["actual"] is None
