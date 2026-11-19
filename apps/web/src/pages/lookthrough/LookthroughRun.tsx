import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { LookthroughRow, LookthroughRunDetail } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Breadcrumbs,
  Card,
  EmptyState,
  ErrorState,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
} from '../../components/ui.js';
import { formatDate, labelOf, MISSING, plural } from '../../lib/format.js';
import { humanizeState, stagingTone } from '../../lib/states.js';
import { balanceTiles } from '../../lib/tiles.js';
import { dayOf, exactMoney, hiddenRowsNote } from '../intake/intake.js';
import { FileFindingsCard, FindingsCell, SubjectCell } from '../intake/IntakeFile.js';
import { lookthroughRunQuery } from './lookthrough-queries.js';
import {
  approvedText,
  describeDifference,
  DIFFERENCE_LABELS,
  LOOKTHROUGH_FORBIDDEN,
  rowExceptionsText,
  runStatusTone,
  runStatusWord,
  runSummary,
} from './lookthrough.js';
import './lookthrough.css';

/** Where a run's page sits: under Look-through. */
const CRUMBS = [{ label: 'Look-through', to: '/data/lookthrough' }];

function Tiles({ run }: { run: LookthroughRunDetail }): ReactNode {
  const s = runSummary(run);
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="lookthrough-tiles">
      <StatTile label="Rows" value={String(s.rows)} hint="Positions in the extract" />
      <StatTile label="Matched" value={String(s.matched)} hint="Linked to a position you can see" />
      <StatTile
        label="Differences"
        value={String(s.differences)}
        hint="Codes or exposures that disagree with the record"
        tone={s.differences > 0 ? 'watch' : undefined}
      />
      <StatTile
        label="Exceptions"
        value={String(s.exceptions)}
        hint="Opened for a person; nothing on record changed"
        tone={s.exceptions > 0 ? 'watch' : undefined}
      />
    </div>
  );
}

/**
 * What the provider called a sector or a geography, and the taxonomy term it maps to when that
 * reads differently ("maps to Software"); a label the mapping does not know is marked "Not mapped".
 */
function MappedCell({ label, code }: { label: string; code: string | null }): ReactNode {
  const term = code === null ? null : labelOf(code);
  return (
    <td>
      <span className="pb-nowrap">{label}</span>
      {code === null ? (
        <span className="pb-cell-sub">
          <Badge tone="watch">Not mapped</Badge>
        </span>
      ) : term === label ? null : (
        <span className="pb-cell-sub">maps to {term}</span>
      )}
    </td>
  );
}

/** The provider's figure with the record's beneath it, both to the cent; a watch dot when they differ. */
function ExposureCell({
  provider,
  approved,
  differs,
}: {
  provider: string;
  approved: string | null;
  differs: boolean;
}): ReactNode {
  return (
    <td className="num">
      <span className="pb-lookthrough-figure">
        {differs ? (
          <span className="pb-lookthrough-differs" title="Differs from the record">
            <span className="pb-visually-hidden">Differs from the record: </span>
          </span>
        ) : null}
        {exactMoney(provider)}
      </span>
      <span className="pb-cell-sub">record {approvedText(approved)}</span>
    </td>
  );
}

/** The fields that disagree with the record, in words; each one's title says both sides. */
function DifferencesCell({ row }: { row: LookthroughRow }): ReactNode {
  if (row.differences.length === 0) {
    return (
      <td>
        <span className="pb-meta">None</span>
      </td>
    );
  }
  // The words show; a screen reader hears each difference as its sentence instead.
  return (
    <td>
      <span aria-hidden="true">
        {row.differences.map((d, i) => (
          <Fragment key={d.field}>
            {i === 0 ? null : ', '}
            <span title={describeDifference(d)}>{DIFFERENCE_LABELS[d.field]}</span>
          </Fragment>
        ))}
      </span>
      {row.differences.map((d) => (
        <span key={d.field} className="pb-visually-hidden">
          {describeDifference(d)}
        </span>
      ))}
    </td>
  );
}

