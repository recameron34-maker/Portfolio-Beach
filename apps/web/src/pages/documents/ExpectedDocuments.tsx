import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Input, Label, Option } from '@fluentui/react-components';
import type { ExpectedDocument, ExpectedDocumentStatus } from '@pb/contracts';
import { describeActionError, useGenerateExpectedDocuments } from '../../app/mutations.js';
import { DOCUMENTS_TABS } from '../../app/nav.js';
import { dataHealthQuery, expectedDocumentsQuery, LIST_LIMIT, meQuery } from '../../app/queries.js';
import type { ExpectedDocumentFilters } from '../../app/queries.js';
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
  SimulatedBadge,
  TabNav,
  TableWrap,
  Toolbar,
} from '../../components/ui.js';
import { ActionStatus } from '../../components/WorkflowActions.js';
import { formatDate, MISSING, plural } from '../../lib/format.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import {
  ageTitle,
  dateFilter,
  defaultQuarterEnd,
  docTypeLabel,
  EXPECTED_META,
  EXPECTED_STATUSES,
  expectedTone,
  expectedWord,
  GENERATE_READ_ONLY,
  generateResultText,
  isExpectedStatus,
  mayGenerate,
  quarterEndProblem,
} from './documents.js';
import './documents.css';

/**
 * Operations only: generate the expected rows of a quarter (one quarterly report per position
 * whose deal type reports quarterly figures, one capital account statement per sponsor fund with
 * a commitment). Idempotent: rows the quarter already has are counted as existing and kept.
 */
function GenerateCard({ defaultPeriodEnd }: { defaultPeriodEnd: string }): ReactNode {
  const inputId = useId();
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEnd);
  const log = useActionLog();
  const generator = useGenerateExpectedDocuments();
  const problem = quarterEndProblem(periodEnd);
  const busy = generator.isPending;

  const generate = (): void => {
    if (problem !== null) return;
    generator.mutate(
      { periodEnd: periodEnd.trim() },
      {
        onSuccess: (result) =>
          log.record('good', `${generateResultText(result)} ${resultSuffix()}`),
        onError: (error) =>
          log.record('bad', `Generate expected documents: ${describeActionError(error)}`),
      },
    );
  };

  return (
    <Card testId="expected-generate">
      <SectionHeader aside={<SimulatedBadge />}>Generate expected documents</SectionHeader>
      <p className="pb-meta">
        One quarterly report per position that reports quarterly figures and one capital account
        statement per sponsor fund with a commitment, due a fixed number of days after the quarter
        end (config). Rows a quarter already has are kept.
      </p>
      <div className="pb-documents-form">
        <div className="pb-field">
          <Label htmlFor={inputId}>Quarter end</Label>
          <Input
            id={inputId}
            type="date"
            className="pb-documents-filter"
            value={periodEnd}
            disabled={busy}
            onChange={(_e, d) => setPeriodEnd(d.value)}
          />
        </div>
        <Button
          size="small"
          appearance="primary"
          disabledFocusable={problem !== null || busy}
          {...(problem === null ? {} : { title: problem })}
          onClick={generate}
        >
          Generate expected documents
        </Button>
      </div>
      <ActionStatus latest={log.latest} testId="expected-action-status" />
    </Card>
  );
}

/** The position or the fund a row is owed by, as a link where the reader may follow it. */
function SubjectCell({ row }: { row: ExpectedDocument }): ReactNode {
  return (
    <td className="pb-documents-subject">
      {row.investmentId !== null ? (
        <Link to="/portfolio/$id" params={{ id: row.investmentId }}>
          {row.companyName ?? MISSING}
        </Link>
      ) : row.sponsorFundId !== null ? (
        <span>{row.sponsorFundName ?? MISSING}</span>
      ) : (
        <span>{MISSING}</span>
      )}
      {row.investmentNumber === null ? null : (
        <span className="pb-cell-sub">
          <span className="pb-key">{row.investmentNumber}</span>
        </span>
      )}
    </td>
  );
}

