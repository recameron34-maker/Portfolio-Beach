import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { meQuery } from '../../app/queries.js';
import { Card, EmptyState, PageSkeleton, SectionHeader } from '../../components/ui.js';
import { ClosingPanel } from '../pipeline/ClosingPanel.js';
import { useDealDetail } from './data.js';
import './deal.css';

/**
 * Closing tab (docs/04 M8): the closing record of this position, the single source of its close
 * date, with the checklist, the confirmation, the tie-out and the legal terms (M22). A position
 * with no closing record predates the pipeline.
 */
export function ClosingTab(): ReactNode {
  const detail = useDealDetail();
  const me = useQuery(meQuery);
  if (detail.isPending) return <PageSkeleton rows={4} />;
  const closingId = detail.data?.closingId ?? null;
  if (closingId === null) {
    return (
      <Card testId="deal-closing">
        <SectionHeader>Closing</SectionHeader>
        <EmptyState
          title="No closing record: this position predates the pipeline"
          detail="The close date, checklist and legal terms are recorded on the closing from Phase 3 on; deals closed through the pipeline carry them here."
          testId="deal-closing-empty"
        />
      </Card>
    );
  }
  return <ClosingPanel closingId={closingId} roles={me.data?.roles ?? []} />;
}
