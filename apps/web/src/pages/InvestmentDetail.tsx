import type { ReactNode } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '@fluentui/react-components';
import type { InvestmentDetail } from '@pb/contracts';
import { ApiError } from '../api/client.js';
import { investmentQuery } from '../app/queries.js';
import { Card, ErrorState, SectionHeader, StatTile } from '../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatMonthYear,
  formatMultiple,
  formatPct,
  irrDisplay,
  labelOf,
  MISSING,
} from '../lib/format.js';

function OperatingTable({ detail }: { detail: InvestmentDetail }): ReactNode {
  const o = detail.operating;
  if (o === null) return <p>No approved quarterly financials for this position.</p>;
  return (
    <table className="pb-table" aria-label="Financial performance">
      <thead>
        <tr>
          <th>Metric</th>
          <th className="num">LTM / Current ({formatDate(o.periodEnd)})</th>
          <th className="num">
            Prior Year (
            {o.priorYearPeriodEnd === null ? 'not available' : formatDate(o.priorYearPeriodEnd)})
          </th>
          <th className="num">YoY</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Revenue (LTM)</td>
          <td className="num">{formatMoneyM(o.revenueLtm)}</td>
          <td className="num">{MISSING}</td>
          <td className="num">{formatPct(o.revenueYoy)}</td>
        </tr>
        <tr>
          <td>EBITDA (LTM)</td>
          <td className="num">{formatMoneyM(o.ebitdaLtm)}</td>
          <td className="num">{MISSING}</td>
          <td className="num">{formatPct(o.ebitdaYoy)}</td>
        </tr>
        <tr>
          <td>EBITDA margin</td>
          <td className="num">{formatPct(o.ebitdaMargin)}</td>
          <td className="num">{MISSING}</td>
          <td className="num">{MISSING}</td>
        </tr>
        <tr>
          <td>Enterprise value</td>
          <td className="num">{formatMoneyM(o.ev)}</td>
          <td className="num">{MISSING}</td>
          <td className="num">{MISSING}</td>
        </tr>
        <tr>
          <td>EV / EBITDA</td>
          <td className="num">{formatMultiple(o.evToEbitda)}</td>
          <td className="num">{MISSING}</td>
          <td className="num">{MISSING}</td>
        </tr>
        <tr>
          <td>Net debt / EBITDA</td>
          <td className="num">{formatMultiple(o.netDebtToEbitda)}</td>
          <td className="num">{MISSING}</td>
          <td className="num">{MISSING}</td>
        </tr>
      </tbody>
    </table>
  );
}

