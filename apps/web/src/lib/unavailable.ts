import { ApiError } from '../api/client.js';

/** Why a read cannot be shown: the role may not see it (403) or the endpoint is not built yet (501). */
export interface UnavailableReason {
  title: string;
  detail: string;
}

/**
 * A 403 or 501 degrades to an empty state that says who can see the data or that it is not
 * available; any other failure is a real error and returns null so the caller shows it as one.
 */
export function unavailable(error: unknown, subject: string): UnavailableReason | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 403) {
    return {
      title: `${subject}: not visible to your role`,
      detail:
        'Only roles entitled to this data can see it. Ask a platform administrator if you need access.',
    };
  }
  if (error.status === 501) {
    return {
      title: `${subject}: not available yet`,
      detail:
        'The endpoint behind this view is not built in this version. The view fills in once it lands.',
    };
  }
  return null;
}
