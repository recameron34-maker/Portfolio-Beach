import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import { Card, EmptyState, ErrorState, PageSkeleton, SectionHeader } from '../../components/ui.js';
import { opportunityQuery } from '../pipeline/api.js';
import { DiligenceTasksCard } from '../pipeline/DiligenceTasks.js';
import { IcDecisionsCard } from '../pipeline/IcDecisions.js';
import { useDealDetail } from './data.js';
import './deal.css';

const NO_RECORD = 'No diligence record: this position predates the pipeline';

function DiligenceRecord({ opportunityId }: { opportunityId: string }): ReactNode {
  const q = useQuery(opportunityQuery(opportunityId));
  if (q.isPending) return <PageSkeleton rows={6} />;
  if (q.isError) {
    const hidden =
      q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return hidden ? (
      <ErrorState
        title="Diligence record not visible to you"
        detail="The opportunity this position came from sits behind an information wall you are not on."
      />
    ) : (
      <UnavailableState
        card
        error={q.error}
        subject="The diligence record"
        errorTitle="Diligence record could not load"
        testId="deal-diligence-unavailable"
      />
    );
  }
  const d = q.data;
  return (
    <>
      <DiligenceTasksCard
        opportunityId={d.id}
        tasks={d.diligenceTasks}
        roles={[]}
        log={null}
        readOnly
      />
      <IcDecisionsCard
        opportunityId={d.id}
        stage={d.stage}
        decisions={d.icDecisions}
        roles={[]}
        log={null}
        readOnly
      />
      <p className="pb-meta pb-deal-note">
        Read only here.{' '}
        <Link to="/pipeline/$id" params={{ id: d.id }}>
          Open the opportunity
        </Link>{' '}
        ({d.name}) for the tasks, decisions and stage history as the pipeline records them.
      </p>
    </>
  );
}

/**
 * Diligence tab (docs/04 M7 skeleton): the diligence tasks and IC decisions of the opportunity
 * this position came from, read only. A position that predates the pipeline has none.
 */
export function DiligenceTab(): ReactNode {
  const detail = useDealDetail();
  if (detail.isPending) return <PageSkeleton rows={4} />;
  const opportunityId = detail.data?.opportunityId ?? null;
  if (opportunityId === null) {
    return (
      <Card testId="deal-diligence">
        <SectionHeader>Diligence</SectionHeader>
        <EmptyState
          title={NO_RECORD}
          detail="Diligence tasks and IC decisions are recorded on the pipeline from Phase 3 on; deals logged there carry them into the workspace on close."
          testId="deal-diligence-empty"
        />
      </Card>
    );
  }
  return <DiligenceRecord opportunityId={opportunityId} />;
}
