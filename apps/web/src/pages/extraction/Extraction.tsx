import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Input, Label, Option } from '@fluentui/react-components';
import type { ExtractionBatch, ExtractionRun, ExtractionRunState } from '@pb/contracts';
import { useStartExtractionBatch } from '../../app/mutations.js';
import { DOCUMENTS_TABS } from '../../app/nav.js';
import {
  extractionBatchesQuery,
  extractionRunsQuery,
  LIST_LIMIT,
  meQuery,
  taxonomyQuery,
} from '../../app/queries.js';
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
  TableWrap,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { ActionStatus } from '../../components/WorkflowActions.js';
import { formatDate, formatDateTime, labelOf, MISSING, plural } from '../../lib/format.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import {
  approvalText,
  approvalTone,
  BATCH_READ_ONLY,
  batchFormProblem,
  batchStartedPhrase,
  batchStateWord,
  batchTone,
  canStartBatch,
  costText,
  DEFAULT_DOC_TYPE,
  describeExtractionError,
  docTypeOptions,
  EXTRACTION_FORBIDDEN,
  EXTRACTION_META,
  flagsText,
  isRunState,
  RUN_STATES,
  runsByState,
  runStateWord,
  runTone,
  tokensText,
} from './extraction.js';
import type { BatchForm } from './extraction.js';
import './extraction.css';

/**
 * The batch form (operations): every Classified document of a type for a quarter end. The
 * API processes the batch before it answers, so the button stays busy until every run is
 * terminal; a refusal (the kill switch, no document for the period) reads as its own sentence.
 * Rendered for the roles that may start a batch only, so the taxonomy is read for them alone.
 */
