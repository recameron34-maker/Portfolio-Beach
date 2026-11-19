from datetime import date, timedelta
from decimal import Decimal
from fractions import Fraction
from typing import Any, cast

from hypothesis import assume, given, settings
from hypothesis import strategies as st

from calc_check import attribution, bridge, credit, marks, multiples, rollup
from calc_check import suggestion as sg
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


@given(
    st.integers(min_value=-2_000, max_value=4_000),
    st.integers(min_value=1, max_value=4_000),
)
def test_time_passed_is_never_below_zero(gone: int, whole: int) -> None:
    # docs/08 section 11 rule 4: no time passed for a quarter dated before the entry snapshot.
    entry = date(2020, 1, 1)
    point = {"revenueLtm": None, "ebitdaLtm": "10", "netDebt": "5"}
    exit_day = (entry + timedelta(days=whole)).isoformat()
    case = {
        "form": "equity",
        "plannedExitDate": exit_day,
        "exitMultiple": "10",
        "grossMoic": "2",
        "grossIrr": "0.2",
        "points": [{"periodEnd": entry.isoformat(), **point}, {"periodEnd": exit_day, **point}],
    }
    quarter = {"periodEnd": (entry + timedelta(days=gone)).isoformat(), **point}
    inp = {
        "entry": {"periodEnd": entry.isoformat(), "ev": "100", **point},
        "current": quarter,
        "bridge": None,
        "bridgeNotCalculable": "missing_figures",
    }
    passed = uw.value_creation(case, Fraction(10), inp)["timePassed"]
    if gone < 0:
        assert passed is None
    else:
        assert passed == uw.travels(Fraction(gone, whole))
        assert passed >= 0


def test_a_last_place_difference_is_seen_on_a_figure_of_any_size() -> None:
    # docs/08 section 11: the two implementations agree to the last place, also on a plan figure
    # of hundreds of millions, where a relative tolerance would let ten places slip.
    ours = {"plan": Decimal("445100516.1393063584"), "status": "on_plan"}
    assert uw.differences(ours, {"plan": "445100516.1393063584", "status": "on_plan"}, "row") == []
    assert uw.differences(ours, {"plan": "445100516.13930635840", "status": "on_plan"}, "row") == []
    assert uw.differences(ours, {"plan": "445100516.1393063585", "status": "on_plan"}, "row") == [
        "row.plan: 445100516.1393063584 vs 445100516.1393063585"
    ]
    assert uw.differences(ours, {"plan": "445100516.1393063584", "status": "behind"}, "row") == [
        "row.status: on_plan vs behind"
    ]


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


# ---- Valuation suggestions (docs/08 section 12) ----

HALF_A_CENT = Decimal("0.005")


def stake_input(mark: Decimal, then: Decimal, now: Decimal) -> dict[str, Any]:
    """Rule 12.2's inputs for a company with no net debt at either end."""
    return {
        "referenceMark": str(mark),
        "flowsSinceReferenceMark": False,
        "reference": {"ev": str(then), "netDebt": "0.00"},
        "current": {"ev": str(now), "netDebt": "0.00"},
    }


def statement_value(ending: Decimal, share: Decimal | None) -> Decimal | None:
    lines: dict[str, str | None] = {
        "beginningBalance": None,
        "contributionsInPeriod": None,
        "distributionsInPeriod": None,
        "netGainLoss": None,
        "endingBalance": str(ending),
        "contributionsToDate": None,
        "share": None if share is None else str(share),
    }
    return cast(Decimal | None, sg.statement_mark(lines, "0", "25000", "0.02")["value"])


@settings(max_examples=150, deadline=None)
@given(
    cents(1, 900_000_000),
    st.integers(2, 9),
    cents(1, 900_000_000),
    cents(1, 900_000_000),
)
def test_scaling_the_reference_mark_scales_the_suggested_value_to_the_cent(
    mark: Decimal, k: int, then: Decimal, now: Decimal
) -> None:
    one = sg.stake_mark(stake_input(mark, then, now))["value"]
    many = sg.stake_mark(stake_input(mark * k, then, now))["value"]
    if one is None or many is None:
        # Only a figure under half a cent has no value here.
        assert (one is None) == (mark * now / then < HALF_A_CENT)
        return
    # Each value is within half a cent of the exact figure.
    assert abs(many - one * k) <= HALF_A_CENT * (k + 1)


