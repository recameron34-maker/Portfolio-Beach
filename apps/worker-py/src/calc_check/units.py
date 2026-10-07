from __future__ import annotations

from decimal import Decimal

FACTORS = {
    "USD": Decimal(1),
    "USD_K": Decimal(1000),
    "USD_M": Decimal(1_000_000),
    "USD_B": Decimal(1_000_000_000),
}


class UnknownUnitError(ValueError):
    code = "unknown_unit"


def to_dollars(value: Decimal, unit: str) -> Decimal:
    if unit not in FACTORS:
        raise UnknownUnitError(unit)
    return value * FACTORS[unit]
