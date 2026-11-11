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

/** True for a unique violation on the named constraint or unique index: the key two commands raced for. */
export const isUniqueViolationOn = (error: unknown, constraint: string): boolean =>
  isUniqueViolation(error) && pgConstraint(error) === constraint;

/** A SQLSTATE code: five characters, digits and capital letters (Postgres appendix A). */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * What a log line may say about a database error (docs/17 section 7, SEC-11.4): the SQLSTATE
 * code and the constraint and table the server names, or undefined when nothing on the cause
 * chain came from the database. Never the message: the query error drizzle raises spells out
 * the statement and every parameter in it ("Failed query: ... params: ..."), a fair value or a
 * bank detail included, and the driver's own message can quote a value (an invalid input, a
 * number out of range). A link counts as a database error when it carries a statement with its
 * parameters, or a SQLSTATE code with the severity the server sends beside it (a code alone
 * would also match a file system error such as EPERM).
 */
export function pgErrorSummary(
  error: unknown,
): { code: string | null; constraint: string | null; table: string | null } | undefined {
  let found = false;
  let code: string | null = null;
  let constraint: string | null = null;
  let table: string | null = null;
  let cause: unknown = error;
  while (cause instanceof Error) {
    const link = cause as {
      query?: unknown;
      params?: unknown;
      code?: unknown;
      severity?: unknown;
      constraint?: unknown;
      table?: unknown;
    };
    if (typeof link.query === 'string' && link.params !== undefined) found = true;
    if (
      typeof link.code === 'string' &&
      SQLSTATE.test(link.code) &&
      typeof link.severity === 'string'
    ) {
      found = true;
      code ??= link.code;
      if (typeof link.constraint === 'string') constraint ??= link.constraint;
      if (typeof link.table === 'string') table ??= link.table;
    }
    cause = cause.cause;
  }
  return found ? { code, constraint, table } : undefined;
}
