import type { ReactNode } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { IntakeFinding, LookthroughRow, LookthroughRunDetail } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
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
import { formatDate, MISSING, plural } from '../../lib/format.js';
import { humanizeState, stagingTone } from '../../lib/states.js';
import { balanceTiles } from '../../lib/tiles.js';
import {
  candidatesText,
  dayOf,
  exactMoney,
  findingDetail,
  findingTone,
  hiddenRowsNote,
  linkNote,
  rowSubject,
} from '../intake/intake.js';
import { lookthroughRunQuery } from './lookthrough-queries.js';
import {
  approvedText,
  describeDifference,
  DIFFERENCE_LABELS,
  LOOKTHROUGH_FORBIDDEN,
  mappedLabel,
  rowExceptionsText,
  runStatusTone,
  runStatusWord,
  runSummary,
} from './lookthrough.js';
import './lookthrough.css';

function BackLink(): ReactNode {
  return (
    <p className="pb-meta">
      <Link to="/data/lookthrough">All reconcile runs</Link>
    </p>
  );
}

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

function FileFindingsCard({ findings }: { findings: readonly IntakeFinding[] }): ReactNode {
  return (
    <Card tone="error" testId="lookthrough-file-findings">
      <SectionHeader>Run findings</SectionHeader>
      <ul className="pb-lookthrough-file-findings" aria-label="Run findings">
        {findings.map((f, i) => {
          const detail = findingDetail(f);
          return (
            <li key={`${f.ruleId}-${i}`}>
              <Badge tone={findingTone(f.severity)}>{f.ruleId}</Badge>
              <span>{f.message}</span>
              {detail === null ? null : <span className="pb-meta">{detail}</span>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** The position a row is about: a link once matched, else the provider's name with why it did not link. */
function PositionCell({ row }: { row: LookthroughRow }): ReactNode {
  const subject = rowSubject(row);
  const note = linkNote(row.link);
  const candidates = candidatesText(row.link.candidates);
  const name = subject.companyName ?? MISSING;
  return (
    <td className="pb-lookthrough-position">
      {row.link.status === 'matched' && row.link.investmentId !== null ? (
        <Link to="/portfolio/$id" params={{ id: row.link.investmentId }}>
          {name}
        </Link>
      ) : (
        <span>{name}</span>
      )}
      <span className="pb-cell-sub">
        {subject.investmentNumber === null ? null : (
          <span className="pb-key">{subject.investmentNumber}</span>
        )}
        {note === null ? null : (
          <Badge plain tone="watch">
            {note}
          </Badge>
        )}
      </span>
      {candidates === null ? null : <span className="pb-lookthrough-lines">{candidates}</span>}
    </td>
  );
}

/** The provider's figure with the record's beneath it, both to the cent. */
function ExposureCell({
  provider,
  approved,
}: {
  provider: string;
  approved: string | null;
}): ReactNode {
  return (
    <td className="num pb-lookthrough-exposure">
      <span>{exactMoney(provider)}</span>
      <span className="pb-lookthrough-lines">record {approvedText(approved)}</span>
    </td>
  );
}

function DifferencesCell({ row }: { row: LookthroughRow }): ReactNode {
  if (row.differences.length === 0) {
    return (
      <td>
        <span className="pb-meta">None</span>
      </td>
    );
  }
  return (
    <td>
      <span className="pb-lookthrough-badges">
        {row.differences.map((d) => (
          <span key={d.field} title={describeDifference(d)}>
            <Badge tone="watch">{DIFFERENCE_LABELS[d.field]}</Badge>
          </span>
        ))}
      </span>
      <span className="pb-lookthrough-lines">
        {row.differences.map((d) => (
          <span key={d.field}>{describeDifference(d)}</span>
        ))}
      </span>
    </td>
  );
}

function FindingsCell({ findings }: { findings: readonly IntakeFinding[] }): ReactNode {
  if (findings.length === 0) {
    return (
      <td>
        <span className="pb-meta">None</span>
      </td>
    );
  }
  return (
    <td>
      <span className="pb-lookthrough-badges">
        {findings.map((f, i) => (
          <span key={`${f.ruleId}-${i}`} title={f.message}>
            <Badge tone={findingTone(f.severity)}>{f.ruleId}</Badge>
          </span>
        ))}
      </span>
      <details className="pb-lookthrough-details">
        <summary>{plural(findings.length, 'finding')}</summary>
        <ul className="pb-list">
          {findings.map((f, i) => {
            const detail = findingDetail(f);
            return (
              <li key={`${f.ruleId}-${i}`}>
                {f.ruleId}: {f.message}
                {detail === null ? '' : ` (${detail})`}
              </li>
            );
          })}
        </ul>
      </details>
    </td>
  );
}

function RowsTable({ rows }: { rows: readonly LookthroughRow[] }): ReactNode {
  return (
    <TableWrap label="Reconciled positions">
      <table
        className="pb-table pb-lookthrough-rows"
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
                <PositionCell row={row} />
                <td>{mappedLabel(row.provider.sector, row.mapped.sector)}</td>
                <td>{mappedLabel(row.provider.geography, row.mapped.geography)}</td>
                <ExposureCell
                  provider={row.provider.exposureAtNav}
                  approved={row.approved.exposureAtNav}
                />
                <ExposureCell
                  provider={row.provider.exposureAtCost}
                  approved={row.approved.exposureAtCost}
                />
                <DifferencesCell row={row} />
                <FindingsCell findings={row.findings} />
                <td>
                  <Badge tone={stagingTone(row.status)}>{humanizeState(row.status)}</Badge>
                  {exceptions === null ? null : (
                    <span className="pb-lookthrough-lines">{exceptions}</span>
                  )}
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
      <BackLink />
      <PageHeader
        title={run.fileName}
        meta={
          <span className="pb-meta-list">
            <span>As of {formatDate(run.asOf)}</span>
            <span>Reconciled {dayOf(run.receivedAt)}</span>
            <span>By {run.receivedBy ?? MISSING}</span>
            <span>{plural(run.rowCount, 'row')}</span>
          </span>
        }
        actions={<Badge tone={runStatusTone(run.status)}>{runStatusWord(run.status)}</Badge>}
        testId="lookthrough-banner"
      />
      {duplicate ? (
        <p className="pb-notice" data-testid="lookthrough-duplicate">
          This extract was reconciled before. The run is shown as it stands; nothing new was staged.
        </p>
      ) : null}
      <Tiles run={run} />
      {run.fileFindings.length > 0 ? <FileFindingsCard findings={run.fileFindings} /> : null}
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
        <BackLink />
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
