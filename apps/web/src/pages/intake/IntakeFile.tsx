import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Input, Label, Option } from '@fluentui/react-components';
import { Search16Regular } from '@fluentui/react-icons';
import type { IntakeCommandBody, IntakeFileDetail, IntakeFinding, IntakeRow } from '@pb/contracts';
import type { StagingState } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { describeActionError, useIntakeCommand } from '../../app/mutations.js';
import { intakeFileQuery, meQuery } from '../../app/queries.js';
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
  SimulatedBadge,
  StatTile,
  TableWrap,
  Toolbar,
} from '../../components/ui.js';
import { ActionStatus, ReasonDialog } from '../../components/WorkflowActions.js';
import { formatDate, MISSING, plural } from '../../lib/format.js';
import { humanizeState, stagingTone } from '../../lib/states.js';
import { balanceTiles } from '../../lib/tiles.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import {
  candidatesText,
  commandResult,
  dayOf,
  describeChange,
  DIFF_TONES,
  DIFF_WORDS,
  filterRows,
  findingDetail,
  findingTone,
  hiddenRowsNote,
  INTAKE_FILTER_STATES,
  INTAKE_FORBIDDEN,
  intakeActions,
  isStagingState,
  linkNote,
  noRowsState,
  rejectableRows,
  rowSubject,
  sourceWord,
  templateLine,
} from './intake.js';
import './intake.css';

function BackLink(): ReactNode {
  return (
    <p className="pb-meta">
      <Link to="/data/intake">All intake files</Link>
    </p>
  );
}

