import { describe, expect, it } from 'vitest';
import { problemDetails } from '@pb/contracts';
import { toCsv } from '@pb/validation';
import { valueCreationFixture, VC_ID } from '../../pages/analytics/value-creation.fixtures.js';
import { getKey } from '../keys.js';
import { createPreviewFetch } from '../shim.js';
import { USERS, buildWorld, send } from '../test-fixtures.js';

/*
 * The simulated value creation export (routes/valueCreation.ts): the recorded CSV of a credential,
 * narrowed to the rows of its recorded view that pass the filters the page sends.
 */

const VIEW = '/api/v1/analytics/value-creation';
const EXPORT = '/api/v1/analytics/value-creation/export';
const never: typeof fetch = () =>
  Promise.reject(new Error('real fetch must not be called for API routes'));

const view = valueCreationFixture();
const header = ['investmentNumber', 'companyName', 'status', 'investmentId'];
/** The recorded file: one line per position, a company name with a comma among them. */
const lines = view.positions.map((p) => [
  p.investmentNumber,
  p.id === VC_ID.kelp ? 'Kelp Forest Foods, Inc' : p.companyName,
  p.status,
  p.id,
]);
const csv = toCsv(header, lines);

function world(who: string, recordView = true): typeof fetch {
  const { fixtures } = buildWorld();
  const add = (path: string, text: string, contentType: string): void => {
    const hash = `vc-${path}`;
    fixtures.bodies[hash] = text;
    fixtures.responses[getKey(who, path)] = { status: 200, contentType, body: hash };
  };
  add(EXPORT, csv, 'text/csv; charset=utf-8');
  if (recordView) add(VIEW, JSON.stringify(view), 'application/json');
  return createPreviewFetch(fixtures, never);
}

describe('preview: the value creation export under filters', () => {
  const who = USERS.viewer.externalId;

  it('replays the recorded file when no filter is set', async () => {
    const answer = await send(world(who), who, 'GET', EXPORT, undefined, { accept: 'text/csv' });
    expect(answer.status).toBe(200);
    expect(answer.text).toBe(csv);
    expect(answer.headers.get('content-type')).toContain('text/csv');
  });

  it('keeps the lines of the positions the filters leave, by the rule the API applies', async () => {
    const f = world(who);
    const one = await send(f, who, 'GET', `${EXPORT}?vehicleId=${VC_ID.vehicle}`);
    expect(one.status).toBe(200);
    expect(one.headers.get('content-type')).toContain('text/csv');
    expect(one.headers.get('content-disposition')).toBe(
      `attachment; filename="value-creation-${view.asOf}.csv"`,
    );
    // Saltmarsh and Tidepool are in that vehicle; the file's own lines, untouched.
    expect(one.text).toBe(toCsv(header, [lines[0]!, lines[2]!]));
    const realized = await send(f, who, 'GET', `${EXPORT}?status=realized`);
    expect(realized.text).toBe(toCsv(header, [lines[3]!]));
    // A quoted cell survives the narrowing as the API wrote it.
    const cv = await send(f, who, 'GET', `${EXPORT}?dealType=deal_type.cv_single_asset`);
    expect(cv.text).toBe(toCsv(header, [lines[1]!]));
    expect(cv.text).toContain('"Kelp Forest Foods, Inc"');
    const both = await send(f, who, 'GET', `${EXPORT}?entryYear=2021&vehicleId=${VC_ID.vehicle}`);
    expect(both.text).toBe(toCsv(header, [lines[0]!]));
    // A filter that leaves nothing answers the header alone, as the API does.
    const none = await send(f, who, 'GET', `${EXPORT}?entryYear=1999`);
    expect(none.status).toBe(200);
    expect(none.text).toBe(toCsv(header, []));
  });

  it('refuses what the contract refuses, and answers nothing it has no recording for', async () => {
    const f = world(who);
    for (const query of ['status=held', 'entryYear=19', 'vehicleId=nope', 'company=Kelp']) {
      const refused = await send(f, who, 'GET', `${EXPORT}?${query}`);
      expect(refused.status, query).toBe(400);
    }
    // Another as-of date was never recorded.
    const earlier = await send(f, who, 'GET', `${EXPORT}?asOf=2024-12-31&status=active`);
    expect(earlier.status).toBe(404);
    expect(problemDetails.parse(earlier.json).detail).toBe(
      'This request is outside the recorded preview',
    );
    // Without the recorded view there is nothing to judge the filters by.
    const blind = await send(world(who, false), who, 'GET', `${EXPORT}?status=active`);
    expect(blind.status).toBe(404);
    // A credential with no recorded file has none.
    const other = await send(f, USERS.ops.externalId, 'GET', `${EXPORT}?status=active`);
    expect(other.status).toBe(404);
  });
});
