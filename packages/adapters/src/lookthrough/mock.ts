import type { ExposureRow, HealthStatus, LookThroughProvider } from '../types.js';

/** Synthetic exposure rows (the look-through data provider's extract in production). */
export class FixtureLookThroughProvider implements LookThroughProvider {
  readonly info = {
    name: 'lookthrough.fixtures',
    kind: 'mock',
    killSwitch: 'adapter.lookthrough',
  } as const;
  constructor(private readonly rows: readonly ExposureRow[]) {}

  fetchExposures(asOf: string): Promise<ExposureRow[]> {
    return Promise.resolve(this.rows.filter((r) => r.asOf === asOf));
  }

  healthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ ok: true, detail: `${this.rows.length} fixture rows` });
  }
}
