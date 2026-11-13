"""Runs the shared golden fixtures in packages/calc/fixtures against this implementation."""

from __future__ import annotations

import json
from collections.abc import Callable
from decimal import Decimal
from fractions import Fraction
from functools import partial
from pathlib import Path
from typing import Any, cast

from calc_check import attribution as attr
from calc_check import bridge as vc
from calc_check import (
    credit,
    fit,
    liquidity,
    multiples,
    operating,
    periods,
    pme,
    rollforward,
    rollup,
    units,
)
from calc_check import underwriting as uw
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


def _point(raw: dict[str, str | None]) -> dict[str, Decimal | None]:
    return {k: None if v is None else Decimal(v) for k, v in raw.items()}


BRIDGE_KEYS = (
    "equityAtEntry",
    "equityCurrent",
    "ebitdaGrowth",
    "multipleExpansion",
    "debtPaydown",
    "total",
    "revenueGrowth",
    "marginChange",
)
DRIVER_KEYS = ("ebitdaGrowth", "multipleExpansion", "debtPaydown")


def _bridge(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for c, e in zip(inp["cases"], exp["results"], strict=True):
        r = vc.bridge(_point(c["entry"]), _point(c["current"]))
        if e["reason"] is not None:
            assert e["reason"] == "non_positive_ebitda" and r is None, (e, r)
            continue
        assert r is not None
        for key in BRIDGE_KEYS:
            close(cast(Decimal | None, r[key]), e[key], tol, key)
        parts = [cast(Decimal, r[key]) for key in DRIVER_KEYS]
        assert parts[0] + parts[1] + parts[2] == r["total"], "the drivers are not the total"
        shares = cast(dict[str, Decimal] | None, r["shares"])
        if e["shares"] is None:
            assert shares is None
        else:
            assert shares is not None
            for key in DRIVER_KEYS:
                close(shares[key], e["shares"][key], tol, f"share {key}")


def _since_entry(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for c, e in zip(inp["cases"], exp["results"], strict=True):
        measures = vc.since_entry(_point(c["entry"]), _point(c["current"]))
        assert set(measures) == set(e)
        for key, want in e.items():
            close(measures[key], want, tol, key)


def _gain(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for c, e in zip(inp["cases"], exp["results"], strict=True):
        points = inp["bridges"][c["bridge"]]
        b = vc.bridge(_point(points["entry"]), _point(points["current"]))
        assert b is not None
        invested = Decimal(c["invested"])
        gain = vc.total_gain(Decimal(c["distributions"]), Decimal(c["nav"]), invested)
        close(gain, e["gain"], tol, "gain")
        equity = cast(Decimal, b["equityAtEntry"])
        split = vc.gain_by_driver(
            gain,
            invested,
            equity,
            cast(Decimal, b["ebitdaGrowth"]),
            cast(Decimal, b["multipleExpansion"]),
            cast(Decimal, b["debtPaydown"]),
            cast(Decimal | None, b["revenueGrowth"]),
        )
        if "split" in e:
            assert split == e["reason"], (split, e["reason"])
            continue
        assert not isinstance(split, str) and gain is not None
        for key in ("stake", *DRIVER_KEYS, "other", "revenueGrowth", "marginChange"):
            close(split[key], e[key], tol, key)
        close(vc.entry_stake(invested, equity), e["stake"], tol, "entry stake")
        parts = [Fraction(cast(Decimal, split[key])) for key in (*DRIVER_KEYS, "other")]
        assert sum(parts, Fraction(0)) == Fraction(gain), "the parts are not the gain"


def _rollup(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    bands = {
        name: rollup.cohort_bands(edges, vc.band_labels(edges))
        for name, edges in (
            ("byEntryMultiple", [Decimal(e) for e in inp["edges"]["multiple"]]),
            ("byEntryLeverage", [Decimal(e) for e in inp["edges"]["leverage"]]),
        )
    }
    for ids, want in zip(inp["cases"], exp["results"], strict=True):
        rows = [p for p in inp["positions"] if p["id"] in ids]
        assert len(rows) == len(ids)
        found = rollup.differences(rollup.rollup(rows, bands, inp["asOf"]), want, Decimal(tol))
        if found:
            raise MismatchError("; ".join(found))


def _refused(run: Callable[[], object], code: str, what: str) -> None:
    try:
        run()
    except vc.BandEdgesError as err:
        assert err.code == code
    else:
        raise MismatchError(f"expected {what} to be refused")


def _bands(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for band_set, e in zip(inp["bandSets"], exp["bandSets"], strict=True):
        edges = [Decimal(x) for x in band_set["edges"]]
        if isinstance(e, str):
            code = e.split(":", 1)[1]
            _refused(partial(vc.band_labels, edges), code, f"edges {band_set['edges']}")
            _refused(partial(vc.band_index, Decimal(9), edges), code, f"edges {band_set['edges']}")
            continue
        assert vc.band_labels(edges) == e["labels"]
        assert [vc.band_index(Decimal(v), edges) for v in band_set["values"]] == e["indexes"]
    for items, want in zip(inp["weightedAverages"], exp["weightedAverages"], strict=True):
        pairs = [(Decimal(i["weight"]), Decimal(i["value"])) for i in items]
        close(vc.weighted_average(pairs), want, tol, "weightedAverage")


def _deal_fit(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for case, want in zip(inp["cases"], exp["cases"], strict=True):
        scores = fit.deal_fit(case, inp["thresholds"])
        assert tuple(scores) == fit.MEASURES
        for key in fit.MEASURES:
            close(scores[key], want[key], tol, key)
    for values, want in zip(inp["medians"], exp["medians"], strict=True):
        close(fit.median([Decimal(v) for v in values]), want, tol, "median")


def _plan_tracking(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for n, (case, want) in enumerate(zip(inp["cases"], exp["results"], strict=True), start=1):
        rows = uw.plan_metrics(inp["plans"][case["plan"]], case["quarter"], inp["onPlanTolerance"])
        assert [r["metric"] for r in rows] == list(uw.METRICS)
        found = uw.differences(rows, want["metrics"], f"case {n}")
        if found:
            raise MismatchError("; ".join(found))
        assert uw.headline(rows) == want["headline"], (n, uw.headline(rows), want["headline"])


def _underwriting(inp: dict[str, Any], exp: dict[str, Any], tol: str) -> None:
    for n, (case, want) in enumerate(zip(inp["cases"], exp["results"], strict=True), start=1):
        answer = uw.comparison(case["case"], case["inputs"], inp["tolerances"])
        found = uw.differences(answer, want, f"case {n}")
        if found:
            raise MismatchError("; ".join(found))


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
    "value_creation_bridge": _bridge,
    "since_entry_measures": _since_entry,
    "gain_by_driver": _gain,
    "value_creation_rollup": _rollup,
    "entry_bands": _bands,
    "deal_fit": _deal_fit,
    "plan_tracking": _plan_tracking,
    "underwriting_comparison": _underwriting,
    "credit_yield": _credit_yield,
    "pik_roll": _pik,
    "credit_ratios": _credit_ratios,
    "takahashi_alexander": _ta,
}
