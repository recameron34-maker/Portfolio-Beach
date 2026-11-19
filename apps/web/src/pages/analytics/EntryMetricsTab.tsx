import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EntryCohort } from '@pb/contracts';
import { HorizontalBars, ScatterChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Card,
  EmptyState,
  NumCell,
  PageContext,
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
import { hasFilters } from './value-creation-filters.js';
import { shownView } from './value-creation-view.js';
import type { ShownView } from './value-creation-view.js';
import { useValueCreationFilters } from './useValueCreationFilters.js';
import { ValueCreationFilterBar } from './ValueCreationFilterBar.js';
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
      <SectionHeader aside={`${measure} bands`}>{heading}</SectionHeader>
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

function EntryScatterCard({ view }: { view: ShownView }): ReactNode {
  const { points, leftOut, seriesNames } = entryMultiplePoints(view);
  return (
    <Card testId="entry-scatter-card">
      {/* The scatter is the section's chart, so its title is the section's. */}
      <SectionHeader aside="One mark per company, coloured by entry net leverage band">
        Entry purchase multiple against gross MOIC
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
            hideCaption
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
 * MOIC. The bands and their labels come from the response; the page restates none. The filters
 * narrow the positions, and each cohort is pooled again over the rows that pass (count, invested,
 * NAV, MOIC, IRR and EBITDA growth) by the rule the API pools the whole book by
 * (value-creation-view.ts).
 */
export function EntryMetricsTab(): ReactNode {
  const q = useQuery({ ...valueCreationQuery, placeholderData: keepPreviousData });
  const [filters, setFilters] = useValueCreationFilters();
  const view = q.data;
  const shown = useMemo(
    () => (view === undefined ? null : shownView(view, filters)),
    [view, filters],
  );
  if (q.isPending) return <PageSkeleton rows={8} />;
  if (q.isError) return <UnavailableState card error={q.error} subject="Entry metrics" />;
  if (view === undefined || shown === null) return null;
  const left = leftOutText(view.leftOut);
  if (view.positions.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No equity or continuation vehicle positions"
          detail={`Entry metrics are measured for equity co-investments and continuation vehicles visible to you, as of ${formatDate(view.asOf)}.${left === null ? '' : ` ${left}`}`}
        />
      </Card>
    );
  }
  const context = (
    <PageContext
      items={[
        `As of ${formatDate(view.asOf)}`,
        'Equity and continuation vehicle positions visible to you',
        hasFilters(filters)
          ? 'Active and realized, narrowed by the filters below'
          : 'Active and realized',
      ]}
      note={`The entry figures are those of each position's approved entry snapshot.${left === null ? '' : ` ${left}`}`}
    />
  );
  const bar = (
    <ValueCreationFilterBar
      positions={view.positions}
      shown={shown.positions.length}
      filters={filters}
      onChange={setFilters}
    />
  );
  if (shown.positions.length === 0) {
    return (
      <>
        {context}
        {bar}
        <Card testId="entry-metrics-no-match">
          <EmptyState
            title="No position matches these filters"
            detail="Pick another vehicle, sponsor, sector, deal type, entry year or status, or clear the filters."
          />
        </Card>
      </>
    );
  }
  return (
    <>
      {context}
      {bar}
      <CohortCard
        heading="By entry purchase multiple"
        metric="entry purchase multiple"
        measure="Entry EV / EBITDA"
        cohorts={shown.cohorts.byEntryMultiple}
        testId="entry-multiple"
      />
      <CohortCard
        heading="By entry net leverage"
        metric="entry net leverage"
        measure="Entry net debt / EBITDA"
        cohorts={shown.cohorts.byEntryLeverage}
        testId="entry-leverage"
      />
      <EntryScatterCard view={shown} />
    </>
  );
}
