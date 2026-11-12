import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Input, Label } from '@fluentui/react-components';
import type { IntakeFile, IntakeFilePage, LookthroughReconcileResult } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { dataHealthQuery, LIST_LIMIT, meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  TableWrap,
} from '../../components/ui.js';
import { formatDate, MISSING, plural } from '../../lib/format.js';
import { dayOf } from '../intake/intake.js';
import { lookthroughRunsQuery, useReconcile } from './lookthrough-queries.js';
import {
  asOfFromFileName,
  isReconcileDate,
  LOOKTHROUGH_FORBIDDEN,
  LOOKTHROUGH_META,
  NO_RUNS,
  runCountsLine,
  runStatusTone,
  runStatusWord,
} from './lookthrough.js';
import './lookthrough.css';

/** Operations only: reconcile the provider's extract for an as-of date. */
function RunCard({
  defaultAsOf,
  onReconciled,
}: {
  defaultAsOf: string;
  onReconciled: (result: LookthroughReconcileResult) => void;
}): ReactNode {
  const inputId = useId();
  const reconcile = useReconcile();
  const [asOf, setAsOf] = useState(defaultAsOf);
  const [message, setMessage] = useState<string | null>(null);
  const busy = reconcile.isPending;
  const valid = isReconcileDate(asOf);
  const run = (): void => {
    const date = asOf.trim();
    reconcile.mutate(
      { asOf: date },
      {
        onSuccess: (result) => {
          setMessage(null);
          onReconciled(result);
        },
        onError: (error) => setMessage(`Reconcile ${date}: ${describeActionError(error)}`),
      },
    );
  };
  return (
    <Card testId="lookthrough-run">
      <SectionHeader aside={<SimulatedBadge />}>Reconcile an extract</SectionHeader>
      <p className="pb-meta">
        The provider&apos;s extract for the date is read from the look-through folder, linked to the
        book, mapped onto the taxonomy and compared with the approved values. Every difference opens
        an exception; nothing on record changes.
      </p>
      <div className="pb-lookthrough-run">
        <div className="pb-field">
          <Label htmlFor={inputId}>As of</Label>
          <Input
            id={inputId}
            type="date"
            className="pb-lookthrough-date"
            value={asOf}
            disabled={busy}
            onChange={(_e, d) => setAsOf(d.value)}
          />
        </div>
        <Button size="small" appearance="primary" disabled={!valid || busy} onClick={run}>
          Reconcile
        </Button>
      </div>
      <div role="status" className="pb-lookthrough-run-status" data-testid="lookthrough-run-status">
        {message === null ? null : <p className="pb-notice pb-notice-bad">{message}</p>}
      </div>
    </Card>
  );
}

function RunsTable({ runs }: { runs: readonly IntakeFile[] }): ReactNode {
  return (
    <TableWrap label="Reconcile runs">
      <table
        className="pb-table pb-lookthrough-runs"
        aria-label="Reconcile runs"
        data-testid="lookthrough-runs"
      >
        <thead>
          <tr>
            <th>Run</th>
            <th>As of</th>
            <th>Reconciled</th>
            <th>By</th>
            <th className="num">Rows</th>
            <th>Result</th>
            <th>Rows by outcome</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const asOf = asOfFromFileName(run.fileName);
            return (
              <tr key={run.id}>
                <td>
                  <Link to="/data/lookthrough/$id" params={{ id: run.id }}>
                    {run.fileName}
                  </Link>
                </td>
                <td className="pb-nowrap">{asOf === null ? MISSING : formatDate(asOf)}</td>
                <td className="pb-nowrap">{dayOf(run.receivedAt)}</td>
                <td>{run.receivedBy ?? MISSING}</td>
                <NumCell>{String(run.rowCount)}</NumCell>
                <td>
                  <Badge tone={runStatusTone(run.status)}>{runStatusWord(run.status)}</Badge>
                </td>
                <td>{runCountsLine(run.counts)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

function RunsCard({ page, isOps }: { page: IntakeFilePage; isOps: boolean }): ReactNode {
  return (
    <Card testId="lookthrough-runs-card">
      <SectionHeader aside={page.items.length === 0 ? undefined : plural(page.items.length, 'run')}>
        Reconcile runs
      </SectionHeader>
      {page.items.length === 0 ? (
        <EmptyState title="No reconcile runs yet" detail={isOps ? NO_RUNS.ops : NO_RUNS.others} />
      ) : (
        <RunsTable runs={page.items} />
      )}
      {page.nextCursor !== null ? (
        <p className="pb-meta" data-testid="lookthrough-runs-truncated">
          Showing the first {LIST_LIMIT} runs; more exist.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Look-through (docs/04 M2 lookthrough-reconcile, decision 0010): the reconcile runs, newest
 * first, and for operations the card that runs another. A run compares and opens exceptions; it
 * never writes a value, so there is nothing to approve here.
 */
export function LookthroughPage(): ReactNode {
  const me = useQuery(meQuery);
  const health = useQuery(dataHealthQuery);
  const runs = useQuery({ ...lookthroughRunsQuery, placeholderData: keepPreviousData });
  const navigate = useNavigate();
  if (runs.isPending || me.isPending || health.isPending) return <PageSkeleton rows={6} />;
  if (runs.isError) {
    return (
      <>
        <PageHeader title="Look-through" meta={LOOKTHROUGH_META} />
        <UnavailableState
          card
          error={runs.error}
          subject="Look-through"
          forbidden={LOOKTHROUGH_FORBIDDEN}
          errorTitle="Look-through unavailable"
          testId="lookthrough-unavailable"
        />
      </>
    );
  }
  const isOps = (me.data?.roles ?? []).includes('operations');
  return (
    <>
      <PageHeader title="Look-through" meta={LOOKTHROUGH_META} />
      {isOps ? (
        <RunCard
          // The record's as-of date (Data Health) is the usual date to reconcile for.
          defaultAsOf={health.data?.asOf ?? ''}
          onReconciled={(result) =>
            void navigate({
              to: '/data/lookthrough/$id',
              params: { id: result.id },
              search: result.duplicate ? { duplicate: true } : {},
            })
          }
        />
      ) : null}
      <RunsCard page={runs.data} isOps={isOps} />
    </>
  );
}
