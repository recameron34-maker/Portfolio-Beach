import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Input, Label, Option } from '@fluentui/react-components';
import { ArrowDownload16Regular } from '@fluentui/react-icons';
import type { MonitoringBoard, MonitoringBoardRow } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { PORTFOLIO_TABS } from '../../app/nav.js';
import {
  fetchMonitoringExport,
  investmentsQuery,
  monitoringBoardQuery,
} from '../../app/queries.js';
import type { MonitoringBoardFilters } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { ActionStatus } from '../../components/WorkflowActions.js';
import { formatDate, labelOf, MISSING, plural } from '../../lib/format.js';
import { balanceTiles } from '../../lib/tiles.js';
import { useActionLog } from '../../lib/workflow.js';
import {
  ageLabel,
  approvalTone,
  approvalWord,
  approvedOnText,
  csvRowCount,
  documentStatusTone,
  documentStatusWord,
  downloadText,
  dueLabel,
  exportFileName,
  exportResult,
  flagsText,
  isAsOfDate,
  MONITORING_META,
  periodOptions,
  quarterLabel,
  runStateTone,
  runStateWord,
  thresholdsLine,
} from './monitoring.js';
import './monitoring.css';

function Tiles({ counts }: { counts: MonitoringBoard['counts'] }): ReactNode {
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="monitoring-tiles">
      <StatTile
        label="Expected"
        value={String(counts.expected)}
        hint="Not yet due, or within the grace period"
      />
      <StatTile
        label="Received"
        value={String(counts.received)}
        hint="A report is on file for the quarter"
        tone={counts.received > 0 ? 'good' : undefined}
      />
      <StatTile
        label="Late"
        value={String(counts.late)}
        hint="Past the grace period after the due date"
        tone={counts.late > 0 ? 'watch' : undefined}
      />
      <StatTile
        label="Missing"
        value={String(counts.missing)}
        hint="Past the missing threshold"
        tone={counts.missing > 0 ? 'bad' : undefined}
      />
      <StatTile
        label="In review"
        value={String(counts.inReview)}
        hint="An extraction run awaits approval"
        tone={counts.inReview > 0 ? 'watch' : undefined}
      />
      <StatTile
        label="Approved"
        value={String(counts.approved)}
        hint="Figures promoted into the record"
        tone={counts.approved > 0 ? 'good' : undefined}
      />
    </div>
  );
}

/** The expected report: its status, its due date and age, and the document on file when one is. */
function DocumentCell({ row }: { row: MonitoringBoardRow }): ReactNode {
  const due = dueLabel(row.dueDate);
  const age = ageLabel(row.documentStatus, row.ageDays);
  return (
    <td className="pb-monitoring-status">
      <Badge tone={documentStatusTone(row.documentStatus)}>
        {documentStatusWord(row.documentStatus)}
      </Badge>
      <span className="pb-monitoring-lines">
        <span>{due ?? 'No due date yet'}</span>
        {age === null ? null : <span>{age}</span>}
        {row.documentId === null ? null : (
          <Link
            to="/documents/$id"
            params={{ id: row.documentId }}
            aria-label={`Document, ${row.companyName}`}
          >
            Document
          </Link>
        )}
      </span>
    </td>
  );
}

/** The latest extraction run of the position for the quarter, with a link to its review. */
function RunCell({ row }: { row: MonitoringBoardRow }): ReactNode {
  return (
    <td>
      {row.runState === null ? (
        <span className="pb-meta">{MISSING}</span>
      ) : (
        <Badge tone={runStateTone(row.runState)}>{runStateWord(row.runState)}</Badge>
      )}
      {row.runId === null ? null : (
        <span className="pb-monitoring-lines">
          <Link
            to="/documents/extraction/$id"
            params={{ id: row.runId }}
            aria-label={`Run, ${row.companyName}`}
          >
            Run
          </Link>
        </span>
      )}
    </td>
  );
}

/** The approval the quarter has reached; an approved quarter without a recorded time shows the placeholder. */
function ApprovalCell({ row }: { row: MonitoringBoardRow }): ReactNode {
  return (
    <td>
      <Badge tone={approvalTone(row.approval)}>{approvalWord(row.approval)}</Badge>
      {row.approval === 'approved' ? (
        <span className="pb-monitoring-lines">
          <span>{approvedOnText(row.approvedAt)}</span>
        </span>
      ) : null}
    </td>
  );
}