function ExpectedTable({ items }: { items: readonly ExpectedDocument[] }): ReactNode {
  return (
    <TableWrap label="Expected documents">
      <table
        className="pb-table pb-documents-expected"
        aria-label="Expected documents"
        data-testid="expected-table"
      >
        <thead>
          <tr>
            <th>Company or fund</th>
            <th>Type</th>
            <th>Period</th>
            <th>Due</th>
            <th>Status</th>
            <th className="num">Age (days)</th>
            <th>Document</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.id}>
              <SubjectCell row={row} />
              <td>{docTypeLabel(row.docType)}</td>
              <td className="pb-nowrap">{formatDate(row.periodEnd)}</td>
              <td className="pb-nowrap">{formatDate(row.dueDate)}</td>
              <td>
                <Badge tone={expectedTone(row.status)}>{expectedWord(row.status)}</Badge>
              </td>
              <td className="num" title={ageTitle(row)}>
                {String(row.ageDays)}
              </td>
              {row.receivedDocumentId === null ? (
                <NumCell>{MISSING}</NumCell>
              ) : (
                <td>
                  <Link to="/documents/$id" params={{ id: row.receivedDocumentId }}>
                    Open document
                  </Link>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** The tracker: every expected row the reader may see, newest period first, judged on the as-of day (the API's today unless set). */
function TrackerCard({ isOps }: { isOps: boolean }): ReactNode {
  const periodId = useId();
  const statusId = useId();
  const asOfId = useId();
  const [period, setPeriod] = useState('');
  const [status, setStatus] = useState<ExpectedDocumentStatus | ''>('');
  const [asOf, setAsOf] = useState('');
  const filters: ExpectedDocumentFilters = {
    periodEnd: dateFilter(period),
    status: status === '' ? undefined : status,
    asOf: dateFilter(asOf),
  };
  const q = useQuery({ ...expectedDocumentsQuery(filters), placeholderData: keepPreviousData });
  const narrowed = filters.periodEnd !== undefined || filters.status !== undefined;
  return (
    <Card testId="expected-card">
      <SectionHeader
        aside={
          q.data === undefined || q.data.items.length === 0
            ? undefined
            : plural(q.data.items.length, 'row')
        }
      >
        Tracker
      </SectionHeader>
      <Toolbar>
        <Field>
          <Label htmlFor={periodId}>Period end</Label>
          <Input
            id={periodId}
            type="date"
            className="pb-documents-filter"
            value={period}
            onChange={(_e, d) => setPeriod(d.value)}
          />
        </Field>
        <Field>
          <Label htmlFor={statusId}>Status</Label>
          <Dropdown
            id={statusId}
            className="pb-documents-filter"
            value={status === '' ? 'All statuses' : expectedWord(status)}
            selectedOptions={[status]}
            onOptionSelect={(_e, d) => {
              const v = d.optionValue ?? '';
              setStatus(isExpectedStatus(v) ? v : '');
            }}
          >
            <Option value="">All statuses</Option>
            {EXPECTED_STATUSES.map((s) => (
              <Option key={s} value={s}>
                {expectedWord(s)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field>
          <Label htmlFor={asOfId}>Judged as of</Label>
          <Input
            id={asOfId}
            type="date"
            className="pb-documents-filter"
            value={asOf}
            onChange={(_e, d) => setAsOf(d.value)}
          />
        </Field>
      </Toolbar>
      {isOps ? null : (
        <p className="pb-meta" data-testid="expected-read-only">
          {GENERATE_READ_ONLY}
        </p>
      )}
      {q.isPending ? (
        <PageSkeleton rows={4} />
      ) : q.isError ? (
        <UnavailableState
          error={q.error}
          subject="Expected documents"
          errorTitle="Expected documents unavailable"
          testId="expected-unavailable"
        />
      ) : q.data.items.length === 0 ? (
        <EmptyState
          title={narrowed ? 'No expected documents match' : 'No expected documents yet'}
          detail={
            narrowed
              ? 'Clear a filter, or pick another period or status.'
              : isOps
                ? 'Generate the rows of a quarter above; each position and sponsor fund then shows what it owes and whether it has arrived.'
                : 'Operations generates the rows of a quarter; each position and sponsor fund then shows what it owes and whether it has arrived.'
          }
          testId="expected-empty"
        />
      ) : (
        <ExpectedTable items={q.data.items} />
      )}
      {q.data !== undefined && q.data.nextCursor !== null ? (
        <p className="pb-meta" data-testid="expected-truncated">
          Showing the first {LIST_LIMIT} rows; more exist.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Expected documents (docs/04 M3, decision 0012): what each position and sponsor fund owes for a
 * quarter and whether it arrived (expected, received, late or missing, derived from the due date
 * and the as-of day, never stored), with a link to the document that answered it; operations
 * generates the rows of a quarter.
 */
export function ExpectedDocumentsPage(): ReactNode {
  const me = useQuery(meQuery);
  const isOps = mayGenerate(me.data?.roles ?? []);
  // The latest quarter of the record is the one to generate by default, so the record's as-of day
  // is read before the form shows (operations only; a failed read leaves the date blank).
  const health = useQuery({ ...dataHealthQuery, enabled: isOps });
  if (me.isPending || (isOps && health.isPending)) return <PageSkeleton rows={6} />;
  return (
    <>
      <PageHeader title="Expected documents" meta={EXPECTED_META} />
      <TabNav label="Documents" items={DOCUMENTS_TABS} />
      {isOps ? <GenerateCard defaultPeriodEnd={defaultQuarterEnd(health.data?.asOf)} /> : null}
      <TrackerCard isOps={isOps} />
    </>
  );
}
