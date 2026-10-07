from __future__ import annotations

from decimal import Decimal, localcontext

from calc_check import CTX
from calc_check.dates import add_months
from calc_check.irr import Flow, IrrResult, xirr

MONTHS = {"monthly": 1, "quarterly": 3, "semiannual": 6, "annual": 12}


def all_in_coupon(base: Decimal | None, floor: Decimal | None, spread: Decimal) -> Decimal | None:
    if base is None:
        return None
    effective = base if floor is None else max(base, floor)
    return effective + spread


def current_yield(cash_coupon: Decimal, par: Decimal, fair_value: Decimal) -> Decimal | None:
    if fair_value <= 0:
        return None
    return cash_coupon * par / fair_value


def ytm_flows(
    as_of: str,
    fair_value: Decimal,
    par: Decimal,
    cash_coupon: Decimal,
    pik_coupon: Decimal,
    maturity: str,
    frequency: str,
    scheduled_principal: list[tuple[str, Decimal]] | None = None,
) -> tuple[list[Flow], Decimal]:
    months = MONTHS[frequency]
    per_year = Decimal(12 // months)
    cash = cash_coupon / per_year
    pik = pik_coupon / per_year
    dates: list[str] = []
    d = maturity
    while d > as_of:
        dates.append(d)
        d = add_months(d, -months)
    dates.reverse()
    principal = sorted(scheduled_principal or [])
    i = 0
    flows: list[Flow] = [(as_of, -fair_value)]
    for date in dates:
        interest = par * cash
        par = par * (1 + pik)
        repaid = Decimal(0)
        while i < len(principal) and principal[i][0] <= date:
            repaid += abs(principal[i][1])
            i += 1
        repaid = min(repaid, par)
        par -= repaid
        amount = interest + repaid + (par if date == maturity else Decimal(0))
        flows.append((date, amount))
    return flows, par


def yield_to_maturity(
    as_of: str,
    fair_value: Decimal,
    par: Decimal,
    cash_coupon: Decimal,
    pik_coupon: Decimal,
    maturity: str,
    frequency: str,
    scheduled_principal: list[tuple[str, Decimal]] | None = None,
) -> tuple[Decimal | None, IrrResult | None, list[Flow], Decimal | None]:
    if fair_value <= 0 or maturity <= as_of:
        return None, None, [], None
    with localcontext(CTX):
        flows, par_at_maturity = ytm_flows(
            as_of, fair_value, par, cash_coupon, pik_coupon, maturity, frequency, scheduled_principal
        )
        irr = xirr(flows)
        return irr.value, irr, flows, par_at_maturity


def cash_on_cash(cash_interest: Decimal, average_funded: Decimal) -> Decimal | None:
    return None if average_funded <= 0 else cash_interest / average_funded


def interest_coverage(ebitda: Decimal | None, cash_interest: Decimal | None) -> Decimal | None:
    if ebitda is None or cash_interest is None or ebitda <= 0 or cash_interest <= 0:
        return None
    return ebitda / cash_interest


def leverage_through_tranche(net_debt: Decimal, ebitda: Decimal | None) -> Decimal | None:
    if ebitda is None or ebitda <= 0:
        return None
    return net_debt / ebitda


def loan_to_value(net_debt: Decimal, ev: Decimal | None) -> Decimal | None:
    if ev is None or ev <= 0:
        return None
    return net_debt / ev


def dscr(
    ebitda: Decimal,
    cash_taxes: Decimal,
    maintenance_capex: Decimal,
    cash_interest: Decimal,
    scheduled_principal: Decimal,
) -> Decimal | None:
    service = cash_interest + scheduled_principal
    if service <= 0:
        return None
    return (ebitda - cash_taxes - maintenance_capex) / service


def par_roll_forward(
    begin: Decimal,
    fundings: Decimal,
    pik_capitalized: Decimal,
    principal_repaid: Decimal,
    end: Decimal,
    tolerance: Decimal = Decimal(1),
) -> tuple[bool, Decimal]:
    difference = end - (begin + fundings + pik_capitalized - principal_repaid)
    return abs(difference) <= tolerance, difference


def capitalize_pik(par: Decimal, pik_coupon: Decimal, frequency: str) -> Decimal:
    per_year = Decimal(12 // MONTHS[frequency])
    return par * (1 + abs(pik_coupon) / per_year)
