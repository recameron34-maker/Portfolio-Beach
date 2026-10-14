import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Input, Label, Option } from '@fluentui/react-components';
import { Search16Regular } from '@fluentui/react-icons';
import type { IntakeCommandBody, StagingState, WeeklyFileDetail, WeeklyRow } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { describeActionError } from '../../app/mutations.js';
import { meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
  Toolbar,
} from '../../components/ui.js';
import { ActionStatus, ReasonDialog } from '../../components/WorkflowActions.js';
import { MISSING, plural } from '../../lib/format.js';
import { humanizeState, stagingTone } from '../../lib/states.js';
import { balanceTiles } from '../../lib/tiles.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import {
  dayOf,
  exactMoney,
  filterRows,
  hiddenRowsNote,
  INTAKE_FILTER_STATES,
  intakeActions,
  isStagingState,
  noRowsState,
  rejectableRows,
} from '../intake/intake.js';
import { FileFindingsCard, FindingsCell, SubjectCell } from '../intake/IntakeFile.js';
import { useWeeklyCommand } from './mutations.js';
import { weeklyFileQuery } from './queries.js';
import {
  ABOVE_THRESHOLD_LABEL,
  decisionText,
  isAboveThreshold,
  priorNote,
  reportDateText,
  thresholdLabel,
  varianceText,
  WEEKLY_FORBIDDEN,
  weeklyCommandResult,
} from './weekly.js';
import '../intake/intake.css';
import './weekly.css';

function BackLink(): ReactNode {
  return (
    <p className="pb-meta">
      <Link to="/data/weekly">All weekly files</Link>
    </p>
  );
}

function Tiles({ file }: { file: WeeklyFileDetail }): ReactNode {
  const c = file.counts;
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="weekly-tiles">
      <StatTile label="Rows" value={String(file.rowCount)} hint="Data lines in the file" />
      <StatTile label="Validated" value={String(c.validated)} hint="Waiting for approval" />
      <StatTile
        label="Flagged"
        value={String(c.flagged)}
        hint="A rule found an error"
        tone={c.flagged > 0 ? 'watch' : undefined}
      />
      <StatTile
        label="Promoted"
        value={String(c.promoted)}
        hint="Draft valuations created, audited"
        tone={c.promoted > 0 ? 'good' : undefined}
      />
      <StatTile label="Rejected" value={String(c.rejected)} hint="Refused with a reason" />
      <StatTile
        label="Exceptions"
        value={String(file.exceptions)}
        hint="Data exceptions opened for a person"
        tone={file.exceptions > 0 ? 'watch' : undefined}
      />
    </div>
  );
}

/** The prior the value was compared with: the figure to the cent, and where it came from. */
function PriorCell({ row }: { row: WeeklyRow }): ReactNode {
  return (
    <td className="pb-weekly-figure">
      {exactMoney(row.priorValue)}
      <span className="pb-cell-sub">
        <span className="pb-meta">{priorNote(row)}</span>
      </span>
    </td>
  );
}

/** The move against the prior as a percentage, with the threshold flag the API set as a badge. */
function VarianceCell({ row }: { row: WeeklyRow }): ReactNode {
  return (
    <td className="pb-weekly-figure">
      <span className="pb-weekly-variance">
        <span>{varianceText(row.variancePct)}</span>
        {isAboveThreshold(row) ? (
          <Badge tone="bad">
            <span title={`At or beyond the ${thresholdLabel()} threshold`}>
              {ABOVE_THRESHOLD_LABEL}
            </span>
          </Badge>
        ) : null}
      </span>
    </td>
  );
}

function DecisionCell({ row }: { row: WeeklyRow }): ReactNode {
  const decision = decisionText(row);
  return (
    <td>
      {decision === MISSING ? <span className="pb-meta">{MISSING}</span> : <span>{decision}</span>}
      {row.decidedBy === null && row.decidedAt === null && row.valuationId === null ? null : (
        <span className="pb-cell-sub">
          {row.decidedBy === null ? null : <span>By {row.decidedBy}</span>}
          {row.decidedAt === null ? null : <span>Decided {dayOf(row.decidedAt)}</span>}
          {row.valuationId === null ? null : <Link to="/valuations">Draft valuation</Link>}
        </span>
      )}
    </td>
  );
}

