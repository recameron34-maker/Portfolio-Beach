import { describe, expect, it } from 'vitest';
import { valuationSuggestionPage } from '@pb/contracts';
import { createPreviewFetch } from '../shim.js';
import { USERS, buildWorld, problemOf, send, testBook } from '../test-fixtures.js';

/**
 * The valuation suggestions of the static preview while the session holds none (decision 0023):
 * the routes answer as the API answers a book with no suggestion, behind the contract's own role
 * guard, so the pages show their empty states and no request goes unanswered.
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const LIST = '/api/v1/valuation-suggestions';
const ID = '58000000-0000-4000-8000-000000000001';

function setup(): typeof fetch {
  return createPreviewFetch(buildWorld().fixtures, never, { book: testBook() });
}

describe('preview: valuation suggestions', () => {
  it('lists nothing for the roles that read, whatever the filters', async () => {
    const f = setup();
    for (const user of [USERS.ops, USERS.deal, USERS.head]) {
      for (const query of ['', '?state=all&limit=200', `?extractionRunId=${ID}&state=all`]) {
        const answer = await send(f, user.externalId, 'GET', `${LIST}${query}`);
        expect(answer.status, `${user.externalId} ${query}`).toBe(200);
        expect(answer.headers.get('x-pb-simulated')).toBe('true');
        expect(valuationSuggestionPage.parse(answer.json)).toEqual({
          items: [],
          nextCursor: null,
          openCount: 0,
          runOutcome: null,
        });
      }
    }
  });

  it('refuses the roles the contract does not admit, as the API does', async () => {
    const f = setup();
    for (const user of [USERS.viewer, USERS.admin]) {
      const answer = await send(f, user.externalId, 'GET', LIST);
      expect(answer.status, user.externalId).toBe(403);
      expect(problemOf(answer).code).toBe('forbidden');
    }
    const command = await send(f, USERS.deal.externalId, 'POST', `${LIST}/${ID}/commands`, {
      command: 'accept',
    });
    expect(command.status).toBe(403);
  });

  it('validates a request with the contract before it answers', async () => {
    const f = setup();
    const badState = await send(f, USERS.ops.externalId, 'GET', `${LIST}?state=Locked`);
    expect(badState.status).toBe(400);
    const badBody = await send(f, USERS.ops.externalId, 'POST', `${LIST}/${ID}/commands`, {
      command: 'dismiss',
    });
    expect(badBody.status).toBe(400);
  });

  it('answers 404 for any suggestion, since none exists', async () => {
    const f = setup();
    const detail = await send(f, USERS.ops.externalId, 'GET', `${LIST}/${ID}`);
    expect(detail.status).toBe(404);
    expect(problemOf(detail)).toEqual({
      code: 'not-found',
      detail: 'Valuation suggestion not found',
    });
    const command = await send(
      f,
      USERS.ops.externalId,
      'POST',
      `${LIST}/${ID}/commands`,
      { command: 'dismiss', reason: 'not ours' },
      { 'if-match': '"1"' },
    );
    expect(command.status).toBe(404);
    expect(problemOf(command).code).toBe('not-found');
  });
});
