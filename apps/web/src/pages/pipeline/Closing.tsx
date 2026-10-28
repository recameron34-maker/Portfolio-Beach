import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client.js';
import { meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  PageSkeleton,
} from '../../components/ui.js';
import { formatMoneyM, labelOf } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';
import { opportunityQuery } from './api.js';
import { ClosingPanel } from './ClosingPanel.js';
import { stageTone } from '../../lib/states.js';
import './pipeline.css';

function BackLink({ id }: { id: string }): ReactNode {
  return (
    <p className="pb-meta pb-pipe-back">
      <Link to="/pipeline/$id" params={{ id }}>
        Back to the opportunity
      </Link>
    </p>
  );
}

/** The closing page of an opportunity (docs/04 M8): the panel over the record the opportunity names. */
export function ClosingPage(): ReactNode {
  const { id } = useParams({ from: '/app/pipeline/$id/closing' });
  const me = useQuery(meQuery);
  const q = useQuery(opportunityQuery(id));
  if (q.isPending) return <PageSkeleton tiles={3} rows={8} />;
  if (q.isError) {
    const hidden =
      q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <>
        <BackLink id={id} />
        {hidden ? (
          <ErrorState
            title="Opportunity not found or not visible to you"
            detail="There is no opportunity with this id in your view of the pipeline."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This opportunity"
            errorTitle="Opportunity unavailable"
            testId="closing-page-unavailable"
          />
        )}
      </>
    );
  }
  const d = q.data;
  return (
    <>
      <BackLink id={id} />
      <PageHeader
        testId="closing-banner"
        title={`Closing: ${d.name}`}
        meta={
          <span className="pb-meta-list">
            <span>{d.companyName}</span>
            <span>{labelOf(d.dealType)}</span>
            <span>Target {formatMoneyM(d.targetCommitment)}</span>
          </span>
        }
        actions={<Badge tone={stageTone(d.stage)}>{humanizeState(d.stage)}</Badge>}
      />
      {d.closing === null ? (
        <Card>
          <EmptyState
            title="No closing record yet"
            detail="The closing opens when the deal advances from Approved with a close date and a commitment (docs/04 M8)."
            testId="closing-page-empty"
          />
        </Card>
      ) : (
        <ClosingPanel closingId={d.closing.id} roles={me.data?.roles ?? []} />
      )}
    </>
  );
}
