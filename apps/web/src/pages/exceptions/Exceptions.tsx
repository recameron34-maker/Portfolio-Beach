import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Dropdown, Label, Option } from '@fluentui/react-components';
import type { DataException, DataExceptionPage } from '@pb/contracts';
import { LIST_LIMIT } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  TableWrap,
  Toolbar,
} from '../../components/ui.js';
import { MISSING } from '../../lib/format.js';
import { exceptionsQuery } from './exceptions-queries.js';
import type { ExceptionFilters } from './exceptions-queries.js';
import {
  ageLabel,
  contextLink,
  EXCEPTION_STATES,
  EXCEPTIONS_FORBIDDEN,
  EXCEPTIONS_META,
  exceptionStateWord,
  exceptionTone,
  filterByFile,
  isExceptionState,
  knownSources,
  positionText,
  queueCountLine,
  rowText,
  SEVERITIES,
  severityLabel,
  severityTone,
  sourceLabel,
} from './exceptions.js';
import './exceptions.css';

/** Where the exception came from: the run or the file, then the row and the position when the reader may see it. */
function ContextCell({ x }: { x: DataException }): ReactNode {
  const link = contextLink(x);
  const row = rowText(x);
  const position = positionText(x);
  return (
    <td className="pb-exceptions-context">
      {link === null ? (
        <span>{x.context.intakeFileName ?? x.entity}</span>
      ) : (
        <Link to={link.to} params={link.params}>
          {link.label}
        </Link>
      )}
      {row === null && position === null ? null : (
        <span className="pb-cell-sub">
          {row === null ? null : <span className="pb-key">{row}</span>}
          {position === null ? null : x.context.investmentId === null ? (
            <span>{position}</span>
          ) : (
            <Link to="/portfolio/$id" params={{ id: x.context.investmentId }}>
              {position}
            </Link>
          )}
        </span>
      )}
    </td>
  );
}

