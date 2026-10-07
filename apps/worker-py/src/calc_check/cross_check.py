"""Compares results produced by packages/calc (TypeScript) with this implementation.

Usage: python -m calc_check.cross_check <cases.json>
The cases file is written by `node packages/calc/dist/cross-check/generate.js`.
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from calc_check import attribution as attr
from calc_check import credit, multiples, pme
from calc_check.irr import xirr


def _dec(v: str | None) -> Decimal | None:
    return None if v is None else Decimal(v)


def _agree(a: Decimal | None, b: Decimal | None, tol: Decimal) -> bool:
    if a is None or b is None:
        return a is None and b is None
    scale = max(Decimal(1), abs(a), abs(b))
    return abs(a - b) <= tol * scale


def check_case(case: dict[str, Any]) -> list[str]:  # noqa: PLR0912
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
        r = attr.attribution(
            {k: Decimal(v) for k, v in inp["entry"].items()},
            {k: Decimal(v) for k, v in inp["current"].items()},
        )
        if (r is None) != (ts["total"] is None):
            problems.append("null mismatch")
        elif r is not None:
            for key in ("revenueGrowth", "marginChange", "multipleChange", "netDebtChange", "total"):
                if not _agree(r[key], _dec(ts[key]), tol):
                    problems.append(f"{key} {r[key]} vs ts {ts[key]}")
    elif kind == "pme":
        flows = [(f["date"], Decimal(f["amount"])) for f in inp["flows"]]
        index = [(p["date"], Decimal(p["level"])) for p in inp["index"]]
        ks = pme.ks_pme(flows, Decimal(inp["nav"]), inp["navDate"], index)
        alpha, _ = pme.direct_alpha(flows, Decimal(inp["nav"]), inp["navDate"], index)
        if not _agree(ks, _dec(ts["ksPme"]), tol):
            problems.append(f"ksPme {ks} vs ts {ts['ksPme']}")
        if not _agree(alpha, _dec(ts["directAlpha"]), tol):
            problems.append(f"directAlpha {alpha} vs ts {ts['directAlpha']}")
    else:
        problems.append(f"unknown kind {kind}")
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