@settings(max_examples=150, deadline=None)
@given(
    cents(1, 900_000_000),
    cents(1, 900_000_000),
    cents(-200_000_000, 900_000_000),
    cents(-200_000_000, 900_000_000),
)
def test_an_unchanged_equity_value_gives_back_the_reference_mark(
    mark: Decimal, equity: Decimal, debt_then: Decimal, debt_now: Decimal
) -> None:
    answer = sg.stake_mark(
        {
            "referenceMark": str(mark),
            "flowsSinceReferenceMark": False,
            "reference": {"ev": str(equity + debt_then), "netDebt": str(debt_then)},
            "current": {"ev": str(equity + debt_now), "netDebt": str(debt_now)},
        }
    )
    assert answer["reason"] is None
    assert answer["value"] == mark
    assert answer["referenceEquity"] == answer["equity"] == equity


@settings(max_examples=150, deadline=None)
@given(cents(1, 900_000_000), st.integers(1, 2500), st.integers(2, 4))
def test_a_statement_value_is_linear_in_our_share_to_the_cent(
    ending: Decimal, ten_thousandths: int, k: int
) -> None:
    share = Decimal(ten_thousandths) / Decimal(10_000)
    one = statement_value(ending, share)
    many = statement_value(ending, share * k)
    assert statement_value(ending, Decimal(1)) == ending == statement_value(ending, None)
    if one is None or many is None:
        assert (one is None) == (ending * share < HALF_A_CENT)
        return
    assert abs(many - one * k) <= HALF_A_CENT * (k + 1)
    assert many <= ending


@settings(max_examples=150, deadline=None)
@given(
    cents(1, 900_000_000),
    st.integers(1, 900_000_000),
    st.integers(4, 20),
    cents(-200_000_000, 900_000_000),
    st.integers(1, 900_000_000),
    cents(-200_000_000, 900_000_000),
)
def test_the_multiple_held_is_rule_12_2_at_the_enterprise_value_it_implies(
    mark: Decimal,
    ebitda_then: int,
    multiple: int,
    debt_then: Decimal,
    ebitda_now: int,
    debt_now: Decimal,
) -> None:
    # A whole multiple, so the enterprise value it gives is exact and rule 12.2 can be asked.
    then = {"ev": f"{ebitda_then * multiple}.00", "netDebt": str(debt_then)}
    by_multiple = sg.held_multiple_mark(
        {
            "referenceMark": str(mark),
            "flowsSinceReferenceMark": False,
            "reference": {**then, "ebitda": f"{ebitda_then}.00"},
            "current": {"ebitda": f"{ebitda_now}.00", "netDebt": str(debt_now)},
        }
    )
    by_value = sg.stake_mark(
        {
            "referenceMark": str(mark),
            "flowsSinceReferenceMark": False,
            "reference": then,
            "current": {"ev": f"{ebitda_now * multiple}.00", "netDebt": str(debt_now)},
        }
    )
    assert by_multiple["value"] == by_value["value"]
    assert by_multiple["reason"] == by_value["reason"]
    assert (by_multiple["value"] is None) == (by_multiple["reason"] is not None)


@settings(max_examples=150, deadline=None)
@given(
    cents(1, 900_000_000),
    cents(1, 900_000_000),
    st.booleans(),
    cents(0, 90_000_000),
    cents(0, 90_000_000),
)
def test_the_mark_plus_the_change_is_the_value_and_the_net_of_flows_follows_from_it(
    suggested: Decimal, current: Decimal, previous: bool, paid_in: Decimal, paid_out: Decimal
) -> None:
    answer = sg.mark_comparison(
        {
            "suggested": str(suggested),
            "current": str(current),
            "currentIsPreviousQuarter": previous,
            "statement": {
                "beginningBalance": str(current),
                "contributionsInPeriod": str(paid_in),
                "distributionsInPeriod": str(paid_out),
                "tieToleranceUsd": "0",
            },
        },
        "0.1",
    )
    assert current + answer["change"] == suggested
    assert answer["variance"] is (previous and abs(answer["changePct"]) >= Decimal("0.1"))
    if previous:
        assert answer["netOfFlows"] == answer["change"] - paid_in + paid_out
    else:
        assert answer["netOfFlows"] is None and answer["netOfFlowsPct"] is None
    crossed = sg.cross_check(str(suggested), str(current), "0.1")
    assert crossed["difference"] == answer["change"]
    assert crossed["differencePct"] == answer["changePct"]


