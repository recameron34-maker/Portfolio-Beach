"""Runs the shared golden fixtures in packages/calc/fixtures against this implementation."""

from __future__ import annotations

import json
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from calc_check import attribution as attr
from calc_check import credit, liquidity, multiples, operating, periods, pme, rollforward, units
from calc_check.irr import Flow, xirr
from calc_check.periods import PeriodRow

FIXTURES_DIR = Path(__file__).resolve().parents[4] / "packages" / "calc" / "fixtures"


def load_fixtures() -> list[dict[str, Any]]:
    return [
        cast(dict[str, Any], json.loads(p.read_text())) for p in sorted(FIXTURES_DIR.glob("*.json"))
    ]


def flows_of(raw: list[dict[str, str]]) -> list[Flow]:
    return [(f["date"], Decimal(f["amount"])) for f in raw]


class MismatchError(AssertionError):
    pass


def close(actual: Decimal | None, expected: str | None, tol: str, label: str) -> None:
    if expected is None:
        if actual is not None:
            raise MismatchError(f"{label}: expected null, got {actual}")
        return
    if actual is None:
        raise MismatchError(f"{label}: expected {expected}, got null")
    if abs(actual - Decimal(expected)) > Decimal(tol):
        raise MismatchError(f"{label}: expected {expected}, got {actual}")


def run_fixture(fx: dict[str, Any]) -> None:
    fn = fx["function"]
    inp = fx["input"]
    exp = fx["expected"]
    tol = fx["tolerance"]
    handler = HANDLERS.get(fn)
    if handler is None:
        raise MismatchError(f"{fx['id']}: unknown function {fn}")
    handler(inp, exp, tol)


