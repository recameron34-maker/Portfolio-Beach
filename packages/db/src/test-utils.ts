import { expect } from 'vitest';

/** Drizzle wraps driver errors ("Failed query: ...") with the Postgres error as the cause. */
export function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(typeof current === 'string' ? current : JSON.stringify(current));
      break;
    }
  }
  return parts.join(' <- ');
}

/** Asserts that a database operation is rejected with a message (anywhere in the cause chain) matching the pattern. */
export async function expectDbRejection(
  operation: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown = null;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the operation to be rejected').not.toBeNull();
  expect(errorChain(caught)).toMatch(pattern);
}
