"""Deal fit measures of docs/08 section 8, worked in exact fractions.

Seven scores from 0 to 100 for one opportunity, each a rule over recorded figures. Nothing here
shares code with the TypeScript library: a score is a fraction of the way along a straight line,
held between its ends and rounded once, half up, to the ten places a result travels with.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, localcontext
from fractions import Fraction

MEASURES = (
    "sponsor_relationship",
    "track_record",
    "fund_relationship",
    "sector_room",
    "sponsor_room",
    "geography_room",
    "size_fit",
)

_QUANTUM = Decimal(1).scaleb(-10)


class FitThresholdsError(ValueError):
    code = "invalid_fit_thresholds"


def _held(value: Fraction) -> Decimal:
    with localcontext() as ctx:
        ctx.prec = 200
        exact = Decimal(value.numerator) / Decimal(value.denominator)
        return exact.quantize(_QUANTUM, rounding=ROUND_HALF_UP)


def _frac(value: str | Decimal) -> Fraction:
    return Fraction(str(value))


def linear_score(value: Fraction, zero_at: Fraction, full_at: Fraction) -> Decimal:
    """100 times the share of the way from zero_at to full_at, never below 0 or above 100."""
    if full_at == zero_at:
        raise FitThresholdsError("a score needs two different ends")
    share = (value - zero_at) / (full_at - zero_at)
    share = min(max(share, Fraction(0)), Fraction(1))
    return _held(share * 100)


def size_score(ratio: Fraction, low: Fraction, high: Fraction, limit: Fraction) -> Decimal:
    """100 inside the band, a straight climb from nothing below it, a straight fall to the limit."""
    if not (0 < low <= high < limit):
        raise FitThresholdsError("the size band needs 0 < low <= high < limit")
    if ratio < low:
        return linear_score(ratio, Fraction(0), low)
    if ratio <= high:
        return Decimal(100)
    return linear_score(ratio, limit, high)


def median(values: list[Decimal]) -> Decimal | None:
    ordered = sorted(values)
    if not ordered:
        return None
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def _configured(raw: str, what: str) -> Decimal:
    score = _frac(raw)
    if score < 0 or score > 100:
        raise FitThresholdsError(f"{what} must be from 0 to 100")
    return _held(score)


def _cap(raw: str, what: str) -> Fraction:
    cap = _frac(raw)
    if cap <= 0:
        raise FitThresholdsError(f"{what} must be above zero")
    return cap


def deal_fit(
    inputs: dict[str, str | None], thresholds: dict[str, dict[str, str]]
) -> dict[str, Decimal | None]:
    """The score of each measure, or None where it has none."""
    tiers = {
        tier: _configured(score, f"the score of {tier}")
        for tier, score in thresholds["tierScores"].items()
    }
    commitments = {
        kind: _configured(thresholds["fundRelationship"][kind], f"fundRelationship.{kind}")
        for kind in ("fund", "otherFund", "none")
    }
    caps = {
        name: _cap(thresholds["caps"][name], f"caps.{name}")
        for name in ("sector", "sponsor", "geography")
    }
    zero_at = _frac(thresholds["trackRecord"]["zeroAtMoic"])
    full_at = _frac(thresholds["trackRecord"]["fullAtMoic"])
    low, high, limit = (_frac(thresholds["size"][k]) for k in ("low", "high", "limit"))
    # Both rules once on a harmless value, so bad thresholds are refused whatever the inputs.
    linear_score(zero_at, zero_at, full_at)
    size_score(low, low, high, limit)

    def room(share: str | None, cap: Fraction) -> Decimal | None:
        return None if share is None else linear_score(_frac(share), cap, Fraction(0))

    tier = inputs["sponsorTier"]
    moic = inputs["sponsorMoic"]
    target = inputs["targetCommitment"]
    typical = inputs["medianPosition"]
    size: Decimal | None = None
    if target is not None and typical is not None and _frac(typical) > 0:
        size = size_score(_frac(target) / _frac(typical), low, high, limit)
    commitment = inputs["commitment"]
    if commitment is None:
        raise FitThresholdsError("a deal has a commitment answer: fund, otherFund or none")
    return {
        "sponsor_relationship": None if tier is None else tiers.get(tier),
        "track_record": None if moic is None else linear_score(_frac(moic), zero_at, full_at),
        "fund_relationship": commitments[commitment],
        "sector_room": room(inputs["sectorShare"], caps["sector"]),
        "sponsor_room": room(inputs["sponsorShare"], caps["sponsor"]),
        "geography_room": room(inputs["geographyShare"], caps["geography"]),
        "size_fit": size,
    }
