from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st

from calc_check import credit, multiples
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
