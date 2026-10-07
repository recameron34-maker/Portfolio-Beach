import type { BenchmarkProvider, HealthStatus, IndexPoint } from '../types.js';

/**
 * A deterministic synthetic index: quarter-end levels that grow at a code-specific drift with a
 * smooth, repeatable wobble. Licensed benchmark data replaces this at merge.
 */
export class SyntheticBenchmarkProvider implements BenchmarkProvider {
  readonly info = {
    name: 'benchmarks.synthetic',
    kind: 'mock',
    killSwitch: 'adapter.benchmarks',
  } as const;

  indexSeries(code: string, from: string, to: string): Promise<IndexPoint[]> {
    let seed = 0;
    for (const ch of code) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const quarterlyDrift = 1 + ((seed % 5) + 1) / 100; // 1% to 5% per quarter
    const points: IndexPoint[] = [];
    let level = 100;
    let year = Number(from.slice(0, 4));
    let quarter = Math.ceil(Number(from.slice(5, 7)) / 3);
    for (let i = 0; i < 400; i++) {
      const month = quarter * 3;
      const day = month === 6 || month === 9 ? 30 : 31;
      const date = `${year}-${String(month).padStart(2, '0')}-${day}`;
      if (date > to) break;
      if (date >= from) points.push({ date, level: level.toFixed(4) });
      const wobble = 1 + Math.sin((i + seed) * 0.7) * 0.03;
      level = level * quarterlyDrift * wobble;
      quarter++;
      if (quarter > 4) {
        quarter = 1;
        year++;
      }
    }
    return Promise.resolve(points);
  }

  healthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ ok: true });
  }
}
