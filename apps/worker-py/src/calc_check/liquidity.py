from __future__ import annotations

from decimal import Decimal, localcontext

from calc_check import CTX


def takahashi_alexander(
    commitment: Decimal,
    rate_of_contribution: Decimal | list[Decimal],
    life: int,
    bow: Decimal,
    growth: Decimal,
    yield_floor: Decimal,
    years: int,
) -> list[dict[str, Decimal | int]]:
    if years < 1 or life <= 0:
        raise ValueError("invalid_params")
    with localcontext(CTX):
        unfunded = commitment
        nav = Decimal(0)
        rows: list[dict[str, Decimal | int]] = []
        for t in range(1, years + 1):
            if isinstance(rate_of_contribution, list):
                rc = rate_of_contribution[min(t - 1, len(rate_of_contribution) - 1)]
            else:
                rc = rate_of_contribution
            contribution = rc * unfunded
            grown = nav * (1 + growth)
            curve = (Decimal(t) / Decimal(life)) ** bow
            rd = curve if curve > yield_floor else yield_floor
            distribution = grown if rd > 1 else rd * grown
            nav = grown + contribution - distribution
            unfunded = unfunded - contribution
            rows.append(
                {
                    "year": t,
                    "contribution": contribution,
                    "distribution": distribution,
                    "nav": nav,
                    "unfunded": unfunded,
                }
            )
        return rows