function QueueTable({ items, now }: { items: readonly DataException[]; now: Date }): ReactNode {
  return (
    <TableWrap label="Data exceptions">
      <table
        className="pb-table pb-exceptions-table"
        aria-label="Data exceptions"
        data-testid="exceptions-table"
      >
        <thead>
          <tr>
            <th>Rule</th>
            <th>Source</th>
            <th>Context</th>
            <th>Expected</th>
            <th>Actual</th>
            <th>Severity</th>
            <th>State</th>
            <th>Owner</th>
            <th>Ticket</th>
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
          {items.map((x) => (
            <tr key={x.id}>
              <td>
                <Link to="/data/exceptions/$id" params={{ id: x.id }} className="pb-key">
                  {x.ruleId}
                </Link>
              </td>
              <td>{sourceLabel(x.source)}</td>
              <ContextCell x={x} />
              <td className="pb-exceptions-text">{x.expected ?? MISSING}</td>
              <td className="pb-exceptions-text">{x.actual ?? MISSING}</td>
              <td>
                <Badge tone={severityTone(x.severity)}>{severityLabel(x.severity)}</Badge>
              </td>
              <td>
                <Badge tone={exceptionTone(x.state)}>{exceptionStateWord(x.state)}</Badge>
              </td>
              <td>{x.owner ?? MISSING}</td>
              <td>{x.externalTicket ?? MISSING}</td>
              <td className="pb-nowrap">{ageLabel(x.createdAt, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function QueueCard({
  page,
  filters,
  file,
  onFilters,
}: {
  page: DataExceptionPage;
  filters: ExceptionFilters;
  file: string | undefined;
  onFilters: (next: ExceptionFilters) => void;
}): ReactNode {
  const shown = file === undefined ? page.items : filterByFile(page.items, file);
  const fileName = shown[0]?.context.intakeFileName ?? null;
  const narrowed =
    file !== undefined ||
    filters.state !== undefined ||
    filters.source !== undefined ||
    filters.severity !== undefined;
  const now = new Date();
  return (
    <Card testId="exceptions-card">
      <SectionHeader aside={queueCountLine(shown.length, page.items.length)}>Queue</SectionHeader>
      <Toolbar>
        <Field>
          <Label htmlFor="exceptions-state">State</Label>
          <Dropdown
            id="exceptions-state"
            className="pb-exceptions-filter"
            value={filters.state ? exceptionStateWord(filters.state) : 'All states'}
            selectedOptions={[filters.state ?? '']}
            onOptionSelect={(_e, d) => {
              const v = d.optionValue ?? '';
              onFilters({ ...filters, state: isExceptionState(v) ? v : undefined });
            }}
          >
            <Option value="">All states</Option>
            {EXCEPTION_STATES.map((s) => (
              <Option key={s} value={s}>
                {exceptionStateWord(s)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field>
          <Label htmlFor="exceptions-source">Source</Label>
          <Dropdown
            id="exceptions-source"
            className="pb-exceptions-filter"
            value={filters.source ? sourceLabel(filters.source) : 'All sources'}
            selectedOptions={[filters.source ?? '']}
            onOptionSelect={(_e, d) => {
              const v = d.optionValue ?? '';
              onFilters({ ...filters, source: v === '' ? undefined : v });
            }}
          >
            <Option value="">All sources</Option>
            {knownSources(page.items).map((s) => (
              <Option key={s} value={s}>
                {sourceLabel(s)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field>
          <Label htmlFor="exceptions-severity">Severity</Label>
          <Dropdown
            id="exceptions-severity"
            className="pb-exceptions-filter"
            value={filters.severity ? severityLabel(filters.severity) : 'All severities'}
            selectedOptions={[filters.severity ?? '']}
            onOptionSelect={(_e, d) => {
              const v = d.optionValue ?? '';
              onFilters({ ...filters, severity: v === '' ? undefined : v });
            }}
          >
            <Option value="">All severities</Option>
            {SEVERITIES.map((s) => (
              <Option key={s} value={s}>
                {severityLabel(s)}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </Toolbar>
      {file === undefined ? null : (
        <p className="pb-notice" data-testid="exceptions-file-note">
          Showing the exceptions of {fileName ?? 'one run'}.{' '}
          <Link to="/data/exceptions" search={{}}>
            Show every exception
          </Link>
        </p>
      )}
      {shown.length === 0 ? (
        <EmptyState
          title="No exceptions match"
          detail={
            narrowed
              ? 'Clear a filter, or pick another state, source or severity.'
              : 'Nothing is waiting for a person. Each intake opens an exception for what it cannot decide, and it appears here.'
          }
          testId="exceptions-empty"
        />
      ) : (
        <QueueTable items={shown} now={now} />
      )}
      {page.nextCursor !== null ? (
        <p className="pb-meta" data-testid="exceptions-truncated">
          Showing the first {LIST_LIMIT} exceptions; more exist.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Data exceptions (docs/04 M1 Data Health, docs/18 section 9): what the intakes could not decide,
 * newest first, filtered by state, source and severity on the API; opened from a reconcile run
 * or a staged file, the queue shows that file's exceptions alone. Each exception is worked on its
 * own page.
 */
export function ExceptionsPage(): ReactNode {
  const search = useSearch({ from: '/app/data/exceptions' });
  const [filters, setFilters] = useState<ExceptionFilters>({
    state: search.state,
    source: search.source,
    severity: search.severity,
  });
  const q = useQuery({ ...exceptionsQuery(filters), placeholderData: keepPreviousData });
  if (q.isPending) return <PageSkeleton rows={6} />;
  if (q.isError) {
    return (
      <>
        <PageHeader title="Exceptions" meta={EXCEPTIONS_META} />
        <UnavailableState
          card
          error={q.error}
          subject="Exceptions"
          forbidden={EXCEPTIONS_FORBIDDEN}
          errorTitle="Exceptions unavailable"
          testId="exceptions-unavailable"
        />
      </>
    );
  }
  return (
    <>
      <PageHeader title="Exceptions" meta={EXCEPTIONS_META} />
      <QueueCard page={q.data} filters={filters} file={search.file} onFilters={setFilters} />
    </>
  );
}