function CreditTerms({ detail }: { detail: InvestmentDetail }): ReactNode {
  const c = detail.credit;
  if (c === null) return null;
  const l = c.latest;
  return (
    <Card>
      <SectionHeader>Credit terms</SectionHeader>
      <table className="pb-table" aria-label="Credit terms">
        <tbody>
          <tr>
            <td>Facility</td>
            <td>{labelOf(c.facilityType)}</td>
            <td>Base rate</td>
            <td>{labelOf(c.baseRate)}</td>
          </tr>
          <tr>
            <td>Spread</td>
            <td>{formatPct(c.spread, 2)}</td>
            <td>Cash / PIK coupon</td>
            <td>
              {formatPct(c.cashCoupon, 2)} / {formatPct(c.pikCoupon, 2)}
            </td>
          </tr>
          <tr>
            <td>Maturity</td>
            <td>{formatDate(c.maturityDate)}</td>
            <td>Current yield</td>
            <td>{formatPct(l?.currentYield ?? null, 2)}</td>
          </tr>
          <tr>
            <td>Interest coverage</td>
            <td>{formatMultiple(l?.interestCoverage ?? null)}</td>
            <td>Leverage through tranche</td>
            <td>{formatMultiple(l?.leverageThroughTranche ?? null)}</td>
          </tr>
          <tr>
            <td>LTV</td>
            <td>{formatPct(l?.loanToValue ?? null)}</td>
            <td>Covenant / payment status</td>
            <td>
              {labelOf(l?.covenantStatus ?? null)} / {labelOf(l?.paymentStatus ?? null)}
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

export function InvestmentDetailPage(): ReactNode {
  const { id } = useParams({ from: '/app/portfolio/$id' });
  const q = useQuery(investmentQuery(id));
  if (q.isPending) return <Spinner label="Loading the one-pager" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <ErrorState
        title={notFound ? 'Investment not found' : 'Could not load this investment'}
        detail={
          notFound
            ? 'There is no investment with this id in your view of the portfolio.'
            : q.error.message
        }
      />
    );
  }
  const d = q.data;
  const isCredit = d.credit !== null;
  return (
    <>
      <div className="pb-banner" data-testid="detail-banner">
        <h1>{d.companyName}</h1>
        <span className="pb-meta">
          {d.vehicleName} | {labelOf(d.dealType)} | Investment date {formatMonthYear(d.entryDate)} |
          As of {formatDate(d.navDate ?? d.latestPeriodEnd)}
        </span>
      </div>
      <div className="pb-tiles">
        <StatTile
          label={isCredit ? 'Funded' : 'Invested capital'}
          value={formatMoneyM(d.invested)}
        />
        {isCredit ? (
          <StatTile label="Par" value={formatMoneyM(d.credit?.latest?.parValue ?? null)} />
        ) : null}
        <StatTile
          label={isCredit ? 'Fair value' : 'Current NAV'}
          value={formatMoneyM(d.nav)}
          hint={d.navDate === null ? 'No Locked valuation' : `Locked ${formatDate(d.navDate)}`}
        />
        <StatTile label="Gross MOIC" value={formatMoic(d.grossMoic)} />
        <StatTile
          label="Gross IRR"
          value={irrDisplay(d)}
          hint={d.irrFlag === null ? undefined : `Flag: ${d.irrFlag.replace('_', ' ')}`}
        />
      </div>
      <Card tinted>
        <SectionHeader>Deal details</SectionHeader>
        <table className="pb-table" aria-label="Deal details">
          <tbody>
            <tr>
              <td>Sponsor</td>
              <td>{d.sponsorName}</td>
              <td>Sponsor fund</td>
              <td>{d.sponsorFundName ?? MISSING}</td>
            </tr>
            <tr>
              <td>Sector</td>
              <td>{labelOf(d.sector)}</td>
              <td>Geography</td>
              <td>{labelOf(d.geography)}</td>
            </tr>
            <tr>
              <td>Investment number</td>
              <td>{d.investmentNumber}</td>
              <td>Status</td>
              <td>{d.isActive ? 'Active' : `Realized ${formatDate(d.exitDate)}`}</td>
            </tr>
          </tbody>
        </table>
      </Card>
      {isCredit ? (
        <CreditTerms detail={d} />
      ) : (
        <Card>
          <SectionHeader>Financial performance</SectionHeader>
          <OperatingTable detail={d} />
        </Card>
      )}
      <Card>
        <SectionHeader>Valuations</SectionHeader>
        <table className="pb-table" aria-label="Valuations">
          <thead>
            <tr>
              <th>Period end</th>
              <th>Version</th>
              <th>State</th>
              <th>Method</th>
              <th className="num">Fair value</th>
            </tr>
          </thead>
          <tbody>
            {[...d.valuations]
              .reverse()
              .slice(0, 8)
              .map((v) => (
                <tr key={`${v.periodEnd}-${v.version}`}>
                  <td>{formatDate(v.periodEnd)}</td>
                  <td>{v.version}</td>
                  <td>{v.state}</td>
                  <td>{labelOf(v.method)}</td>
                  <td className="num">{formatMoneyM(v.fairValue)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>
      <Card>
        <SectionHeader>Cash flows</SectionHeader>
        <table className="pb-table" aria-label="Cash flows">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {d.cashFlows.map((f, i) => (
              <tr key={`${f.date}-${i}`}>
                <td>{formatDate(f.date)}</td>
                <td>{labelOf(f.flowType)}</td>
                <td className="num">{formatMoneyM(f.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