function BatchForm(): ReactNode {
  const periodId = useId();
  const typeId = useId();
  const taxonomy = useQuery(taxonomyQuery);
  const log = useActionLog();
  const start = useStartExtractionBatch();
  const [form, setForm] = useState<BatchForm>({ periodEnd: '', docType: DEFAULT_DOC_TYPE });
  const [touched, setTouched] = useState(false);
  const problem = batchFormProblem(form);
  const types = docTypeOptions(taxonomy.data);
  const typeLabel = types.find((t) => t.code === form.docType)?.label ?? labelOf(form.docType);
  return (
    <>
      <form
        className="pb-extraction-form"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (problem !== null) return;
          const body = { periodEnd: form.periodEnd.trim(), docType: form.docType };
          start.mutate(body, {
            onSuccess: (batch) =>
              log.record('good', `${batchStartedPhrase(batch)} ${resultSuffix()}`),
            onError: (error) =>
              log.record('bad', `Start extraction: ${describeExtractionError(error)}`),
          });
        }}
      >
        <Field>
          <Label htmlFor={periodId}>Period end</Label>
          <Input
            id={periodId}
            className="pb-extraction-period"
            placeholder="YYYY-MM-DD"
            inputMode="numeric"
            value={form.periodEnd}
            onChange={(_e, d) => setForm({ ...form, periodEnd: d.value })}
            onBlur={() => setTouched(true)}
          />
        </Field>
        <Field>
          <Label htmlFor={typeId}>Document type</Label>
          <Dropdown
            id={typeId}
            className="pb-extraction-filter"
            value={typeLabel}
            selectedOptions={[form.docType]}
            onOptionSelect={(_e, d) => setForm({ ...form, docType: d.optionValue ?? '' })}
          >
            {types.map((t) => (
              <Option key={t.code} value={t.code} text={t.label}>
                {t.label}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Button type="submit" appearance="primary" disabledFocusable={start.isPending}>
          Start extraction
        </Button>
        {touched && problem !== null ? (
          <p className="pb-extraction-form-problem" role="alert">
            {problem}
          </p>
        ) : null}
        <p className="pb-notice">
          Every Classified document of the type for that quarter is read, redacted and sent to the
          extraction model; the values wait in staging for review. Only quarterly financials have an
          extraction schema today.
        </p>
      </form>
      <ActionStatus latest={log.latest} testId="extraction-action-status" />
    </>
  );
}

function BatchCard({ roles }: { roles: readonly string[] }): ReactNode {
  return (
    <Card testId="extraction-batch-form">
      <SectionHeader aside={<SimulatedBadge />}>Start a batch</SectionHeader>
      {canStartBatch(roles) ? (
        <BatchForm />
      ) : (
        <p className="pb-meta" data-testid="extraction-read-only">
          {BATCH_READ_ONLY}
        </p>
      )}
    </Card>
  );
}

function BatchesTable({ batches }: { batches: readonly ExtractionBatch[] }): ReactNode {
  return (
    <TableWrap label="Extraction batches">
      <table className="pb-table" aria-label="Extraction batches" data-testid="extraction-batches">
        <thead>
          <tr>
            <th>Started</th>
            <th>State</th>
            <th className="num">Progress</th>
            <th>Runs</th>
            <th>Tokens</th>
            <th className="num">Cost</th>
            <th>Requested by</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td className="pb-nowrap">{formatDateTime(b.createdAt)}</td>
              <td>
                <Badge tone={batchTone(b.state)}>{batchStateWord(b.state)}</Badge>
                {b.errorCode === null ? null : <span className="pb-cell-sub">{b.errorCode}</span>}
              </td>
              <NumCell>{`${b.progress}%`}</NumCell>
              <td>
                <span>{plural(b.runs.total, 'run')}</span>
                <span className="pb-cell-sub">{runsByState(b)}</span>
              </td>
              <td className="pb-nowrap">{tokensText(b.tokensIn, b.tokensOut)}</td>
              <NumCell>{costText(b.costUsd)}</NumCell>
              <td>{b.requestedBy ?? MISSING}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** "1 batch", "3 batches": plural() adds an s, which this noun does not take. */
function batchesText(n: number): string {
  return n === 1 ? '1 batch' : `${n} batches`;
}

function BatchesCard(): ReactNode {
  const q = useQuery(extractionBatchesQuery);
  return (
    <Card testId="extraction-batches-card">
      <SectionHeader aside={q.data === undefined ? undefined : batchesText(q.data.items.length)}>
        Batches
      </SectionHeader>
      {q.isPending ? (
        <PageSkeleton rows={3} />
      ) : q.isError ? (
        <UnavailableState
          error={q.error}
          subject="Extraction batches"
          forbidden={EXTRACTION_FORBIDDEN}
          errorTitle="Extraction batches unavailable"
          testId="extraction-batches-unavailable"
        />
      ) : q.data.items.length === 0 ? (
        <EmptyState
          title="No batches yet"
          detail="A batch queues one run per document; it appears here with its progress, tokens and cost."
          testId="extraction-batches-empty"
        />
      ) : (
        <>
          <BatchesTable batches={q.data.items} />
          {q.data.nextCursor === null ? null : (
            <p className="pb-meta">Showing the latest {LIST_LIMIT} batches; more exist.</p>
          )}
        </>
      )}
    </Card>
  );
}

function RunsTable({ runs }: { runs: readonly ExtractionRun[] }): ReactNode {
  return (
    <TableWrap label="Extraction runs">
      <table className="pb-table" aria-label="Extraction runs" data-testid="extraction-runs">
        <thead>
          <tr>
            <th>Document</th>
            <th>Company</th>
            <th>Period</th>
            <th>State</th>
            <th>Flags</th>
            <th>Approval</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <span>{r.documentTitle}</span>
                <span className="pb-cell-sub">{r.fileName}</span>
              </td>
              <td>
                {r.investmentId === null ? (
                  <span>{r.companyName ?? MISSING}</span>
                ) : (
                  <Link to="/portfolio/$id" params={{ id: r.investmentId }}>
                    {r.companyName ?? r.investmentNumber ?? r.investmentId}
                  </Link>
                )}
                {r.investmentNumber === null ? null : (
                  <span className="pb-cell-sub">
                    <span className="pb-key">{r.investmentNumber}</span>
                  </span>
                )}
              </td>
              <td className="pb-nowrap">{formatDate(r.periodEnd)}</td>
              <td>
                <Badge tone={runTone(r.state)}>{runStateWord(r.state)}</Badge>
                {r.errorCode === null ? null : <span className="pb-cell-sub">{r.errorCode}</span>}
              </td>
              <td>{flagsText(r.counts)}</td>
              <td>
                <Badge tone={approvalTone(r)}>{approvalText(r)}</Badge>
              </td>
              <td>
                <Link
                  to="/documents/extraction/$id"
                  params={{ id: r.id }}
                  aria-label={`Review ${r.fileName}`}
                >
                  Review
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function RunsCard(): ReactNode {
  const stateId = useId();
  const [state, setState] = useState<ExtractionRunState | ''>('');
  const runs = useInfiniteQuery({
    ...extractionRunsQuery(state === '' ? {} : { state }),
    placeholderData: keepPreviousData,
  });
  const items = runs.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card testId="extraction-runs-card">
      <SectionHeader aside={runs.data === undefined ? undefined : plural(items.length, 'run')}>
        Runs
      </SectionHeader>
      <Toolbar>
        <Field>
          <Label htmlFor={stateId}>State</Label>
          <Dropdown
            id={stateId}
            className="pb-extraction-filter"
            value={state === '' ? 'All states' : runStateWord(state)}
            selectedOptions={[state]}
            onOptionSelect={(_e, d) => {
              const v = d.optionValue ?? '';
              setState(isRunState(v) ? v : '');
            }}
          >
            <Option value="">All states</Option>
            {RUN_STATES.map((s) => (
              <Option key={s} value={s}>
                {runStateWord(s)}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </Toolbar>
      {runs.isPending ? (
        <PageSkeleton rows={4} />
      ) : runs.isError ? (
        <UnavailableState
          error={runs.error}
          subject="Extraction runs"
          forbidden={EXTRACTION_FORBIDDEN}
          errorTitle="Extraction runs unavailable"
          testId="extraction-runs-unavailable"
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={state === '' ? 'No extraction runs yet' : 'No runs in this state'}
          detail={
            state === ''
              ? 'Start a batch above, or wait for one; each run appears here with its state, flags and approval.'
              : 'Pick another state, or all states.'
          }
          testId="extraction-runs-empty"
        />
      ) : (
        <RunsTable runs={items} />
      )}
      {runs.hasNextPage ? (
        <p className="pb-extraction-more">
          <Button
            size="small"
            appearance="secondary"
            disabled={runs.isFetchingNextPage}
            onClick={() => void runs.fetchNextPage()}
          >
            Load more runs
          </Button>
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Extraction (docs/04 M4, docs/18 section 7, decision 0012): the batches that queued runs over
 * the hub's documents, the runs with their state, flags and approval, and for operations the
 * form that starts a batch. Each run is reviewed on its own page before anything is promoted.
 */
export function ExtractionPage(): ReactNode {
  const me = useQuery(meQuery);
  // The roles decide what the batch card says, so nothing is said until they are known.
  if (me.isPending) return <PageSkeleton rows={6} />;
  return (
    <>
      <PageHeader title="Extraction" meta={EXTRACTION_META} />
      <TabNav label="Documents" items={DOCUMENTS_TABS} />
      <BatchCard roles={me.data?.roles ?? []} />
      <BatchesCard />
      <RunsCard />
    </>
  );
}