function RowsTable({ rows }: { rows: readonly LookthroughRow[] }): ReactNode {
  return (
    <TableWrap label="Reconciled positions">
      <table
        className="pb-table pb-hold-2 pb-lookthrough-rows"
        aria-label="Reconciled positions"
        data-testid="lookthrough-rows"
      >
        <thead>
          <tr>
            <th className="num">Row</th>
            <th>Position</th>
            <th>Sector</th>
            <th>Geography</th>
            <th className="num">NAV</th>
            <th className="num">Cost</th>
            <th>Differences</th>
            <th>Findings</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const exceptions = rowExceptionsText(row);
            return (
              <tr key={row.id}>
                <NumCell>{String(row.rowNo)}</NumCell>
                <SubjectCell row={row} />
                <MappedCell label={row.provider.sector} code={row.mapped.sector} />
                <MappedCell label={row.provider.geography} code={row.mapped.geography} />
                <ExposureCell
                  provider={row.provider.exposureAtNav}
                  approved={row.approved.exposureAtNav}
                  differs={row.differences.some((d) => d.field === 'exposureAtNav')}
                />
                <ExposureCell
                  provider={row.provider.exposureAtCost}
                  approved={row.approved.exposureAtCost}
                  differs={row.differences.some((d) => d.field === 'exposureAtCost')}
                />
                <DifferencesCell row={row} />
                <FindingsCell findings={row.findings} />
                <td>
                  <Badge tone={stagingTone(row.status)}>{humanizeState(row.status)}</Badge>
                  {exceptions === null ? null : <span className="pb-cell-sub">{exceptions}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

function RowsCard({ run }: { run: LookthroughRunDetail }): ReactNode {
  const hidden = hiddenRowsNote(run.hiddenRows);
  return (
    <Card testId="lookthrough-rows-card">
      <SectionHeader
        aside={
          run.exceptions > 0 ? (
            <Link
              to="/data/exceptions"
              search={{ file: run.id }}
              data-testid="lookthrough-exceptions-link"
            >
              {plural(run.exceptions, 'exception')} on the queue
            </Link>
          ) : (
            plural(run.rows.length, 'row')
          )
        }
      >
        Reconciled positions
      </SectionHeader>
      {hidden === null ? null : (
        <p className="pb-notice" data-testid="lookthrough-hidden-rows">
          {hidden}
        </p>
      )}
      {run.rowCount === 0 ? (
        <EmptyState
          title="No rows were reconciled"
          detail="The look-through folder holds no extract for this date; the run findings above say so."
          testId="lookthrough-no-rows"
        />
      ) : run.rows.length === 0 ? (
        <EmptyState
          title="Every row in this run is linked to positions you cannot see"
          detail="The tiles above count every row in the run. Someone with access to those positions reads them."
          testId="lookthrough-no-rows"
        />
      ) : (
        <RowsTable rows={run.rows} />
      )}
    </Card>
  );
}

function RunBody({ run, duplicate }: { run: LookthroughRunDetail; duplicate: boolean }): ReactNode {
  return (
    <>
      <PageHeader
        crumbs={CRUMBS}
        title={run.fileName}
        meta={
          <span className="pb-meta-list">
            <span>
              <Badge tone={runStatusTone(run.status)}>{runStatusWord(run.status)}</Badge>
            </span>
            <span>As of {formatDate(run.asOf)}</span>
            <span>Reconciled {dayOf(run.receivedAt)}</span>
            <span>By {run.receivedBy ?? MISSING}</span>
            <span>{plural(run.rowCount, 'row')}</span>
          </span>
        }
        testId="lookthrough-banner"
      />
      {duplicate ? (
        <p className="pb-notice" data-testid="lookthrough-duplicate">
          This extract was reconciled before. The run is shown as it stands; nothing new was staged.
        </p>
      ) : null}
      <Tiles run={run} />
      {run.fileFindings.length > 0 ? (
        <FileFindingsCard
          findings={run.fileFindings}
          title="Run findings"
          testId="lookthrough-file-findings"
        />
      ) : null}
      <RowsCard run={run} />
    </>
  );
}

/**
 * One reconcile run (docs/04 M2, decision 0010): every provider row with the position it linked
 * to, what the mapping made of its labels, its exposures against the record's and its differences.
 * There are no commands on a run; differences are worked on the exceptions page.
 */
export function LookthroughRunPage(): ReactNode {
  const { id } = useParams({ from: '/app/data/lookthrough/$id' });
  const { duplicate } = useSearch({ from: '/app/data/lookthrough/$id' });
  const q = useQuery(lookthroughRunQuery(id));
  if (q.isPending) return <PageSkeleton tiles={4} rows={8} />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <>
        <Breadcrumbs items={CRUMBS} />
        {missing ? (
          <ErrorState
            title="Reconcile run not found or not visible to you"
            detail="There is no reconcile run with this id in your view."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This reconcile run"
            forbidden={LOOKTHROUGH_FORBIDDEN}
            errorTitle="Reconcile run unavailable"
            testId="lookthrough-run-unavailable"
          />
        )}
      </>
    );
  }
  return <RunBody run={q.data} duplicate={duplicate === true} />;
}
