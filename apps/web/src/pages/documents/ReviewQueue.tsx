import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DOCUMENTS_TABS } from '../../app/nav.js';
import { LIST_LIMIT, reviewQueueQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Card,
  EmptyState,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  TabNav,
} from '../../components/ui.js';
import { plural } from '../../lib/format.js';
import { REVIEW_QUEUE_META } from './documents.js';
import { DocumentsTable } from './DocumentsTable.js';
import './documents.css';

/**
 * The review queue (docs/04 M3, docs/18 section 6): every NeedsReview document the signed-in
 * user may see, newest first; the classifier's confidence fell short of the threshold, a file
 * could not be read, or the model call failed. Each row opens the document, where the deal team
 * or operations names its type and links.
 */
export function ReviewQueuePage(): ReactNode {
  const q = useQuery(reviewQueueQuery);
  return (
    <>
      <PageHeader title="Review queue" meta={REVIEW_QUEUE_META} />
      <TabNav label="Documents" items={DOCUMENTS_TABS} />
      <Card testId="review-queue-card">
        <SectionHeader
          aside={
            q.data === undefined || q.data.items.length === 0
              ? undefined
              : plural(q.data.items.length, 'document')
          }
        >
          Waiting for a person
        </SectionHeader>
        {q.isPending ? (
          <PageSkeleton rows={4} />
        ) : q.isError ? (
          <UnavailableState
            error={q.error}
            subject="The review queue"
            errorTitle="Review queue unavailable"
            testId="review-queue-unavailable"
          />
        ) : q.data.items.length === 0 ? (
          <EmptyState
            title="Nothing waits for review"
            detail="Every indexed document was classified above the confidence threshold. A document the classifier is unsure about appears here until a person classifies it."
            testId="review-queue-empty"
          />
        ) : (
          <DocumentsTable items={q.data.items} label="Review queue" testId="review-queue" />
        )}
        {q.data !== undefined && q.data.nextCursor !== null ? (
          <p className="pb-meta" data-testid="review-queue-truncated">
            Showing the first {LIST_LIMIT} documents; more wait.
          </p>
        ) : null}
      </Card>
    </>
  );
}
