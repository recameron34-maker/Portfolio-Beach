from __future__ import annotations

from decimal import Decimal, localcontext

from calc_check import CTX


def attribution(
    entry: dict[str, Decimal], current: dict[str, Decimal]
) -> dict[str, Decimal] | None:
    r0, e0, ev0, d0 = entry["revenue"], entry["ebitda"], entry["ev"], entry["netDebt"]
    r1, e1, ev1, d1 = current["revenue"], current["ebitda"], current["ev"], current["netDebt"]
    if r0 <= 0 or e0 <= 0 or r1 <= 0 or e1 <= 0:
        return None
    with localcontext(CTX):
        m0, x0 = e0 / r0, ev0 / e0
        m1, x1 = e1 / r1, ev1 / e1
        eq0 = r0 * m0 * x0 - d0
        s1 = r1 * m0 * x0 - d0
        s2 = r1 * m1 * x0 - d0
        s3 = r1 * m1 * x1 - d0
        eq1 = r1 * m1 * x1 - d1
        return {
            "equityAtEntry": eq0,
            "equityCurrent": eq1,
            "revenueGrowth": s1 - eq0,
            "marginChange": s2 - s1,
            "multipleChange": s3 - s2,
            "netDebtChange": eq1 - s3,
            "total": eq1 - eq0,
        }