# ---- Which marks and flows count for a suggestion's quarter (docs/08 section 12) ----

QUARTER_ENDS = st.builds(
    lambda year, month: (
        date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)
    ).isoformat(),
    st.integers(2015, 2030),
    st.sampled_from([3, 6, 9, 12]),
)
MARK_STATES = st.sampled_from(["Locked", "Locked", "Draft", "Reopened", "OpsPrepared"])


def shifted(iso: str, days: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()


@st.composite
def marks_near(draw: st.DrawFn, quarter_end: str) -> list[dict[str, Any]]:
    days = draw(st.lists(st.integers(-800, 120), max_size=6))
    return [
        {"id": f"m{n}", "periodEnd": shifted(quarter_end, d), "state": draw(MARK_STATES)}
        for n, d in enumerate(days)
    ]


@settings(max_examples=120, deadline=None)
@given(QUARTER_ENDS, st.integers(0, 40), st.integers(0, 40))
def test_a_date_within_the_tolerance_of_a_quarter_end_reports_for_it(
    quarter_end: str, tolerance: int, away: int
) -> None:
    assert marks.aligned_quarter_end(quarter_end, tolerance) == quarter_end
    for d in (shifted(quarter_end, away), shifted(quarter_end, -away)):
        # Forty days is nearer this quarter end than any other, so the tolerance alone decides.
        expected = quarter_end if away <= tolerance else d
        assert marks.aligned_quarter_end(d, tolerance) == expected


@settings(max_examples=120, deadline=None)
@given(st.data(), QUARTER_ENDS, st.integers(0, 10))
def test_the_reference_is_a_locked_mark_of_an_earlier_date_and_none_is_later(
    data: st.DataObject, quarter_end: str, tolerance: int
) -> None:
    rows = data.draw(marks_near(quarter_end))
    found = marks.latest_locked_before(rows, quarter_end, tolerance)
    earlier = [
        m
        for m in rows
        if m["state"] == "Locked"
        and marks.aligned_quarter_end(m["periodEnd"], tolerance) < quarter_end
    ]
    if found is None:
        assert earlier == []
        return
    assert found["mark"] in earlier
    assert all(m["periodEnd"] <= found["mark"]["periodEnd"] for m in earlier)
    assert found["ageQuarters"] >= 0
    # The previous quarter's mark is exactly one quarter old and reports for a quarter end.
    assert found["previousQuarter"] is (
        found["ageQuarters"] == 1 and marks.is_quarter_end(found["reportsFor"])
    )
    # A quarter that is marked is so by a Locked mark that is not an earlier one.
    later = [m for m in rows if m["state"] == "Locked" and m not in earlier]
    assert marks.locked_for_or_after(rows, quarter_end, tolerance) is (later != [])


@settings(max_examples=120, deadline=None)
@given(
    QUARTER_ENDS,
    st.lists(st.integers(-400, 400), max_size=5),
    st.integers(0, 300),
    st.integers(0, 300),
)
def test_a_window_of_flows_splits_into_two_that_share_no_date(
    quarter_end: str, days: list[int], first: int, second: int
) -> None:
    rows = [{"date": shifted(quarter_end, d)} for d in days]
    start = shifted(quarter_end, -first - second)
    middle = shifted(quarter_end, -second)
    whole = marks.has_flow_between(rows, start, quarter_end)
    assert whole is (
        marks.has_flow_between(rows, start, middle)
        or marks.has_flow_between(rows, middle, quarter_end)
    )
    assert marks.has_flow_between(rows, quarter_end, quarter_end) is False


@settings(max_examples=80, deadline=None)
@given(QUARTER_ENDS, st.integers(1, 40))
def test_quarters_count_back_one_at_a_time(quarter_end: str, steps: int) -> None:
    earlier = quarter_end
    for _ in range(steps):
        earlier = marks.previous_quarter_end(earlier)
    assert marks.quarters_between(earlier, quarter_end) == steps
    assert marks.quarters_between(quarter_end, earlier) == -steps