function RowsTable({ rows }: { rows: readonly WeeklyRow[] }): ReactNode {
  return (
    <TableWrap label="Staged weekly values">
      <table
        className="pb-table pb-weekly-rows"
        aria-label="Staged weekly values"
        data-testid="weekly-rows"
      >
        <thead>
          <tr>
            <th className="num">Row</th>
            <th>Position</th>
            <th>Report date</th>
            <th className="num">Reported value</th>
            <th className="num">Prior</th>
            <th className="num">Variance</th>
            <th>Findings</th>
            <th>Status</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <NumCell>{String(row.rowNo)}</NumCell>
              <SubjectCell row={row} />
              <td className="pb-nowrap">{reportDateText(row.reportDate)}</td>
              <td className="pb-weekly-figure">{exactMoney(row.reportedValue)}</td>
              <PriorCell row={row} />
              <VarianceCell row={row} />
              <FindingsCell findings={row.findings} />
              <td>
                <Badge tone={stagingTone(row.status)}>{humanizeState(row.status)}</Badge>
              </td>
              <DecisionCell row={row} />
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function RowsCard({
  file,
  roles,
}: {
  file: WeeklyFileDetail;
  roles: readonly string[];
}): ReactNode {
  const [state, setState] = useState<StagingState | ''>('');
  const [search, setSearch] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const rejectButton = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);
  const log = useActionLog();
  const command = useWeeklyCommand();
  // Fluent's Button infers its ref element from a slot union, so the element is captured by a
  // typed callback rather than a ref object.
  const captureRejectButton = useCallback((el: HTMLButtonElement | null): void => {
    rejectButton.current = el;
  }, []);
  // The reason dialog has no trigger of its own, so when it closes, submitted or not, focus goes
  // back to the button that opened it, once the dialog is out of the document.
  useEffect(() => {
    if (rejecting || !returnFocus.current) return;
    returnFocus.current = false;
    rejectButton.current?.focus();
  }, [rejecting]);
  // The gates, the filters and the wall note are the intake page's: a command acts on the rows
  // the reviewer sees, and a validated row past their wall waits for a wall member.
  const actions = intakeActions(roles, file.rows);
  const rows = filterRows(file.rows, { state, search });
  const hidden = hiddenRowsNote(file.hiddenRows);
  const noRows = noRowsState(file);

  const issue = (body: IntakeCommandBody): void => {
    const label = body.command === 'approve' ? 'Approve validated rows' : 'Reject flagged rows';
    const before = file.counts;
    command.mutate(
      { id: file.id, body },
      {
        onSuccess: (updated) =>
          log.record(
            'good',
            weeklyCommandResult(before, updated.counts, body.command, resultSuffix()),
          ),
        onError: (error) => log.record('bad', `${label}: ${describeActionError(error)}`),
      },
    );
  };

  return (
    <Card testId="weekly-rows-card">
      <SectionHeader aside={`${rows.length} of ${plural(file.rows.length, 'row')}`}>
        Staged weekly values
      </SectionHeader>
      <Toolbar
        end={
          actions.approve.offered || actions.reject.offered ? (
            // A command button that cannot act stays focusable (aria-disabled, in the tab order),
            // so keyboard focus is kept by the button a reviewer just pressed while the command
            // runs and after it, and the reject dialog has a trigger to return focus to.
            <>
              {actions.approve.offered ? (
                <Button
                  size="small"
                  appearance="primary"
                  disabledFocusable={!actions.approve.enabled || command.isPending}
                  {...(actions.approve.title === null ? {} : { title: actions.approve.title })}
                  onClick={() => issue({ command: 'approve' })}
                >
                  Approve validated rows
                </Button>
              ) : null}
              {actions.reject.offered ? (
                <Button
                  ref={captureRejectButton}
                  size="small"
                  appearance="outline"
                  disabledFocusable={!actions.reject.enabled || command.isPending}
                  {...(actions.reject.title === null ? {} : { title: actions.reject.title })}
                  onClick={() => {
                    returnFocus.current = true;
                    setRejecting(true);
                  }}
                >
                  Reject flagged rows
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        <Field>
          <Label htmlFor="weekly-state">State</Label>
          <Dropdown
            id="weekly-state"
            className="pb-intake-filter"
            value={state === '' ? 'All states' : humanizeState(state)}
            selectedOptions={[state]}
            onOptionSelect={(_e, d) => {
              const v = d.optionValue ?? '';
              setState(isStagingState(v) ? v : '');
            }}
          >
            <Option value="">All states</Option>
            {INTAKE_FILTER_STATES.map((s) => (
              <Option key={s} value={s}>
                {humanizeState(s)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field>
          <Label htmlFor="weekly-search">Search</Label>
          <Input
            id="weekly-search"
            className="pb-intake-filter"
            contentBefore={<Search16Regular />}
            placeholder="Inv # or company"
            value={search}
            onChange={(_e, d) => setSearch(d.value)}
          />
        </Field>
      </Toolbar>
      <ActionStatus latest={log.latest} testId="weekly-action-status" />
      {hidden === null ? null : (
        <p className="pb-notice" data-testid="weekly-hidden-rows">
          {hidden}
        </p>
      )}
      {noRows !== null ? (
        <EmptyState title={noRows.title} detail={noRows.detail} testId="weekly-no-rows" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No rows match these filters"
          detail="Clear the search, or pick another state."
        />
      ) : (
        <RowsTable rows={rows} />
      )}
      {file.counts.promoted > 0 ? (
        <p className="pb-meta pb-weekly-board" data-testid="weekly-board-link">
          {plural(file.counts.promoted, 'Draft valuation')} from this file{' '}
          {file.counts.promoted === 1 ? 'is' : 'are'} on the{' '}
          <Link to="/valuations">valuations board</Link>, where the valuation workflow carries{' '}
          {file.counts.promoted === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
      {rejecting ? (
        <ReasonDialog
          title="Reject flagged rows"
          // The rows the command will touch: the flagged rows this reviewer sees, as the gate
          // counts them; the file's own count also holds rows behind a wall.
          subject={`${plural(rejectableRows(file.rows).length, 'flagged row')} in ${file.fileName}`}
          onCancel={() => setRejecting(false)}
          onSubmit={(reason) => {
            issue({ command: 'reject', reason });
            setRejecting(false);
          }}
        />
      ) : null}
    </Card>
  );
}

function FileBody({
  file,
  roles,
  duplicate,
}: {
  file: WeeklyFileDetail;
  roles: readonly string[];
  duplicate: boolean;
}): ReactNode {
  return (
    <>
      <BackLink />
      <PageHeader
        title={file.fileName}
        meta={
          <span className="pb-meta-list">
            <span>Received {dayOf(file.receivedAt)}</span>
            <span>By {file.receivedBy ?? MISSING}</span>
            <span>{plural(file.rowCount, 'row')}</span>
          </span>
        }
        actions={<Badge tone={stagingTone(file.status)}>{humanizeState(file.status)}</Badge>}
        testId="weekly-banner"
      />
      {duplicate ? (
        <p className="pb-notice" data-testid="weekly-duplicate">
          This file was staged before. Its rows are shown as they stand; nothing new was staged.
        </p>
      ) : null}
      <Tiles file={file} />
      {file.fileFindings.length > 0 ? <FileFindingsCard findings={file.fileFindings} /> : null}
      <RowsCard file={file} roles={roles} />
    </>
  );
}

/**
 * One staged weekly values file (docs/04 M2, docs/18 sections 1 and 2): every value with its
 * link, its prior, its variance against it, the threshold flag and its findings, and the approve
 * and reject commands for the roles that hold them. An approved value becomes a Draft valuation
 * in the same transaction, with an audit event per valuation.
 */
export function WeeklyFilePage(): ReactNode {
  const { id } = useParams({ from: '/app/data/weekly/$id' });
  const { duplicate } = useSearch({ from: '/app/data/weekly/$id' });
  const me = useQuery(meQuery);
  const q = useQuery(weeklyFileQuery(id));
  if (q.isPending) return <PageSkeleton tiles={6} rows={8} />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <>
        <BackLink />
        {missing ? (
          <ErrorState
            title="Weekly file not found or not visible to you"
            detail="There is no weekly values file with this id in your view."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This weekly file"
            forbidden={WEEKLY_FORBIDDEN}
            errorTitle="Weekly file unavailable"
            testId="weekly-file-unavailable"
          />
        )}
      </>
    );
  }
  return <FileBody file={q.data} roles={me.data?.roles ?? []} duplicate={duplicate === true} />;
}
