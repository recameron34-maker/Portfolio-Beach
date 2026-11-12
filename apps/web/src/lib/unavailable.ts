import { ApiError } from '../api/client.js';

/** Why a read cannot be shown: the role may not see it (403) or the endpoint is not built yet (501). */
export interface UnavailableReason {
  title: string;
  detail?: string | undefined;
}

/** Page-specific wording that replaces the generic sentences, for example who can see the data. */
export interface UnavailableWording {
  forbidden?: UnavailableReason | undefined;
  notReady?: UnavailableReason | undefined;
}

/**
 * A 403 or 501 degrades to an empty state that says who can see the data or that it is not
 * available; any other failure is a real error and returns null so the caller shows it as one.
 */
export function unavailable(
  error: unknown,
  subject: string,
  wording: UnavailableWording = {},
): UnavailableReason | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 403) {
    return (
      wording.forbidden ?? {
        title: `${subject}: not visible to your role`,
        detail:
          'Only roles entitled to this data can see it. Ask a platform administrator if you need access.',
      }
    );
  }
  if (error.status === 501) {
    return (
      wording.notReady ?? {
        title: `${subject}: not available yet`,
        detail:
          'The endpoint behind this view is not built in this version. The view fills in once it lands.',
      }
    );
  }
  return null;
}

/** A read that a retry cannot change: hidden from the role, not found, or not built yet. */
export function isUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 403 || error.status === 404 || error.status === 501)
  );
}

/**
 * TanStack Query retry policy: one retry for a transient server or network failure, none for a
 * client error (4xx) or a read that cannot change on a retry.
 */
export function retryUnlessUnavailable(failureCount: number, error: unknown): boolean {
  if (isUnavailable(error)) return false;
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 1;
}
