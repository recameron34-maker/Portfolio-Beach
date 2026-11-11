import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EntryCohort, ValueCreation } from '@pb/contracts';
import { HorizontalBars, ScatterChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Card,
  EmptyState,
  NumCell,
  PageSkeleton,
  SectionHeader,
  TableWrap,
} from '../../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatPct,
  irrDisplay,
  plural,
} from '../../lib/format.js';
import { valueCreationQuery } from './value-creation-queries.js';
import { entryMultiplePoints, leftOutText, listedCohorts, moicBars } from './value-creation.js';
import './analytics.css';

/** The cohorts of one entry metric: MOIC as bars, then count, invested, NAV, distributions, IRR and EBITDA growth. */
function CohortCard({
  heading,
  metric,
  measure,
  cohorts,
  testId,
}: {
  /** "By entry purchase multiple". */
  heading: string;
  /** "entry purchase multiple": the words the chart and the table are named with. */
  metric: string;
  /** "Entry EV / EBITDA": how the band is measured. */
  measure: string;
  cohorts: readonly EntryCohort[];
  testId: string;
}): ReactNode {
  const bars = moicBars(cohorts);
  const best = [...bars].sort((a, b) => b.value - a.value)[0];
  return (
    <Card testId={testId}>
      <SectionHeader aside={`${measure}, bands from configuration`}>{heading}</SectionHeader>
      {best === undefined ? (
        <EmptyState
          title="No band has a MOIC"
          detail="A band's MOIC needs invested capital and a Locked valuation for every position it holds."
        />
      ) : (
        <HorizontalBars
          title={`Gross MOIC by ${metric}`}
          subtitle="Pooled over the positions of each band"
          data={bars}
          kind="multiple"
          valueColumn="Gross MOIC"
          summary={`Pooled gross MOIC by ${metric} band across ${plural(bars.length, 'band')}; the highest is ${best.label} at ${best.display}.`}
          testId={`${testId}-bars`}
        />
      )}
      <TableWrap label={`Performance by ${metric}`}>
        <table className="pb-table" aria-label={`Performance by ${metric}`}>
          <thead>
            <tr>
              <th>{measure}</th>
              <th className="num">Positions</th>
              <th className="num">Invested</th>
              <th className="num">NAV</th>
              <th className="num">Distributions</th>
              <th className="num">Gross MOIC</th>
              <th className="num">Gross IRR</th>
              <th className="num">EBITDA growth</th>
            </tr>
          </thead>
          <tbody>
            {listedCohorts(cohorts).map((c) => (
              <tr key={c.key}>
                <td>{c.label}</td>
                <td className="num">{c.count}</td>
                <NumCell>{formatMoneyM(c.invested)}</NumCell>
                <NumCell>{formatMoneyM(c.nav)}</NumCell>
                <NumCell>{formatMoneyM(c.distributions)}</NumCell>
                <NumCell>{formatMoic(c.grossMoic)}</NumCell>
                <NumCell>{irrDisplay(c)}</NumCell>
                <NumCell>{formatPct(c.ebitdaGrowth)}</NumCell>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <p className="pb-meta pb-analytics-note">
        MOIC and IRR are pooled over each band&apos;s positions; EBITDA growth since entry is
        weighted by invested capital.
      </p>
    </Card>
  );
}

function EntryScatterCard({ view }: { view: ValueCreation }): ReactNode {
  const { points, leftOut, seriesNames } = entryMultiplePoints(view);
  return (
    <Card testId="entry-scatter-card">
      <SectionHeader aside="One mark per company, coloured by entry net leverage band">
        Entry multiple and outcome
      </SectionHeader>
      {points.length === 0 ? (
        <EmptyState
          title="No position has both figures"
          detail="The chart needs an entry purchase multiple and a gross MOIC for a position."
        />
      ) : (
        <>
          <ScatterChart
            title="Entry purchase multiple against gross MOIC"
            subtitle="Entry EV / EBITDA across, gross MOIC up"
            points={points}
            xLabel="Entry EV / EBITDA"
            yLabel="Gross MOIC"
            xKind="multiple"
            yKind="multiple"
            seriesNames={seriesNames}
            seriesLabel="Entry net leverage"
            summary={`Entry purchase multiple against gross MOIC for ${plural(points.length, 'position')}, in ${plural(seriesNames.length, 'entry net leverage band')}.`}
            testId="entry-scatter"
          />
          {leftOut > 0 ? (
            <p className="pb-meta pb-analytics-note">
              {`${plural(leftOut, 'position')} ${leftOut === 1 ? 'has' : 'have'} no entry multiple or no MOIC and ${leftOut === 1 ? 'is' : 'are'} not plotted.`}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * Analytics, Entry metrics (docs/04 M13, docs/08 section 8): performance by entry purchase
 * multiple band and by entry net leverage band, and each company's entry multiple against its
 * MOIC. The bands, their labels and every figure come from the response; the page restates none.
 */
export function EntryMetricsTab(): ReactNode {
  const q = useQuery({ ...valueCreationQuery, placeholderData: keepPreviousData });
  if (q.isPending) return <PageSkeleton rows={8} />;
  if (q.isError) return <UnavailableState card error={q.error} subject="Entry metrics" />;
  const view = q.data;
  const left = leftOutText(view.leftOut);
  if (view.positions.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No equity or continuation vehicle positions"
          detail={`Entry metrics are measured for equity co-investments and continuation vehicles you are entitled to see, as of ${formatDate(view.asOf)}.${left === null ? '' : ` ${left}`}`}
        />
      </Card>
    );
  }
  return (
    <>
      <CohortCard
        heading="By entry purchase multiple"
        metric="entry purchase multiple"
        measure="Entry EV / EBITDA"
        cohorts={view.cohorts.byEntryMultiple}
        testId="entry-multiple"
      />
      <CohortCard
        heading="By entry net leverage"
        metric="entry net leverage"
        measure="Entry net debt / EBITDA"
        cohorts={view.cohorts.byEntryLeverage}
        testId="entry-leverage"
      />
      <EntryScatterCard view={view} />
      <p className="pb-meta">
        As of {formatDate(view.asOf)}, over the equity and continuation vehicle positions you are
        entitled to see, active and realized; the entry figures are those of each position&apos;s
        approved entry snapshot.{left === null ? '' : ` ${left}`}
      </p>
    </>
  );
}
