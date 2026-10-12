import type { ReactNode } from 'react';
import type { InvestmentDetail } from '@pb/contracts';
import {
  Badge,
  Card,
  KeyValueTable,
  NumCell,
  PageSkeleton,
  SectionHeader,
  TableWrap,
} from '../components/ui.js';
import {
  formatDate,
  formatMoneyM,
  formatMultiple,
  formatPct,
  labelOf,
  MISSING,
} from '../lib/format.js';
import { creditStatusTone } from '../lib/labels.js';
import { humanizeState, valuationTone } from '../lib/states.js';
import { useDealDetail } from './deal/data.js';

function OperatingTable({ detail }: { detail: InvestmentDetail }): ReactNode {
  const o = detail.operating;
  if (o === null) return <p>No approved quarterly financials for this position.</p>;
  // The prior year is the same fiscal quarter a year earlier, exactly, or nothing (docs/08 section 5).
  const p = o.priorYear;
  const rows: [string, string, string, string][] = [
    [
      'Revenue (LTM)',
      formatMoneyM(o.revenueLtm),
      formatMoneyM(p?.revenueLtm),
      formatPct(o.revenueYoy),
    ],
    ['EBITDA (LTM)', formatMoneyM(o.ebitdaLtm), formatMoneyM(p?.ebitdaLtm), formatPct(o.ebitdaYoy)],
    ['EBITDA margin', formatPct(o.ebitdaMargin), formatPct(p?.ebitdaMargin), MISSING],
    ['Enterprise value', formatMoneyM(o.ev), formatMoneyM(p?.ev), MISSING],
    ['EV / EBITDA', formatMultiple(o.evToEbitda), formatMultiple(p?.evToEbitda), MISSING],
    [
      'Net debt / EBITDA',
      formatMultiple(o.netDebtToEbitda),
      formatMultiple(p?.netDebtToEbitda),
      MISSING,
    ],
  ];
  return (
    <TableWrap label="Financial performance">
      <table className="pb-table" aria-label="Financial performance">
        <thead>
          <tr>
            <th>Metric</th>
            <th className="num">LTM / Current ({formatDate(o.periodEnd)})</th>
            <th className="num">
              Prior year ({p === null ? 'not on record' : formatDate(p.periodEnd)})
            </th>
            <th className="num">YoY</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([metric, current, prior, yoy]) => (
            <tr key={metric}>
              <td>{metric}</td>
              <NumCell>{current}</NumCell>
              <NumCell>{prior}</NumCell>
              <NumCell>{yoy}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
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

/**
 * Overview tab: the one-pager body (docs/06 section 2). The banner and the stat tiles sit in
 * DealWorkspace so every tab shares them; the workspace also owns the loading and not-found states
 * and renders this tab only once the position has loaded.
 */
export function InvestmentDetailPage(): ReactNode {
  const q = useDealDetail();
  if (q.data === undefined) return q.isPending ? <PageSkeleton rows={6} /> : null;
  const d = q.data;
  const isCredit = d.credit !== null;
  return (
    <>
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
        <TableWrap label="Valuations">
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
        </TableWrap>
      </Card>
      <Card>
        <SectionHeader>Cash flows</SectionHeader>
        <TableWrap label="Cash flows">
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
        </TableWrap>
      </Card>
    </>
  );
}
