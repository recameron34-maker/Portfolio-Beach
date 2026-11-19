import type { ReactNode } from 'react';
import { unavailable } from '../lib/unavailable.js';
import type { UnavailableReason } from '../lib/unavailable.js';
import { Card, EmptyState, ErrorState } from './ui.js';

/**
 * What a failed read shows. A 403 or 501 becomes an empty state that names the reason (who can
 * see the data, or that it is not built yet), flat like every empty state, with no icon: the
 * title already says it. Anything else is an error. inline renders that error as a notice so it
 * can sit in a section next to other content; card puts the empty state in a section of its own
 * when it stands alone on a page.
 */
export function UnavailableState({
  error,
  subject,
  inline = false,
  card = false,
  forbidden,
  notReady,
  errorTitle,
  testId,
}: {
  error: unknown;
  subject: string;
  inline?: boolean;
  card?: boolean;
  forbidden?: UnavailableReason | undefined;
  notReady?: UnavailableReason | undefined;
  errorTitle?: string | undefined;
  testId?: string | undefined;
}): ReactNode {
  const why = unavailable(error, subject, { forbidden, notReady });
  if (why !== null) {
    const empty = <EmptyState title={why.title} detail={why.detail} testId={testId} />;
    return card ? <Card>{empty}</Card> : empty;
  }
  const detail = error instanceof Error ? error.message : undefined;
  if (inline) {
    return (
      <p className="pb-notice pb-notice-bad" data-testid={testId}>
        {subject} could not load{detail === undefined ? '.' : `: ${detail}`}
      </p>
    );
  }
  return <ErrorState title={errorTitle ?? `${subject} could not load`} detail={detail} />;
}