def _xirr(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    r = xirr(flows_of(inp["flows"]))
    close(r.value, exp["value"], tol, "irr")
    assert r.reason == exp["reason"], (r.reason, exp["reason"])
    assert r.short_period == exp["shortPeriod"]


def _xirr_and_unfunded(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    r = xirr(flows_of(inp["flows"]))
    close(r.value, exp["irr"], tol, "irr")
    assert r.reason == exp["reason"]
    u = multiples.unfunded(
        Decimal(inp["commitment"]),
        Decimal(inp["contributions"]),
        Decimal(inp["recallableDistributions"]),
    )
    close(u, exp["unfunded"], tol, "unfunded")


def _value_change(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for c, e in zip(inp["cases"], exp["results"], strict=True):
        current = None if c["current"] is None else Decimal(c["current"])
        prior = None if c["prior"] is None else Decimal(c["prior"])
        close(multiples.value_change(current, prior), e, tol, "valueChange")


def _operating(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for c, e in zip(inp["cases"], exp["results"], strict=True):
        ev, nd, eb, rv = (Decimal(c[k]) for k in ("ev", "netDebt", "ebitda", "revenue"))
        close(operating.ev_to_ebitda(ev, eb), e["evToEbitda"], tol, "evToEbitda")
        close(operating.net_debt_to_ebitda(nd, eb), e["netDebtToEbitda"], tol, "netDebtToEbitda")
        close(operating.ebitda_margin(eb, rv), e["ebitdaMargin"], tol, "ebitdaMargin")


def _prior_year(inp: dict[str, Any], exp: dict[str, Any], _tol: str) -> None:
    for c, e in zip(inp["cases"], exp["results"], strict=True):
        rows: list[PeriodRow] = [
            {"periodEnd": r["periodEnd"], "status": "approved", "isEntrySnapshot": False}
            for r in c["rows"]
        ]
        found = periods.same_quarter_prior_year(rows, c["target"], inp["toleranceDays"])
        assert (found["periodEnd"] if found else None) == e, (found, e)


def _latest(inp: dict[str, Any], exp: dict[str, Any], _tol: str) -> None:
    rows = cast(list[PeriodRow], inp["rows"])
    latest = periods.latest_period(rows, inp["reportingDate"])
    assert latest is not None and latest["periodEnd"] == exp["periodEnd"]
    snap = periods.entry_snapshot(rows)
    assert snap is not None and snap["periodEnd"] == exp["entrySnapshotPeriodEnd"]


def _units(inp: dict[str, Any], exp: dict[str, Any], _tol: str) -> None:
    for c, e in zip(inp["cases"], exp["results"], strict=True):
        if e.startswith("THROWS:"):
            try:
                units.to_dollars(Decimal(c["value"]), c["unit"])
            except units.UnknownUnitError as err:
                assert err.code == e.split(":", 1)[1]
            else:
                raise MismatchError(f"expected {c['unit']} to throw")
        else:
            assert units.to_dollars(Decimal(c["value"]), c["unit"]) == Decimal(e)


def _roll(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for c, e in zip(inp["cases"], exp["results"], strict=True):
        passed, diff = rollforward.nav_roll_forward(
            Decimal(c["beginNav"]),
            Decimal(c["contributions"]),
            Decimal(c["distributions"]),
            Decimal(c["gainLoss"]),
            Decimal(c["endNav"]),
            Decimal(inp["toleranceUsd"]),
        )
        assert passed == e["passed"]
        close(diff, e["difference"], tol, "difference")


def _pme(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    flows = flows_of(inp["flows"])
    index = [(p["date"], Decimal(p["level"])) for p in inp["index"]]
    nav, nav_date = Decimal(inp["nav"]), inp["navDate"]
    close(pme.ks_pme(flows, nav, nav_date, index), exp["ksPme"], tol, "ksPme")
    alpha, irr = pme.direct_alpha(flows, nav, nav_date, index)
    close(alpha, exp["directAlpha"], tol, "directAlpha")
    close(irr.value, exp["adjustedIrr"], tol, "adjustedIrr")
    close(xirr([*flows, (nav_date, nav)]).value, exp["plainIrr"], tol, "plainIrr")


def _attribution(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    def pt(d: dict[str, str]) -> dict[str, Decimal]:
        return {k: Decimal(v) for k, v in d.items()}

    r = attr.attribution(pt(inp["entry"]), pt(inp["current"]))
    assert r is not None
    for key in (
        "equityAtEntry",
        "equityCurrent",
        "revenueGrowth",
        "marginChange",
        "multipleChange",
        "netDebtChange",
        "total",
    ):
        close(r[key], exp[key], tol, key)
    assert (
        r["revenueGrowth"] + r["marginChange"] + r["multipleChange"] + r["netDebtChange"]
        == r["total"]
    )
    nc = inp["nullCase"]
    assert attr.attribution(pt(nc["entry"]), pt(nc["current"])) is exp["nullCase"]


def _credit_yield(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    t = inp["terms"]
    close(
        credit.all_in_coupon(Decimal(t["baseRate"]), Decimal(t["floor"]), Decimal(t["spread"])),
        exp["allInCoupon"],
        tol,
        "allInCoupon",
    )
    f = inp["floorCase"]
    close(
        credit.all_in_coupon(Decimal(f["baseRate"]), Decimal(f["floor"]), Decimal(f["spread"])),
        exp["allInCouponFloored"],
        tol,
        "allInCouponFloored",
    )
    y = inp["ytm"]
    close(
        credit.current_yield(Decimal(y["cashCoupon"]), Decimal(y["par"]), Decimal(y["fairValue"])),
        exp["currentYield"],
        tol,
        "currentYield",
    )
    value, _irr, flows, par = credit.yield_to_maturity(
        y["asOf"],
        Decimal(y["fairValue"]),
        Decimal(y["par"]),
        Decimal(y["cashCoupon"]),
        Decimal(y.get("pikCoupon", "0")),
        y["maturity"],
        y["frequency"],
    )
    close(value, exp["ytm"], tol, "ytm")
    close(par, exp["parAtMaturity"], tol, "parAtMaturity")
    assert len(flows) == exp["flowCount"]


def _pik(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    par = Decimal(inp["par"])
    for _ in range(inp["quarters"]):
        par = credit.capitalize_pik(par, Decimal(inp["pikCoupon"]), inp["frequency"])
    close(par, exp["parAfter"], tol, "parAfter")
    close(
        credit.cash_on_cash(Decimal(inp["cashInterestReceived"]), Decimal(inp["averageFunded"])),
        exp["cashOnCash"],
        tol,
        "cashOnCash",
    )
    rf = inp["rollForward"]
    passed, _ = credit.par_roll_forward(
        Decimal(rf["beginPar"]),
        Decimal(rf["fundings"]),
        Decimal(rf["pikCapitalized"]),
        Decimal(rf["principalRepaid"]),
        Decimal(rf["endPar"]),
    )
    assert passed == exp["rollForwardPassed"]


def _credit_ratios(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for c, e in zip(inp["cases"], exp["results"], strict=True):
        d = {k: Decimal(v) for k, v in c.items()}
        close(
            credit.interest_coverage(d["ebitda"], d["cashInterest"]),
            e["interestCoverage"],
            tol,
            "coverage",
        )
        close(
            credit.leverage_through_tranche(d["netDebtThroughTranche"], d["ebitda"]),
            e["leverageThroughTranche"],
            tol,
            "leverage",
        )
        close(credit.loan_to_value(d["netDebtThroughTranche"], d["ev"]), e["ltv"], tol, "ltv")
        close(
            credit.dscr(
                d["ebitda"],
                d["cashTaxes"],
                d["maintenanceCapex"],
                d["cashInterest"],
                d["scheduledPrincipal"],
            ),
            e["dscr"],
            tol,
            "dscr",
        )


def _ta(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    rows = liquidity.takahashi_alexander(
        Decimal(inp["commitment"]),
        Decimal(inp["rateOfContribution"]),
        inp["life"],
        Decimal(inp["bow"]),
        Decimal(inp["growth"]),
        Decimal(inp["yield"]),
        inp["years"],
    )
    assert len(rows) == len(exp["rows"])
    for r, e in zip(rows, exp["rows"], strict=True):
        assert r["year"] == e["year"]
        for key in ("contribution", "distribution", "nav", "unfunded"):
            close(cast(Decimal, r[key]), e[key], tol, key)


HANDLERS: dict[str, Callable[[dict[str, Any], dict[str, Any], str], None]] = {
    "xirr": _xirr,
    "xirr_and_unfunded": _xirr_and_unfunded,
    "value_change": _value_change,
    "operating_ratios": _operating,
    "same_quarter_prior_year": _prior_year,
    "latest_period": _latest,
    "to_dollars": _units,
    "nav_roll_forward": _roll,
    "pme": _pme,
    "attribution": _attribution,
    "credit_yield": _credit_yield,
    "pik_roll": _pik,
    "credit_ratios": _credit_ratios,
    "takahashi_alexander": _ta,
}
