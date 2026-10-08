import { D } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import { DECIMAL_PATTERN } from '@pb/contracts';
import { ProblemError } from './problem.js';

/*
 * Readers for the calculation settings in config/definitions.json (injected as DEFINITIONS). A
 * missing or malformed key is a 500 'configuration' problem that names the key, never a silent
 * default in code (CLAUDE.md rules 9 and 10): the figures it drives would otherwise change without
 * anyone deciding so. Every service reads its keys through these.
 */

/** The problem for a key that is missing or cannot be read. */
export const configError = (key: string): ProblemError =>
  new ProblemError(500, 'configuration', `config/definitions.json is missing a usable ${key}`);

/** A whole number of zero or more, such as a day count or a number of quarters. */
export function configInteger(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw configError(key);
  return value;
}

/** A rate or threshold as a Decimal, from a finite JSON number or a decimal string. */
export function configDecimal(value: unknown, key: string): Decimal {
  if (typeof value === 'number' && Number.isFinite(value)) return D(String(value));
  if (typeof value === 'string' && DECIMAL_PATTERN.test(value)) return D(value);
  throw configError(key);
}

/** A label or a sentence template, such as a footnote: a string with some text in it. */
export function configString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw configError(key);
  return value;
}

/** A non-empty list of whole numbers of zero or more, in config order. */
export function configIntegerList(value: unknown, key: string): number[] {
  if (!Array.isArray(value) || value.length === 0) throw configError(key);
  return value.map((item: unknown) => configInteger(item, key));
}
