"""Compares results produced by packages/calc (TypeScript) with this implementation.

Usage: python -m calc_check.cross_check <cases.json>
The cases file is written by `node packages/calc/dist/cross-check/generate.js`.
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal, localcontext
from fractions import Fraction
from pathlib import Path
from typing import Any, cast

from calc_check import CTX, credit, fit, multiples, pme, rollup
from calc_check import attribution as attr
from calc_check import bridge as vc
from calc_check import underwriting as uw
from calc_check.irr import xirr


def _dec(v: str | None) -> Decimal | None:
    return None if v is None else Decimal(v)


def _agree(a: Decimal | None, b: Decimal | None, tol: Decimal) -> bool:
    if a is None or b is None:
        return a is None and b is None
    scale = max(Decimal(1), abs(a), abs(b))
    return abs(a - b) <= tol * scale


def check_case(case: dict[str, Any]) -> list[str]:
    kind = case["kind"]
    inp = case["input"]
    ts = case["result"]
    tol = Decimal(case["tolerance"])
    problems: list[str] = []
    if kind == "xirr":
        flows = [(f["date"], Decimal(f["amount"])) for f in inp["flows"]]
        r = xirr(flows)
        if r.reason != ts["reason"]:
            problems.append(f"reason {r.reason} vs ts {ts['reason']}")
        if not _agree(r.value, _dec(ts["value"]), tol):
            problems.append(f"irr {r.value} vs ts {ts['value']}")
    elif kind == "multiples":
        d, n, c = (Decimal(inp[k]) for k in ("distributions", "nav", "contributions"))
        for name, mine in (
            ("dpi", multiples.dpi(d, c)),
            ("rvpi", multiples.rvpi(n, c)),
            ("tvpi", multiples.tvpi(d, n, c)),
        ):
            if not _agree(mine, _dec(ts[name]), tol):
                problems.append(f"{name} {mine} vs ts {ts[name]}")
    elif kind == "value_change":
        change = multiples.value_change(Decimal(inp["current"]), Decimal(inp["prior"]))
        if not _agree(change, _dec(ts["value"]), tol):
            problems.append(f"valueChange {change} vs ts {ts['value']}")
    elif kind == "ytm":
        value, _irr, _flows, par = credit.yield_to_maturity(
            inp["asOf"],
            Decimal(inp["fairValue"]),
            Decimal(inp["par"]),
            Decimal(inp["cashCoupon"]),
            Decimal(inp["pikCoupon"]),
            inp["maturity"],
            inp["frequency"],
        )
        if not _agree(value, _dec(ts["value"]), tol):
            problems.append(f"ytm {value} vs ts {ts['value']}")
        if not _agree(par, _dec(ts["parAtMaturity"]), tol):
            problems.append(f"par {par} vs ts {ts['parAtMaturity']}")
    elif kind == "attribution":
        parts = attr.attribution(
            {k: Decimal(v) for k, v in inp["entry"].items()},
            {k: Decimal(v) for k, v in inp["current"].items()},
        )
        if (parts is None) != (ts["total"] is None):
            problems.append("null mismatch")
        elif parts is not None:
            for key in (
                "revenueGrowth",
                "marginChange",
                "multipleChange",
                "netDebtChange",
                "total",
            ):
                if not _agree(parts[key], _dec(ts[key]), tol):
                    problems.append(f"{key} {parts[key]} vs ts {ts[key]}")
    elif kind == "pme":
        flows = [(f["date"], Decimal(f["amount"])) for f in inp["flows"]]
        index = [(p["date"], Decimal(p["level"])) for p in inp["index"]]
        ks = pme.ks_pme(flows, Decimal(inp["nav"]), inp["navDate"], index)
        alpha, _ = pme.direct_alpha(flows, Decimal(inp["nav"]), inp["navDate"], index)
        if not _agree(ks, _dec(ts["ksPme"]), tol):
            problems.append(f"ksPme {ks} vs ts {ts['ksPme']}")
        if not _agree(alpha, _dec(ts["directAlpha"]), tol):
            problems.append(f"directAlpha {alpha} vs ts {ts['directAlpha']}")
    elif kind == "bridge":
        problems.extend(_check_bridge(inp, ts, tol))
    elif kind == "since_entry":
        measures = vc.since_entry(_figures(inp["entry"]), _figures(inp["current"]))
        for key, theirs in ts.items():
            if not _agree(measures[key], _dec(theirs), tol):
                problems.append(f"{key} {measures[key]} vs ts {theirs}")
    elif kind == "bands":
        edges = [Decimal(e) for e in inp["edges"]]
        if vc.band_labels(edges) != ts["labels"]:
            problems.append(f"labels {vc.band_labels(edges)} vs ts {ts['labels']}")
        indexes = [vc.band_index(Decimal(v), edges) for v in inp["values"]]
        if indexes != ts["indexes"]:
            problems.append(f"indexes {indexes} vs ts {ts['indexes']}")
        average = vc.weighted_average(
            [(Decimal(i["weight"]), Decimal(i["value"])) for i in inp["weighted"]]
        )
        if not _agree(average, _dec(ts["weightedAverage"]), tol):
            problems.append(f"weightedAverage {average} vs ts {ts['weightedAverage']}")
    elif kind == "rollup":
        bands = {
            name: rollup.cohort_bands(edges, vc.band_labels(edges))
            for name, edges in (
                ("byEntryMultiple", [Decimal(e) for e in inp["edges"]["multiple"]]),
                ("byEntryLeverage", [Decimal(e) for e in inp["edges"]["leverage"]]),
            )
        }
        rolled = rollup.rollup(inp["positions"], bands, inp["asOf"])
        problems.extend(rollup.differences(rolled, ts, tol))
        # The parts as they travel are the gain exactly: no tolerance (docs/08 section 8).
        book = ts["portfolio"]
        if book["gainByDriver"] is not None:
            summed = sum((Fraction(book["gainByDriver"][k]) for k in rollup.PARTS), Fraction(0))
            if summed != Fraction(book["gain"]):
                problems.append("ts portfolio parts do not sum to the gain")
    elif kind == "fit":
        scores = fit.deal_fit(inp["inputs"], inp["thresholds"])
        for key in fit.MEASURES:
            if not _agree(scores[key], _dec(ts["scores"][key]), tol):
                problems.append(f"{key} {scores[key]} vs ts {ts['scores'][key]}")
        typical = fit.median([Decimal(v) for v in inp["positions"]])
        if not _agree(typical, _dec(ts["median"]), tol):
            problems.append(f"median {typical} vs ts {ts['median']}")
    elif kind == "plan":
        plan_rows = uw.plan_metrics(inp["points"], inp["quarter"], inp["onPlanTolerance"])
        problems.extend(uw.differences(plan_rows, ts["metrics"], "metrics"))
        if uw.headline(plan_rows) != ts["headline"]:
            problems.append(f"headline {uw.headline(plan_rows)} vs ts {ts['headline']}")
    elif kind == "underwriting":
        answer = uw.comparison(inp["case"], inp["inputs"], inp["tolerances"])
        problems.extend(uw.differences(answer, ts, "comparison"))
    else:
        problems.append(f"unknown kind {kind}")
    return problems


def _figures(raw: dict[str, str | None]) -> dict[str, Decimal | None]:
    return {k: _dec(v) for k, v in raw.items()}


DRIVERS = ("ebitdaGrowth", "multipleExpansion", "debtPaydown")


def _check_bridge(inp: dict[str, Any], ts: dict[str, Any], tol: Decimal) -> list[str]:
    """The EBITDA bridge and our gain split by it, part by part, and the exact sums."""
    problems: list[str] = []
    mine = vc.bridge(_figures(inp["entry"]), _figures(inp["current"]))
    theirs = ts["bridge"]
    if (mine is None) != (theirs is None):
        return ["bridge null mismatch"]
    if (ts["reason"] == "non_positive_ebitda") != (mine is None):
        problems.append(f"reason {ts['reason']} with bridge {mine}")
    gain = vc.total_gain(
        Decimal(inp["distributions"]), Decimal(inp["nav"]), Decimal(inp["invested"])
    )
    if not _agree(gain, _dec(ts["gain"]), tol):
        problems.append(f"gain {gain} vs ts {ts['gain']}")
    if mine is None:
        if ts["split"] is not None:
            problems.append("split without a bridge")
        return problems
    for key in (
        "equityAtEntry",
        "equityCurrent",
        *DRIVERS,
        "total",
        "revenueGrowth",
        "marginChange",
    ):
        if not _agree(cast(Decimal | None, mine[key]), _dec(theirs[key]), tol):
            problems.append(f"{key} {mine[key]} vs ts {theirs[key]}")
    with localcontext(CTX):
        if sum((Decimal(theirs[k]) for k in DRIVERS), Decimal(0)) != Decimal(theirs["total"]):
            problems.append("ts drivers do not sum to the total")
    my_shares = cast(dict[str, Decimal] | None, mine["shares"])
    if (my_shares is None) != (theirs["shares"] is None):
        problems.append("shares null mismatch")
    elif my_shares is not None:
        for key in DRIVERS:
            if not _agree(my_shares[key], _dec(theirs["shares"][key]), tol):
                problems.append(f"share {key} {my_shares[key]} vs ts {theirs['shares'][key]}")
    split = vc.gain_by_driver(
        gain,
        Decimal(inp["invested"]),
        cast(Decimal, mine["equityAtEntry"]),
        cast(Decimal, mine["ebitdaGrowth"]),
        cast(Decimal, mine["multipleExpansion"]),
        cast(Decimal, mine["debtPaydown"]),
        cast(Decimal | None, mine["revenueGrowth"]),
    )
    if isinstance(split, str):
        if ts["split"] is not None or ts["splitReason"] != split:
            problems.append(f"split reason {split} vs ts {ts['splitReason']} {ts['split']}")
        return problems
    if ts["split"] is None:
        return [*problems, f"split null mismatch (ts reason {ts['splitReason']})"]
    for key in ("stake", *DRIVERS, "other", "revenueGrowth", "marginChange"):
        if not _agree(split[key], _dec(ts["split"][key]), tol):
            problems.append(f"split {key} {split[key]} vs ts {ts['split'][key]}")
    # The four parts are the gain exactly, whatever the stake (docs/08 section 8).
    parts = sum((Fraction(ts["split"][k]) for k in (*DRIVERS, "other")), Fraction(0))
    if parts != Fraction(ts["gain"]):
        problems.append("ts split does not sum to the gain")
    return problems


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m calc_check.cross_check <cases.json>")
        return 2
    data = cast(dict[str, Any], json.loads(Path(argv[1]).read_text()))
    cases = cast(list[dict[str, Any]], data["cases"])
    failures = 0
    by_kind: dict[str, int] = {}
    for case in cases:
        by_kind[case["kind"]] = by_kind.get(case["kind"], 0) + 1
        problems = check_case(case)
        if problems:
            failures += 1
            print(f"MISMATCH {case['kind']}#{case['id']}: {'; '.join(problems)}")
    summary = ", ".join(f"{k}={v}" for k, v in sorted(by_kind.items()))
    print(
        f"cross-check: {len(cases)} cases ({summary}), calc version {data['calcVersion']}, "
        f"seed {data['seed']}: {failures} mismatches"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
