import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Spinner } from '@fluentui/react-components';
import type { InvestmentPerformance, InvestmentSummary } from '@pb/contracts';
import { investmentPerformanceQuery, investmentsQuery } from '../../app/queries.js';
import { LineChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  KeyValueTable,
  NumCell,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
} from '../../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatMonthYearShort,
  formatMultiple,
  formatPct,
  irrDisplay,
  labelOf,
  moneyLabel,
} from '../../lib/format.js';
import { creditStatusTone } from '../../lib/labels.js';
import { CREDIT_POSITIONS } from './constants.js';

type CreditBlock = NonNullable<InvestmentPerformance['credit']>;

function BookTable({ items }: { items: InvestmentSummary[] }): ReactNode {
  return (
    <TableWrap label="Credit positions">
      <table className="pb-table" aria-label="Credit positions">
        <thead>
          <tr>
            <th>Inv #</th>
            <th>Company</th>
            <th>Sponsor fund</th>
            <th>Vehicle</th>
            <th className="num">Funded</th>
            <th className="num">Fair value</th>
            <th className="num">Distributions</th>
            <th className="num">Gross MOIC</th>
            <th className="num">Gross IRR</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td>
                <span className="pb-key">{i.investmentNumber}</span>
              </td>
              <td>
                <Link to="/portfolio/$id" params={{ id: i.id }}>
                  {i.companyName}
                </Link>
              </td>
              <td>{i.sponsorFundName ?? i.sponsorName}</td>
              <td>{i.vehicleName}</td>
              <NumCell>{formatMoneyM(i.invested)}</NumCell>
              <NumCell>{formatMoneyM(i.nav)}</NumCell>
              <NumCell>{formatMoneyM(i.distributions)}</NumCell>
              <NumCell>{formatMoic(i.grossMoic)}</NumCell>
              <NumCell>{irrDisplay(i)}</NumCell>
              <td>
                {i.isActive ? (
                  <Badge tone="brand">Active</Badge>
                ) : (
                  <Badge tone="neutral">Realized</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function TermsTable({ credit }: { credit: CreditBlock }): ReactNode {
  const t = credit.terms;
  return (
    <KeyValueTable
      label="Credit terms"
      rows={[
        { label: 'Facility', value: labelOf(t.facilityType) },
        { label: 'Seniority', value: `Rank ${t.seniorityRank}` },
        { label: 'Base rate', value: labelOf(t.baseRate) },
        { label: 'Spread', value: formatPct(t.spread, 2) },
        { label: 'Floor', value: formatPct(t.floor, 2) },
        {
          label: 'Coupon (cash / PIK)',
          value: `${formatPct(t.cashCoupon, 2)} / ${formatPct(t.pikCoupon, 2)}`,
        },
        { label: 'All-in coupon', value: formatPct(t.allInCoupon, 2) },
        { label: 'Yield to maturity', value: formatPct(t.yieldToMaturity, 2) },
        { label: 'OID', value: formatPct(t.oid, 2) },
        { label: 'Upfront fee', value: formatPct(t.upfrontFee, 2) },
        { label: 'Commitment', value: formatMoneyM(t.commitmentAmount) },
        { label: 'Effective', value: formatDate(t.effectiveDate) },
        {
          label: 'Maturity',
          value: (
            <>
              {formatDate(t.maturityDate)}
              {t.pastMaturity ? (
                <>
                  {' '}
                  <Badge tone="bad">Past maturity</Badge>
                </>
              ) : null}
            </>
          ),
        },
        { label: 'Payment frequency', value: labelOf(t.paymentFrequency) },
        {
          label: 'Call protection',
          value:
            t.callProtection.length === 0
              ? 'None recorded'
              : t.callProtection
                  .map((c) => `${formatPct(c.premium, 2)} until ${formatDate(c.until)}`)
                  .join('; '),
        },
        {
          label: 'Covenants',
          value:
            t.covenants.length === 0
              ? 'None recorded'
              : t.covenants
                  .map(
                    (c) =>
                      `${c.name} ${formatMultiple(c.level)} (${labelOf(c.test).toLowerCase()})`,
                  )
                  .join('; '),
        },
      ]}
    />
  );
}

function LatestQuarter({ credit }: { credit: CreditBlock }): ReactNode {
  const latest = credit.quarters[credit.quarters.length - 1];
  if (latest === undefined) {
    return (
      <EmptyState
        title="No quarterly credit metrics"
        detail="Par, fair value, yield, coverage and leverage appear once a quarter is approved."
      />
    );
  }
  const period = `Latest quarter, ${formatDate(latest.periodEnd)}`;
  return (
    <>
      <div className="pb-tiles">
        <StatTile label="Par" value={formatMoneyM(latest.parValue)} hint={period} />
        <StatTile label="Fair value" value={formatMoneyM(latest.fairValue)} hint={period} />
        <StatTile label="Current yield" value={formatPct(latest.currentYield, 2)} />
        <StatTile label="Interest coverage" value={formatMultiple(latest.interestCoverage)} />
        <StatTile
          label="Leverage through tranche"
          value={formatMultiple(latest.leverageThroughTranche)}
        />
        <StatTile label="LTV" value={formatPct(latest.loanToValue)} />
      </div>
      <p className="pb-chips">
        <Badge tone={creditStatusTone(latest.covenantStatus)}>
          Covenants: {labelOf(latest.covenantStatus)}
        </Badge>
        <Badge tone={creditStatusTone(latest.paymentStatus)}>
          Payments: {labelOf(latest.paymentStatus)}
        </Badge>
      </p>
    </>
  );
}

function ValueSeries({ credit, company }: { credit: CreditBlock; company: string }): ReactNode {
  const quarters = credit.quarters;
  const last = quarters[quarters.length - 1];
  if (last === undefined) return null;
  const numberOf = (v: string | null): number | null => (v === null ? null : Number(v));
  return (
    <LineChart
      title="Fair value and par"
      subtitle="Approved quarters"
      x={quarters.map((q) => formatMonthYearShort(q.periodEnd))}
      series={[
        { name: 'Fair value', values: quarters.map((q) => numberOf(q.fairValue)) },
        { name: 'Par', values: quarters.map((q) => numberOf(q.parValue)) },
      ]}
      kind="money"
      format={moneyLabel}
      summary={`Fair value and par for ${company} over ${quarters.length} quarters; the latest fair value is ${formatMoneyM(last.fairValue)} against par of ${formatMoneyM(last.parValue)}.`}
    />
  );
}

function AmortizationTable({ credit }: { credit: CreditBlock }): ReactNode {
  const schedule = credit.terms.amortization;
  if (schedule.length === 0) {
    return <p className="pb-meta">No scheduled amortization on record.</p>;
  }
  return (
    <TableWrap label="Amortization schedule">
      <table className="pb-table" aria-label="Amortization schedule">
        <thead>
          <tr>
            <th>Date</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {schedule.map((a, i) => (
            <tr key={`${a.date}-${i}`}>
              <td>{formatDate(a.date)}</td>
              <NumCell>{formatMoneyM(a.amount)}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function CreditPositionCard({ item }: { item: InvestmentSummary }): ReactNode {
  const q = useQuery({
    ...investmentPerformanceQuery(item.id),
    placeholderData: keepPreviousData,
  });
  let body: ReactNode;
  if (q.isPending) {
    body = <Spinner size="tiny" label={`Loading performance for ${item.companyName}`} />;
  } else if (q.isError) {
    body = <UnavailableState inline error={q.error} subject="The performance series" />;
  } else if (q.data.credit === null) {
    body = (
      <EmptyState
        title="No credit terms recorded"
        detail="This position has the private credit deal type but no facility terms on record."
      />
    );
  } else {
    const credit = q.data.credit;
    body = (
      <>
        <TermsTable credit={credit} />
        <LatestQuarter credit={credit} />
        <ValueSeries credit={credit} company={item.companyName} />
        <SectionHeader>Amortization schedule</SectionHeader>
        <AmortizationTable credit={credit} />
      </>
    );
  }
  return (
    <Card testId={`credit-${item.investmentNumber}`}>
      <SectionHeader
        aside={
          <span className="pb-meta-list">
            <span>{item.vehicleName}</span>
            <span>{item.sponsorFundName ?? item.sponsorName}</span>
            <span>
              <Link to="/portfolio/$id" params={{ id: item.id }}>
                Open one-pager
              </Link>
            </span>
          </span>
        }
      >
        {item.investmentNumber} {item.companyName}
      </SectionHeader>
      {body}
    </Card>
  );
}

export function CreditTab(): ReactNode {
  const q = useQuery({ ...investmentsQuery(CREDIT_POSITIONS), placeholderData: keepPreviousData });
  if (q.isPending) return <PageSkeleton rows={6} />;
  if (q.isError) return <UnavailableState error={q.error} subject="Credit positions" />;
  const items = q.data.items;
  return (
    <>
      <Card>
        <SectionHeader
          aside={`As of ${formatDate(q.data.asOf)}, ${items.length} ${items.length === 1 ? 'position' : 'positions'}`}
        >
          Credit book
        </SectionHeader>
        {items.length === 0 ? (
          <EmptyState
            title="No private credit positions"
            detail="Positions with the private credit deal type appear here with their terms and quarterly metrics."
          />
        ) : (
          <BookTable items={items} />
        )}
        {q.data.nextCursor !== null ? (
          <p className="pb-meta">
            Showing the first {items.length} credit positions; the full list is on the Portfolio
            grid.
          </p>
        ) : null}
      </Card>
      {items.map((item) => (
        <CreditPositionCard key={item.id} item={item} />
      ))}
    </>
  );
}
