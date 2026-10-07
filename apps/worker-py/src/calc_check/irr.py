"""XIRR per docs/08 section 3, implemented independently of packages/calc."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, localcontext
from math import pow as fpow

from calc_check import CTX
from calc_check.dates import days_between

Flow = tuple[str, Decimal]

LO = Decimal("-0.9999")
HI = Decimal("100")


@dataclass(frozen=True)
class IrrResult:
    value: Decimal | None
    reason: str | None
    short_period: bool


def _sorted(flows: list[Flow]) -> list[Flow]:
    return sorted(flows, key=lambda f: f[0])


def _years(flows: list[Flow], basis: Decimal) -> list[Decimal]:
    first = flows[0][0]
    return [Decimal(days_between(first, d)) / basis for d, _ in flows]


def npv(flows: list[Flow], rate: Decimal, basis: Decimal = Decimal(365)) -> Decimal:
    flows = _sorted(flows)
    if not flows:
        return Decimal(0)
    with localcontext(CTX):
        years = _years(flows, basis)
        ln_base = (Decimal(1) + rate).ln()
        return sum(
            (a * (-(t * ln_base)).exp() for (_, a), t in zip(flows, years, strict=True)),
            Decimal(0),
        )


def _dnpv(flows: list[Flow], years: list[Decimal], rate: Decimal) -> Decimal:
    ln_base = (Decimal(1) + rate).ln()
    return sum(
        (-t * a * (-((t + 1) * ln_base)).exp() for (_, a), t in zip(flows, years, strict=True)),
        Decimal(0),
    )


def _sign_changes(amounts: list[Decimal]) -> int:
    changes = 0
    last = 0
    for a in amounts:
        if a == 0:
            continue
        sign = -1 if a < 0 else 1
        if last != 0 and sign != last:
            changes += 1
        last = sign
    return changes


def _scan(flows: list[Flow], years: list[Decimal]) -> list[tuple[Decimal, Decimal]]:
    """Float scan for sign changes of NPV; brackets are then solved in Decimal."""
    amounts = [float(a) for _, a in flows]
    ts = [float(t) for t in years]

    def f(r: float) -> float:
        return sum(a * fpow(1 + r, -t) for a, t in zip(amounts, ts, strict=True))

    points = [-0.9999 + i * 0.001 for i in range(3001)]
    r = 2.25
    while r <= 100:
        points.append(r)
        r += 0.25
    out: list[tuple[Decimal, Decimal]] = []
    prev_p: float | None = None
    prev_sign = 0
    for p in points:
        v = f(p)
        sign = 0 if v == 0 else (-1 if v < 0 else 1)
        if prev_p is not None and sign != 0 and prev_sign != 0 and sign != prev_sign:
            out.append((Decimal(f"{prev_p:.6f}"), Decimal(f"{p:.6f}")))
        if sign != 0:
            prev_sign = sign
        prev_p = p
    return out


def _bisect(
    flows: list[Flow], years: list[Decimal], lo: Decimal, hi: Decimal, tol: Decimal
) -> Decimal | None:
    def f(r: Decimal) -> Decimal:
        ln_base = (Decimal(1) + r).ln()
        return sum(
            (a * (-(t * ln_base)).exp() for (_, a), t in zip(flows, years, strict=True)),
            Decimal(0),
        )

    flo = f(lo)
    a, b = lo, hi
    for _ in range(400):
        mid = (a + b) / 2
        fm = f(mid)
        if abs(fm) <= tol or abs(b - a) < Decimal("1e-18"):
            return mid
        if (fm < 0) == (flo < 0):
            a, flo = mid, fm
        else:
            b = mid
    return None


def xirr(
    flows: list[Flow],
    *,
    basis: Decimal = Decimal(365),
    guess: Decimal = Decimal("0.1"),
    tol: Decimal = Decimal("1e-10"),
    max_iterations: int = 200,
) -> IrrResult:
    flows = _sorted(flows)
    if len(flows) < 2:
        return IrrResult(None, "insufficient_flows", False)
    short = days_between(flows[0][0], flows[-1][0]) < 365
    amounts = [a for _, a in flows]
    if not any(a < 0 for a in amounts) or not any(a > 0 for a in amounts):
        return IrrResult(None, "same_sign", short)

    with localcontext(CTX):
        years = _years(flows, basis)

        def f(r: Decimal) -> Decimal:
            ln_base = (Decimal(1) + r).ln()
            return sum(
                (a * (-(t * ln_base)).exp() for (_, a), t in zip(flows, years, strict=True)),
                Decimal(0),
            )

        if _sign_changes(amounts) > 1:
            brackets = _scan(flows, years)
            if len(brackets) > 1:
                return IrrResult(None, "multiple_irr", short)
            if not brackets:
                return IrrResult(None, "no_root", short)
            v = _bisect(flows, years, brackets[0][0], brackets[0][1], tol)
            return IrrResult(v, None if v is not None else "no_convergence", short)

        rate = guess
        for _ in range(max_iterations):
            fv = f(rate)
            if abs(fv) <= tol:
                return IrrResult(rate, None, short)
            d = _dnpv(flows, years, rate)
            if d == 0:
                break
            nxt = rate - fv / d
            if nxt <= LO or nxt > HI:
                break
            if abs(nxt - rate) < Decimal("1e-18"):
                rate = nxt
                if abs(f(rate)) <= tol:
                    return IrrResult(rate, None, short)
                break
            rate = nxt

        if (f(LO) < 0) != (f(HI) < 0):
            v = _bisect(flows, years, LO, HI, tol)
            return IrrResult(v, None if v is not None else "no_convergence", short)
        brackets = _scan(flows, years)
        if len(brackets) > 1:
            return IrrResult(None, "multiple_irr", short)
        if not brackets:
            return IrrResult(None, "no_root", short)
        v = _bisect(flows, years, brackets[0][0], brackets[0][1], tol)
        return IrrResult(v, None if v is not None else "no_convergence", short)
