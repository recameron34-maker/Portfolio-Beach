import { ProblemError } from './problem.js';

/*
 * Readers for values in config/definitions.json (injected as DEFINITIONS). A missing or malformed
 * key is a configuration problem (500), never a silent default (CLAUDE.md rule 9).
 */

export const configError = (key: string): ProblemError =>
  new ProblemError(500, 'configuration', `config/definitions.json is missing a usable ${key}`);

/** A whole number of zero or more (days, counts, quarters). */
export function configInteger(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw configError(key);
  return value;
}

/** A non-empty list of whole numbers of zero or more, in config order. */
export function configIntegerList(value: unknown, key: string): number[] {
  if (!Array.isArray(value) || value.length === 0) throw configError(key);
  return value.map((item: unknown) => configInteger(item, key));
}
