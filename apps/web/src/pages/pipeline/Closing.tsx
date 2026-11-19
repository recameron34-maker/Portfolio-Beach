import type { ReactNode } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client.js';
import { meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Breadcrumbs,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  PageSkeleton,
} from '../../components/ui.js';
import { formatMoneyM, labelOf } from '../../lib/format.js';
import { opportunityQuery } from './api.js';
import { ClosingPanel } from './ClosingPanel.js';
import { StageWord } from './Opportunity.js';
import './pipeline.css';

const BOARD = { label: 'Pipeline', to: '/pipeline' };

/** Where the closing page sits: the board, then the opportunity it closes. */
function trail(id: string, name: string): { label: string; to: string }[] {
  return [BOARD, { label: name, to: `/pipeline/${id}` }];
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
    // The opportunity's id is in the route even when its name could not be read, so a failed load
    // still leads back to it; a deal that is not found or not visible has no page to go back to.
    return (
      <>
        <Breadcrumbs
          items={hidden ? [BOARD] : [BOARD, { label: 'Opportunity', to: `/pipeline/${id}` }]}
        />
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
      <PageHeader
        testId="closing-banner"
        crumbs={trail(id, d.name)}
        title={`Closing: ${d.name}`}
        meta={
          <span className="pb-meta-list">
            <span>{d.companyName}</span>
            <span>{labelOf(d.dealType)}</span>
            <span>Target {formatMoneyM(d.targetCommitment)}</span>
          </span>
        }
        actions={<StageWord stage={d.stage} daysInStage={d.daysInStage} />}
      />
      {d.closing === null ? (
        <Card>
          <EmptyState
            title="No closing record yet"
            detail="The closing opens when the deal advances from Approved with a close date and a commitment."
            testId="closing-page-empty"
          />
        </Card>
      ) : (
        <ClosingPanel closingId={d.closing.id} roles={me.data?.roles ?? []} />
      )}
    </>
  );
}
