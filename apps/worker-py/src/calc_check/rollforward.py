from __future__ import annotations

from decimal import Decimal


def nav_roll_forward(
    begin: Decimal,
    contributions: Decimal,
    distributions: Decimal,
    gain_loss: Decimal,
    end: Decimal,
    tolerance: Decimal = Decimal(1),
) -> tuple[bool, Decimal]:
    difference = end - (begin + contributions - distributions + gain_loss)
    return abs(difference) <= tolerance, difference


def qtd_gain_loss(
    end: Decimal, begin_of_quarter: Decimal, contributions_qtd: Decimal, distributions_qtd: Decimal
) -> Decimal:
    return end - begin_of_quarter - contributions_qtd + distributions_qtd
