import type { ReactNode } from 'react';
import { unavailable } from '../lib/unavailable.js';
import { EmptyState, ErrorState } from './ui.js';

/**
 * What a failed read shows. A 403 or 501 becomes an empty state that names the reason (who can
 * see the data, or that it is not built yet); anything else is an error. inline renders that
 * error as a notice so it can sit inside a card next to other content.
 */
export function UnavailableState({
  error,
  subject,
  inline = false,
  testId,
}: {
  error: unknown;
  subject: string;
  inline?: boolean;
  testId?: string | undefined;
}): ReactNode {
  const why = unavailable(error, subject);
  if (why !== null) return <EmptyState title={why.title} detail={why.detail} testId={testId} />;
  const detail = error instanceof Error ? error.message : undefined;
  if (inline) {
    return (
      <p className="pb-notice pb-notice-bad" data-testid={testId}>
        {subject} could not load{detail === undefined ? '.' : `: ${detail}`}
      </p>
    );
  }
  return <ErrorState title={`${subject} could not load`} detail={detail} />;
}