function BoardTable({ rows }: { rows: readonly MonitoringBoardRow[] }): ReactNode {
  return (
    <TableWrap label="Monitoring board">
      <table className="pb-table pb-monitoring-table" aria-label="Monitoring board">
        <thead>
          <tr>
            <th>Inv #</th>
            <th>Company</th>
            <th>Vehicle</th>
            <th>Sponsor fund</th>
            <th>Deal type</th>
            <th>Report</th>
            <th>Run</th>
            <th className="num">Flags</th>
            <th>Approval</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.investmentId}>
              <td>
                <span className="pb-key">{row.investmentNumber}</span>
              </td>
              <td className="pb-monitoring-company">
                <Link to="/portfolio/$id" params={{ id: row.investmentId }}>
                  {row.companyName}
                </Link>
              </td>
              <td>{row.vehicleName}</td>
              <td>{row.sponsorFundName ?? MISSING}</td>
              <td>{labelOf(row.dealType)}</td>
              <DocumentCell row={row} />
              <RunCell row={row} />
              <NumCell>{flagsText(row)}</NumCell>
              <ApprovalCell row={row} />
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * The monitoring board (docs/04 M9, decision 0012): one row per position held on the quarter end,
 * under the Portfolio tabs. The quarter and the as-of day are the API's unless the reader picks
 * them; the rows are what the reader's row-level security allows, so a walled position is absent
 * for a non-member, never counted. The export is the same rows as CSV, fetched with the reader's
 * credential and offered as a file.
 */
export function MonitoringPage(): ReactNode {
  const [period, setPeriod] = useState<string | undefined>(undefined);
  // null until the reader types: the control then shows the board's own as-of day.
  const [asOfInput, setAsOfInput] = useState<string | null>(null);
  const filters: MonitoringBoardFilters = {
    ...(period === undefined ? {} : { periodEnd: period }),
    ...(asOfInput !== null && isAsOfDate(asOfInput) ? { asOf: asOfInput.trim() } : {}),
  };
  const board = useQuery({ ...monitoringBoardQuery(filters), placeholderData: keepPreviousData });
  // The quarters a reader may pick span the positions held: from the earliest entry to the as-of day.
  const positions = useQuery(investmentsQuery({ active: 'true', limit: 100 }));
  const log = useActionLog();
  const exporter = useMutation({
    mutationFn: (f: MonitoringBoardFilters) => fetchMonitoringExport(f),
  });

  if (board.isPending) return <PageSkeleton tiles={6} rows={8} />;

  const data = board.data;
  const exportCsv = (): void => {
    if (data === undefined) return;
    const fileName = exportFileName(data.periodEnd);
    exporter.mutate(filters, {
      onSuccess: (csv) => {
        downloadText(fileName, csv, 'text/csv');
        log.record('good', exportResult(csvRowCount(csv), fileName));
      },
      onError: (error) => log.record('bad', `Export CSV: ${describeActionError(error)}`),
    });
  };

  return (
    <>
      <PageHeader
        title="Monitoring"
        meta={
          data === undefined
            ? MONITORING_META
            : `Quarter ended ${formatDate(data.periodEnd)}, judged as of ${formatDate(data.asOf)}. ${MONITORING_META}.`
        }
        actions={
          <Button
            size="small"
            appearance="outline"
            icon={<ArrowDownload16Regular />}
            data-testid="monitoring-export"
            disabled={data === undefined || exporter.isPending}
            onClick={exportCsv}
          >
            Export CSV
          </Button>
        }
      />
      <TabNav label="Portfolio" items={PORTFOLIO_TABS} />
      {board.isError || data === undefined ? (
        <UnavailableState
          card
          error={board.error}
          subject="The monitoring board"
          errorTitle="Monitoring board unavailable"
          testId="monitoring-unavailable"
        />
      ) : (
        <>
          <Tiles counts={data.counts} />
          <Card testId="monitoring-board">
            <SectionHeader aside={plural(data.rows.length, 'position')}>
              Positions for the quarter
            </SectionHeader>
            <Toolbar>
              <Field>
                <Label htmlFor="monitoring-period">Quarter</Label>
                <Dropdown
                  id="monitoring-period"
                  className="pb-monitoring-filter"
                  value={quarterLabel(period ?? data.periodEnd)}
                  selectedOptions={[period ?? data.periodEnd]}
                  onOptionSelect={(_e, d) => {
                    if (d.optionValue !== undefined) setPeriod(d.optionValue);
                  }}
                >
                  {periodOptions(
                    positions.data?.items.map((i) => i.entryDate) ?? [],
                    filters.asOf ?? data.asOf,
                    data.periodEnd,
                  ).map((end) => (
                    <Option key={end} value={end}>
                      {quarterLabel(end)}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Field>
                <Label htmlFor="monitoring-asof">As of</Label>
                <Input
                  id="monitoring-asof"
                  type="date"
                  className="pb-monitoring-date"
                  value={asOfInput ?? data.asOf}
                  onChange={(_e, d) => setAsOfInput(d.value)}
                />
              </Field>
            </Toolbar>
            <ActionStatus latest={log.latest} testId="monitoring-action-status" />
            {data.rows.length === 0 ? (
              <EmptyState
                title="No positions on the board"
                detail={`No position in your view was held on ${formatDate(data.periodEnd)}. Positions behind a wall appear only to wall members.`}
                testId="monitoring-empty"
              />
            ) : (
              <BoardTable rows={data.rows} />
            )}
            <p className="pb-meta">{thresholdsLine()}</p>
          </Card>
        </>
      )}
    </>
  );
}
