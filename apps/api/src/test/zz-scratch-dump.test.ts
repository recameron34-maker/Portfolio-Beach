import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

describe('scratch dump (not committed)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  it('dumps', async () => {
    const out: Record<string, unknown> = {};
    for (const who of ['viewer.one', 'deal.three']) {
      const res = await h
        .http()
        .get(`/api/v1/analytics/value-creation?asOf=${h.dataset.asOf}`)
        .set('authorization', h.as(who))
        .expect(200);
      out[who] = res.body;
    }
    out.asOf = h.dataset.asOf;
    out.scenarios = h.dataset.scenarios;
    out.users = h.dataset.users.map((u) => ({ externalId: u.externalId, roles: u.roles }));
    writeFileSync(process.env.PB_DUMP_OUT ?? '/dev/null', JSON.stringify(out, null, 1));
  });
});
