"""The roll-up of the value creation views (docs/08 section 8), worked independently.

Position rows arrive as they travel: decimal strings, each row with its signed dated flows. The
portfolio sums our gain by driver over the rows that are split; a cohort pools the rows of one
band by the pooled rule of sections 2 and 3. Nothing is rounded here: the comparison with the
TypeScript library allows for the ten places its figures travel with.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Any

from calc_check import CTX
from calc_check.irr import Flow, xirr

REASONS = (
    "no_entry_snapshot",
    "entry_snapshot_forward_dated",
    "no_current_quarter",
    "missing_figures",
    "non_positive_ebitda",
    "non_positive_entry_equity",
    "no_gain",
)
PARTS = ("ebitdaGrowth", "multipleExpansion", "debtPaydown", "other")
CENT = Decimal("0.01")

Row = dict[str, Any]


def _total(values: list[str | None]) -> Decimal:
    with localcontext(CTX):
        return sum((Decimal(v) for v in values if v is not None), Decimal(0))


def pooled(
    count: int,
    contributions: Decimal,
    distributions: Decimal,
    nav: Decimal | None,
    flows: list[Flow],
    as_of: str,
) -> dict[str, Decimal | int | str | None]:
    """Multiples over the sums; the IRR over the flows, ending in the NAV on the as-of date."""
    empty: dict[str, Decimal | int | str | None] = {
        key: None for key in ("invested", "distributions", "nav", "dpi", "rvpi", "tvpi")
    }
    if count == 0:
        return {
            **empty,
            "count": 0,
            "grossMoic": None,
            "grossIrr": None,
            "irrFlag": "insufficient_flows",
        }
    paid = contributions != 0
    irr: Decimal | None = None
    flag: str | None
    if nav is None:
        flag = "no_valuation"
    else:
        signed = list(flows)
        if nav != 0:
            signed.append((as_of, nav.quantize(CENT, rounding=ROUND_HALF_UP)))
        if len(signed) < 2:
            flag = "insufficient_flows"
        else:
            result = xirr(signed)
            irr = result.value
            short = "short_period" if result.short_period else None
            flag = result.reason if irr is None else short
    with localcontext(CTX):
        total = None if nav is None or not paid else (distributions + nav) / contributions
        return {
            "count": count,
            "invested": contributions if paid else None,
            "distributions": distributions if paid else None,
            "nav": nav,
            "dpi": distributions / contributions if paid else None,
            "rvpi": nav / contributions if paid and nav is not None else None,
            "tvpi": total,
            "grossMoic": total,
            "grossIrr": irr,
            "irrFlag": flag,
        }


def portfolio(rows: list[Row]) -> dict[str, Any]:
    split = [r for r in rows if r["gainByDriver"] is not None]
    not_calculable = [
        {"reason": reason, "count": n}
        for reason in REASONS
        if (n := sum(1 for r in rows if r["gainNotCalculable"] == reason)) > 0
    ]
    if not split:
        return {
            "positions": 0,
            "invested": None,
            "nav": None,
            "distributions": None,
            "totalValue": None,
            "gain": None,
            "gainByDriver": None,
            "notCalculable": not_calculable,
        }
    nav = _total([r["nav"] for r in split])
    distributions = _total([r["distributions"] for r in split])
    parts: dict[str, Decimal | None] = {
        key: _total([r["gainByDriver"][key] for r in split]) for key in PARTS
    }
    opened = all(r["gainByDriver"]["revenueGrowth"] is not None for r in split)
    for key in ("revenueGrowth", "marginChange"):
        parts[key] = _total([r["gainByDriver"][key] for r in split]) if opened else None
    with localcontext(CTX):
        return {
            "positions": len(split),
            "invested": _total([r["invested"] for r in split]),
            "nav": nav,
            "distributions": distributions,
            "totalValue": nav + distributions,
            "gain": _total([r["gain"] for r in split]),
            "gainByDriver": parts,
            "notCalculable": not_calculable,
        }


def cohort(band: dict[str, str | None], members: list[Row], as_of: str) -> dict[str, Any]:
    flows: list[Flow] = [(f["date"], Decimal(f["amount"])) for r in members for f in r["flows"]]
    held = [r for r in members if r["isActive"]]
    nav = None if any(r["nav"] is None for r in held) else _total([r["nav"] for r in held])
    with localcontext(CTX):
        received = sum((amount for _, amount in flows if amount > 0), Decimal(0))
        weighed = [
            (Decimal(r["invested"]), Decimal(r["growth"]["ebitdaGrowth"]))
            for r in members
            if r["invested"] is not None and r["growth"]["ebitdaGrowth"] is not None
        ]
        weight = sum((w for w, _ in weighed), Decimal(0))
        growth = None if weight == 0 else sum((w * g for w, g in weighed), Decimal(0)) / weight
    return {
        **band,
        **pooled(
            len(members), _total([r["invested"] for r in members]), received, nav, flows, as_of
        ),
        "ebitdaGrowth": growth,
        "ebitdaGrowthPositions": len(weighed),
    }


def rollup(
    rows: list[Row], bands: dict[str, list[dict[str, str | None]]], as_of: str
) -> dict[str, Any]:
    def cohorts(name: str, key: str) -> list[dict[str, Any]]:
        return [cohort(b, [r for r in rows if r[key] == b["key"]], as_of) for b in bands[name]]

    return {
        "portfolio": portfolio(rows),
        "cohorts": {
            "byEntryMultiple": cohorts("byEntryMultiple", "entryMultipleBand"),
            "byEntryLeverage": cohorts("byEntryLeverage", "entryLeverageBand"),
        },
    }


def cohort_bands(edges: list[Decimal], labels: list[str]) -> list[dict[str, str | None]]:
    """The cohorts of an entry metric: a band per label, then the one with no entry figure."""
    bounds: list[Decimal | None] = [None, *edges, None]

    def text(edge: Decimal | None) -> str | None:
        return None if edge is None else format(edge.normalize(), "f")

    bands: list[dict[str, str | None]] = [
        {
            "key": f"band_{i}",
            "label": label,
            "lower": text(bounds[i]),
            "upper": text(bounds[i + 1]),
        }
        for i, label in enumerate(labels)
    ]
    none = {"key": "not_calculable", "label": "Not calculable", "lower": None, "upper": None}
    return [*bands, none]


NUMERIC = (
    "invested",
    "nav",
    "distributions",
    "totalValue",
    "gain",
    "dpi",
    "rvpi",
    "tvpi",
    "grossMoic",
    "grossIrr",
    "ebitdaGrowth",
    "revenueGrowth",
    "marginChange",
    *PARTS,
)


def differences(mine: Any, theirs: Any, tol: Decimal, path: str = "") -> list[str]:
    """Where a roll-up worked here differs from one as it travels; figures within the tolerance."""
    if isinstance(theirs, dict):
        if not isinstance(mine, dict) or set(mine) != set(theirs):
            return [f"{path}: keys {sorted(mine) if isinstance(mine, dict) else mine}"]
        return [d for k in theirs for d in _field(k, mine[k], theirs[k], tol, f"{path}.{k}")]
    if isinstance(theirs, list):
        if not isinstance(mine, list) or len(mine) != len(theirs):
            return [f"{path}: length"]
        return [
            d
            for i, (m, t) in enumerate(zip(mine, theirs, strict=True))
            for d in differences(m, t, tol, f"{path}[{i}]")
        ]
    return [] if mine == theirs else [f"{path}: {mine} vs {theirs}"]


def _field(key: str, mine: Any, theirs: Any, tol: Decimal, path: str) -> list[str]:
    if key not in NUMERIC or isinstance(theirs, dict):
        return differences(mine, theirs, tol, path)
    if mine is None or theirs is None:
        return [] if mine is None and theirs is None else [f"{path}: {mine} vs {theirs}"]
    scale = max(Decimal(1), abs(mine), abs(Decimal(theirs)))
    return [] if abs(mine - Decimal(theirs)) <= tol * scale else [f"{path}: {mine} vs {theirs}"]
