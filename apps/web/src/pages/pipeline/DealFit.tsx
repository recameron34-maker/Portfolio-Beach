import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OpportunityDetail, OpportunityFit } from '@pb/contracts';
import { previewMode } from '../../app/env.js';
import { RadarChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import { Badge, Card, RowsSkeleton, SectionHeader } from '../../components/ui.js';
import { formatDate, MISSING } from '../../lib/format.js';
import { opportunityFitQuery } from './api.js';
import { fitRows, fitSummary } from './deal-fit.js';
import type { FitRow } from './deal-fit.js';

/** Why a deal created in the static preview has no fit: the scores are the API's, and none was recorded for it. */
const PREVIEW_ONLY = {
  title: 'Portfolio fit: not worked out in this preview',
  detail:
    'The scores are worked out on the server from the portfolio. A deal created in this preview has none.',
};

function Measure({
  row,
  index,
  active,
  onActive,
}: {
  row: FitRow;
  /** The measure's place among the radar's axes, so its bar fills as its point lands. */
  index: number;
  active: boolean;
  onActive: (key: string | null) => void;
}): ReactNode {
  return (
    <li
      className={`pb-fit-measure${active ? ' is-active' : ''}`}
      data-measure={row.key}
      style={{ '--pb-radar-i': index } as CSSProperties}
      onPointerEnter={() => onActive(row.key)}
      onPointerLeave={() => onActive(null)}
    >
      <div className="pb-fit-head">
        <span className="pb-fit-name">{row.name}</span>
        <span className="pb-fit-score">
          {row.value === null ? (
            <>
              <span aria-hidden="true">{MISSING}</span>
              <span className="pb-visually-hidden">No score</span>
            </>
          ) : (
            <>
              {row.display}
              <span className="pb-visually-hidden"> of 100</span>
            </>
          )}
        </span>
      </div>
      <div className="pb-fit-meter" aria-hidden="true">
        {row.value === null ? null : <span style={{ width: `${row.value}%` }} />}
      </div>
      <p className="pb-fit-basis">{row.basis}</p>
      <p className="pb-fit-rule">{row.rule}</p>
    </li>
  );
}

function FitBody({ fit, detail }: { fit: OpportunityFit; detail: OpportunityDetail }): ReactNode {
  const [active, setActive] = useState<string | null>(null);
  const rows = fitRows(fit, {
    sponsorName: detail.sponsor.name,
    fundName: detail.sponsorFund?.name ?? null,
    dealType: detail.dealType,
  });
  const summary = fitSummary(rows);
  return (
    <>
      <p className="pb-meta pb-fit-lead" data-testid="opportunity-fit-lead">
        Against the portfolio you can see, as of {formatDate(fit.asOf)}. Each measure runs from 0 to
        100 and higher is a better fit. {summary}
      </p>
      <div className="pb-fit">
        <div className="pb-fit-chart">
          <RadarChart
            title="Fit by measure"
            subtitle="0 at the centre, 100 at the rim"
            axes={rows.map((r) => ({
              key: r.key,
              label: r.axis,
              value: r.value,
              display: r.display,
              note: r.basis,
            }))}
            summary={summary}
            valueColumn="Score"
            activeKey={active}
            onActive={setActive}
            testId="opportunity-fit-chart"
          />
          <p className="pb-meta pb-fit-note">
            A draft set of measures: the rules and every threshold are configuration, and none of
            them is a recommendation. A measure whose figure is not recorded has no score.
          </p>
        </div>
        <ul className="pb-fit-list" aria-label="Fit measures">
          {rows.map((row, i) => (
            <Measure
              key={row.key}
              row={row}
              index={i}
              active={active === row.key}
              onActive={setActive}
            />
          ))}
        </ul>
      </div>
    </>
  );
}

/** The "Portfolio fit" card of an opportunity: the radar chart and the reading of each measure. */
export function DealFitCard({ detail }: { detail: OpportunityDetail }): ReactNode {
  const fit = useQuery(opportunityFitQuery(detail.id));
  return (
    <Card testId="opportunity-fit">
      <SectionHeader aside={<Badge plain>Draft measures</Badge>}>Portfolio fit</SectionHeader>
      {fit.isPending ? (
        <RowsSkeleton rows={3} label="Loading portfolio fit" />
      ) : fit.isError ? (
        <UnavailableState
          error={fit.error}
          subject="Portfolio fit"
          inline
          notReady={previewMode ? PREVIEW_ONLY : undefined}
          testId="opportunity-fit-unavailable"
        />
      ) : (
        <FitBody fit={fit.data} detail={detail} />
      )}
    </Card>
  );
}
