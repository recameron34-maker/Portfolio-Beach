"""Independent implementation of docs/08 used to cross-check packages/calc (SEC-9.6).

Everything here uses decimal.Decimal, mirrors the null rules of the TypeScript library, and is
written without looking at that library's internals so the two are genuinely separate checks.
"""

from decimal import ROUND_HALF_UP, Context

CALC_VERSION = "0.1.0"
CTX = Context(prec=34, rounding=ROUND_HALF_UP)