function Tiles({ file }: { file: IntakeFileDetail }): ReactNode {
  const c = file.counts;
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="intake-tiles">
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
        hint="Written to production, audited"
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

/** The file-level findings of a refused file; every intake's detail page shows them the same way. */
export function FileFindingsCard({ findings }: { findings: readonly IntakeFinding[] }): ReactNode {
  return (
    <Card tone="error" testId="intake-file-findings">
      <SectionHeader>File findings</SectionHeader>
      <ul className="pb-intake-file-findings" aria-label="File findings">
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

/** The investment a row is about: a link once matched, else the file's name with why it did not link. */
export function SubjectCell({
  row,
}: {
  row: Pick<IntakeRow, 'investmentNumber' | 'companyName' | 'link'>;
}): ReactNode {
  const subject = rowSubject(row);
  const note = linkNote(row.link);
  const candidates = candidatesText(row.link.candidates);
  const name = subject.companyName ?? MISSING;
  return (
    <td className="pb-intake-subject">
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
      {candidates === null ? null : <span className="pb-intake-lines">{candidates}</span>}
    </td>
  );
}

/**
 * What approving the row writes: every change, to the cent, whether the quarter is new (every
 * figure, nothing on record) or restated. The approver must see each figure before it reaches
 * production (CLAUDE.md rule 5); the millions scale sits in the title.
 */
function DiffCell({ diff }: { diff: IntakeRow['diff'] }): ReactNode {
  return (
    <td>
      <Badge tone={DIFF_TONES[diff.kind]}>{DIFF_WORDS[diff.kind]}</Badge>
      {diff.changes.length > 0 ? (
        <span className="pb-intake-lines">
          {diff.changes.map((c) => (
            <span key={c.field} title={describeChange(c, 'millions')}>
              {describeChange(c)}
            </span>
          ))}
        </span>
      ) : null}
    </td>
  );
}

/** A row's findings as rule badges, with the messages behind a disclosure. */
export function FindingsCell({ findings }: { findings: readonly IntakeFinding[] }): ReactNode {
  if (findings.length === 0) {
    return (
      <td>
        <span className="pb-meta">None</span>
      </td>
    );
  }
  return (
    <td>
      <span className="pb-intake-findings">
        {findings.map((f, i) => (
          <span key={`${f.ruleId}-${i}`} title={f.message}>
            <Badge tone={findingTone(f.severity)}>{f.ruleId}</Badge>
          </span>
        ))}
      </span>
      <details className="pb-intake-details">
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

function DecisionCell({ row }: { row: IntakeRow }): ReactNode {
  return (
    <td>
      {row.decision === null ? (
        <span className="pb-meta">{MISSING}</span>
      ) : (
        <span>{row.decision}</span>
      )}
      {row.decidedBy === null && row.promotedAt === null ? null : (
        <span className="pb-cell-sub">
          {row.decidedBy === null ? null : <span>By {row.decidedBy}</span>}
          {row.promotedAt === null ? null : <span>Promoted {dayOf(row.promotedAt)}</span>}
        </span>
      )}
    </td>
  );
}

function RowsTable({ rows }: { rows: readonly IntakeRow[] }): ReactNode {
  return (
    <TableWrap label="Staged rows">
      <table className="pb-table pb-intake-rows" aria-label="Staged rows" data-testid="intake-rows">
        <thead>
          <tr>
            <th className="num">Row</th>
            <th>Investment</th>
            <th>Period end</th>
            <th>Diff</th>
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
              <td className="pb-nowrap">{formatDate(row.periodEnd)}</td>
              <DiffCell diff={row.diff} />
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
  file: IntakeFileDetail;
  roles: readonly string[];
}): ReactNode {
  const [state, setState] = useState<StagingState | ''>('');
  const [search, setSearch] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const rejectButton = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);
  const log = useActionLog();
  const command = useIntakeCommand();
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
            `${commandResult(before, updated.counts, body.command)} ${resultSuffix()}`,
          ),
        onError: (error) => log.record('bad', `${label}: ${describeActionError(error)}`),
      },
    );
  };

  return (
    <Card testId="intake-rows-card">
      <SectionHeader
        aside={
          <>
            {`${rows.length} of ${plural(file.rows.length, 'row')}`}
            <SimulatedBadge />
          </>
        }
      >
        Staged rows
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
          <Label htmlFor="intake-state">State</Label>
          <Dropdown
            id="intake-state"
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
          <Label htmlFor="intake-search">Search</Label>
          <Input
            id="intake-search"
            className="pb-intake-filter"
            contentBefore={<Search16Regular />}
            placeholder="Inv # or company"
            value={search}
            onChange={(_e, d) => setSearch(d.value)}
          />
        </Field>
      </Toolbar>
      <ActionStatus latest={log.latest} testId="intake-action-status" />
      {hidden === null ? null : (
        <p className="pb-notice" data-testid="intake-hidden-rows">
          {hidden}
        </p>
      )}
      {noRows !== null ? (
        <EmptyState title={noRows.title} detail={noRows.detail} testId="intake-no-rows" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No rows match these filters"
          detail="Clear the search, or pick another state."
        />
      ) : (
        <RowsTable rows={rows} />
      )}
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
  file: IntakeFileDetail;
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
            <span>{sourceWord(file.source)}</span>
            {templateLine(file) === null ? null : <span>{templateLine(file)}</span>}
            <span>Received {dayOf(file.receivedAt)}</span>
            <span>By {file.receivedBy ?? MISSING}</span>
            <span>{plural(file.rowCount, 'row')}</span>
          </span>
        }
        actions={<Badge tone={stagingTone(file.status)}>{humanizeState(file.status)}</Badge>}
        testId="intake-banner"
      />
      {duplicate ? (
        <p className="pb-notice" data-testid="intake-duplicate">
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
 * One staged file (docs/04 M2, docs/18 section 2): every row with its link, its diff against the
 * current quarter and its findings, and the approve and reject commands for the roles that hold
 * them. Approved rows are promoted in the same transaction, with an audit event per row.
 */
export function IntakeFilePage(): ReactNode {
  const { id } = useParams({ from: '/app/data/intake/$id' });
  const { duplicate } = useSearch({ from: '/app/data/intake/$id' });
  const me = useQuery(meQuery);
  const q = useQuery(intakeFileQuery(id));
  if (q.isPending) return <PageSkeleton tiles={6} rows={8} />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <>
        <BackLink />
        {missing ? (
          <ErrorState
            title="Intake file not found or not visible to you"
            detail="There is no intake file with this id in your view."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This intake file"
            forbidden={INTAKE_FORBIDDEN}
            errorTitle="Intake file unavailable"
            testId="intake-file-unavailable"
          />
        )}
      </>
    );
  }
  return <FileBody file={q.data} roles={me.data?.roles ?? []} duplicate={duplicate === true} />;
}
