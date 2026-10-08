import type { ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { Card, EmptyState, ErrorState } from '../../components/ui.js';

export interface Said {
  title: string;
  detail?: string | undefined;
}

/**
 * A failed read, said plainly. A 403 (a role without access) and a 501 (an endpoint still to be
 * built) are expected outcomes and render as empty states that say who can see the data or that it
 * is not available yet; anything else is an error card.
 */
export function Unavailable({
  error,
  forbidden,
  notReady,
  errorTitle,
  testId,
}: {
  error: unknown;
  forbidden: Said;
  notReady: Said;
  errorTitle: string;
  testId?: string | undefined;
}): ReactNode {
  const status = error instanceof ApiError ? error.status : null;
  if (status === 403) {
    return (
      <Card>
        <EmptyState title={forbidden.title} detail={forbidden.detail} testId={testId} />
      </Card>
    );
  }
  if (status === 501) {
    return (
      <Card>
        <EmptyState title={notReady.title} detail={notReady.detail} testId={testId} />
      </Card>
    );
  }
  return (
    <ErrorState
      title={errorTitle}
      detail={error instanceof Error ? error.message : 'The request failed.'}
    />
  );
}
