/*
 * Postgres errors as the driver reports them behind the query error drizzle raises: the SQLSTATE
 * code and the constraint name travel on the cause chain. A service that lets the database enforce
 * a reference it cannot check itself (a client the caller may not read, SEC-5.2), or a unique key
 * two commands race for, reads them here to answer a plain problem instead of a 500.
 */

/** The SQLSTATE code of the database error behind `error`, if there is one. */
export function pgErrorCode(error: unknown): string | undefined {
  let cause: unknown = error;
  while (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cause = cause.cause;
  }
  return undefined;
}

/** The name of the constraint the database error names, if there is one. */
export function pgConstraint(error: unknown): string | undefined {
  let cause: unknown = error;
  while (cause instanceof Error) {
    const constraint = (cause as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string') return constraint;
    cause = cause.cause;
  }
  return undefined;
}

export const isForeignKeyViolation = (error: unknown): boolean => pgErrorCode(error) === '23503';

export const isUniqueViolation = (error: unknown): boolean => pgErrorCode(error) === '23505';
