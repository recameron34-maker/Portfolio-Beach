import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ExposureRow, HealthStatus, LookThroughProvider } from '../types.js';

const AS_OF = /^\d{4}-\d{2}-\d{2}$/;

const isText = (value: unknown): value is string => typeof value === 'string';

/** True when a parsed JSON value has the shape of an exposure row: every field present as text, the number text or null. */
function isExposureRow(value: unknown): value is ExposureRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    (row.investmentNumber === null || isText(row.investmentNumber)) &&
    isText(row.companyName) &&
    isText(row.sector) &&
    isText(row.geography) &&
    isText(row.exposureAtCost) &&
    isText(row.exposureAtNav) &&
    isText(row.asOf)
  );
}

/**
 * The look-through data provider's extract as a folder of JSON files, one per as-of date
 * (<root>/<asOf>.json, an array of ExposureRow), the way the synthetic generator writes them
 * (docs/14 section 8). A missing file answers no rows, so a reconcile for a date with no extract
 * stages nothing and refuses nothing; a file that is not an array of exposure rows is an error,
 * never a partial read.
 */
export class LocalFolderLookThroughProvider implements LookThroughProvider {
  readonly info = {
    name: 'lookthrough.local_folder',
    kind: 'mock',
    killSwitch: 'adapter.lookthrough',
  } as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async fetchExposures(asOf: string): Promise<ExposureRow[]> {
    // The as-of date is the file name: only a date-shaped name ever reaches the file system.
    if (!AS_OF.test(asOf)) throw new Error('invalid as-of date');
    let text: string;
    try {
      text = await readFile(join(this.root, `${asOf}.json`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every(isExposureRow))
      throw new Error(`look-through extract ${asOf}.json is not an array of exposure rows`);
    return parsed;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await readdir(this.root);
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { ok: true, detail: 'no extracts yet' };
      return { ok: false, detail: 'extract folder not readable' };
    }
  }
}
