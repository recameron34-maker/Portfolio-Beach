import type { ReactNode } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { InvestmentDetail } from '@pb/contracts';
import { ApiError } from '../api/client.js';
import { investmentQuery } from '../app/queries.js';
import {
  Badge,
  Card,
  ErrorState,
  KeyValueTable,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  NumCell,
  StatTile,
} from '../components/ui.js';
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
import { creditStatusTone } from '../lib/labels.js';
import { humanizeState, valuationTone } from '../lib/states.js';

function OperatingTable({ detail }: { detail: InvestmentDetail }): ReactNode {
  const o = detail.operating;
  if (o === null) return <p>No approved quarterly financials for this position.</p>;
  return (
    <div className="pb-table-wrap">
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
            <NumCell>{formatMoneyM(o.revenueLtm)}</NumCell>
            <NumCell>{MISSING}</NumCell>
            <NumCell>{formatPct(o.revenueYoy)}</NumCell>
          </tr>
          <tr>
            <td>EBITDA (LTM)</td>
            <NumCell>{formatMoneyM(o.ebitdaLtm)}</NumCell>
            <NumCell>{MISSING}</NumCell>
            <NumCell>{formatPct(o.ebitdaYoy)}</NumCell>
          </tr>
          <tr>
            <td>EBITDA margin</td>
            <NumCell>{formatPct(o.ebitdaMargin)}</NumCell>
            <NumCell>{MISSING}</NumCell>
            <NumCell>{MISSING}</NumCell>
          </tr>
          <tr>
            <td>Enterprise value</td>
            <NumCell>{formatMoneyM(o.ev)}</NumCell>
            <NumCell>{MISSING}</NumCell>
            <NumCell>{MISSING}</NumCell>
          </tr>
          <tr>
            <td>EV / EBITDA</td>
            <NumCell>{formatMultiple(o.evToEbitda)}</NumCell>
            <NumCell>{MISSING}</NumCell>
            <NumCell>{MISSING}</NumCell>
          </tr>
          <tr>
            <td>Net debt / EBITDA</td>
            <NumCell>{formatMultiple(o.netDebtToEbitda)}</NumCell>
            <NumCell>{MISSING}</NumCell>
            <NumCell>{MISSING}</NumCell>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function CreditTerms({ detail }: { detail: InvestmentDetail }): ReactNode {
  const c = detail.credit;
  if (c === null) return null;
  const l = c.latest;
  return (
    <Card tinted>
      <SectionHeader>Credit terms</SectionHeader>
      <KeyValueTable
        label="Credit terms"
        rows={[
          { label: 'Facility', value: labelOf(c.facilityType) },
          { label: 'Base rate', value: labelOf(c.baseRate) },
          { label: 'Spread', value: formatPct(c.spread, 2) },
          {
            label: 'Cash / PIK coupon',
            value: `${formatPct(c.cashCoupon, 2)} / ${formatPct(c.pikCoupon, 2)}`,
          },
          { label: 'Maturity', value: formatDate(c.maturityDate) },
          { label: 'Current yield', value: formatPct(l?.currentYield ?? null, 2) },
          { label: 'Interest coverage', value: formatMultiple(l?.interestCoverage ?? null) },
          {
            label: 'Leverage through tranche',
            value: formatMultiple(l?.leverageThroughTranche ?? null),
          },
          { label: 'LTV', value: formatPct(l?.loanToValue ?? null) },
          {
            label: 'Covenant / payment status',
            value: (
              <>
                <Badge tone={creditStatusTone(l?.covenantStatus ?? null)}>
                  {labelOf(l?.covenantStatus ?? null)}
                </Badge>{' '}
                <Badge tone={creditStatusTone(l?.paymentStatus ?? null)}>
                  {labelOf(l?.paymentStatus ?? null)}
                </Badge>
              </>
            ),
          },
        ]}
      />
    </Card>
  );
}

export function InvestmentDetailPage(): ReactNode {
  const { id } = useParams({ from: '/app/portfolio/$id' });
  const q = useQuery(investmentQuery(id));
  if (q.isPending) return <PageSkeleton tiles={4} rows={6} />;
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
      <PageHeader
        testId="detail-banner"
        title={d.companyName}
        meta={
          <span className="pb-meta-list">
            <span>{d.vehicleName}</span>
            <span>{labelOf(d.dealType)}</span>
            <span>Investment date {formatMonthYear(d.entryDate)}</span>
            <span>As of {formatDate(d.navDate ?? d.latestPeriodEnd)}</span>
          </span>
        }
        actions={
          d.isActive ? <Badge tone="brand">Active</Badge> : <Badge tone="neutral">Realized</Badge>
        }
      />
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
        <KeyValueTable
          label="Deal details"
          rows={[
            { label: 'Sponsor', value: d.sponsorName },
            { label: 'Sponsor fund', value: d.sponsorFundName ?? MISSING },
            { label: 'Sector', value: labelOf(d.sector) },
            { label: 'Geography', value: labelOf(d.geography) },
            {
              label: 'Investment number',
              value: <span className="pb-key">{d.investmentNumber}</span>,
            },
            {
              label: 'Status',
              value: d.isActive ? 'Active' : `Realized ${formatDate(d.exitDate)}`,
            },
          ]}
        />
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
        <SectionHeader aside={d.valuations.length > 8 ? 'latest 8' : undefined}>
          Valuations
        </SectionHeader>
        <div className="pb-table-wrap">
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
                    <td>
                      <Badge tone={valuationTone(v.state)}>{humanizeState(v.state)}</Badge>
                    </td>
                    <td>{labelOf(v.method)}</td>
                    <NumCell>{formatMoneyM(v.fairValue)}</NumCell>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card>
        <SectionHeader>Cash flows</SectionHeader>
        <div className="pb-table-wrap">
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
                  <NumCell>{formatMoneyM(f.amount)}</NumCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
