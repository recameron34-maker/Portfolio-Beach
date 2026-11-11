import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetails, wireInstructionDetail, wireInstructionPage } from '@pb/contracts';
import type { WireInstructionRow } from '@pb/contracts';
import { forbiddenPairs, wireInstructionMachine } from '@pb/workflows';
import type { PreviewBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import {
  BANK_DETAILS,
  FUND_NAME,
  IDS,
  USERS,
  buildWorld,
  problemOf,
  send,
  testBook,
} from '../test-fixtures.js';

/**
 * The simulated wire register (docs/04 M16, docs/18 section 11, SEC-12.1 to SEC-12.3): who may
 * read it, the masked rows, the reveal from the book for operations and approvers, a version
 * proposed by hand, the callback by a second person, a rejection, the table's refusals.
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const LIST = '/api/v1/wire-instructions?limit=200';
const path = (id: string): string => `/api/v1/wire-instructions/${id}`;
const commands = (id: string): string => `${path(id)}/commands`;
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';

let ids = 0;
const env = {
  newId: (): string => `53000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

function setup(book: PreviewBook | null = testBook()): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  return { f: createPreviewFetch(buildWorld().fixtures, never, { env, state, book }), state };
}

const freshDetails = () => ({
  bankName: 'Meridian Clearing',
  accountName: FUND_NAME,
  accountNumber: '1234567890',
  routingCode: '021000021',
  reference: 'LP capital account',
});
const verify = {
  command: 'verify',
  callbackNumberSource: 'sponsor_website',
  callbackResult: 'confirmed',
};

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('the simulated wire register', () => {
  it('answers 403 to roles outside the register on every route; auditors and admins read, operations propose', async () => {
    const { f } = setup();
    for (const who of [USERS.viewer, USERS.deal, USERS.dealWall]) {
      expect((await send(f, who.externalId, 'GET', LIST)).status).toBe(403);
      expect((await send(f, who.externalId, 'GET', path(IDS.wire.Verified))).status).toBe(403);
      expect(
        (
          await send(f, who.externalId, 'POST', '/api/v1/wire-instructions', {
            sponsorFundId: IDS.fund,
            counterpartyName: 'x',
            bankDetails: freshDetails(),
          })
        ).status,
      ).toBe(403);
      expect(
        (await send(f, who.externalId, 'POST', commands(IDS.wire.Proposed), verify)).status,
      ).toBe(403);
    }
    expect(
      (
        await send(f, USERS.admin.externalId, 'POST', '/api/v1/wire-instructions', {
          sponsorFundId: IDS.fund,
          counterpartyName: 'x',
          bankDetails: freshDetails(),
        })
      ).status,
    ).toBe(403);
    expect((await send(f, USERS.admin.externalId, 'GET', LIST)).status).toBe(200);
  });

  it('lists every version newest first, masked, filtered by counterparty and state, paged without gaps', async () => {
    const { f } = setup();
    const page = wireInstructionPage.parse((await send(f, USERS.ops.externalId, 'GET', LIST)).json);
    expect(page.items.map((r) => r.id)).toEqual([
      IDS.wire.Proposed,
      IDS.wire.Rejected,
      IDS.wire.Verified,
      IDS.wire.verifiedFund2,
      IDS.wire.Superseded,
    ]);
    for (const r of page.items) {
      expect(r.bankDetailsMasked).toMatch(/^.+ \*{4}\d{4}$/);
      expect('bankDetails' in r).toBe(false);
    }
    expect(JSON.stringify(page)).not.toMatch(/accountNumber|routingCode/);
    const ofFund = wireInstructionPage.parse(
      (await send(f, USERS.ops.externalId, 'GET', `${LIST}&sponsorFundId=${IDS.fund}`)).json,
    );
    expect(ofFund.items.map((r) => r.version)).toEqual([4, 3, 2, 1]);
    const proposed = wireInstructionPage.parse(
      (await send(f, USERS.ops.externalId, 'GET', `${LIST}&state=Proposed`)).json,
    );
    expect(proposed.items.map((r) => r.id)).toEqual([IDS.wire.Proposed]);
    // Two per page reproduce the single page.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const part = wireInstructionPage.parse(
        (
          await send(
            f,
            USERS.ops.externalId,
            'GET',
            `/api/v1/wire-instructions?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`,
          )
        ).json,
      );
      seen.push(...part.items.map((r) => r.id));
      cursor = part.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(page.items.map((r) => r.id));
    expect(
      (await send(f, USERS.ops.externalId, 'GET', '/api/v1/wire-instructions?cursor=garbage'))
        .status,
    ).toBe(400);
  });

  it('answers the masked form only for a recorded version, to operations and approvers too: the preview holds no clear details (WEB-1)', async () => {
    const { f } = setup();
    for (const who of [USERS.ops, USERS.ops2, USERS.head, USERS.admin, USERS.all]) {
      for (const [name, id] of Object.entries(IDS.wire)) {
        const answer = await send(f, who.externalId, 'GET', path(id));
        const detail = wireInstructionDetail.parse(answer.json);
        expect(detail.bankDetails, `${who.externalId} ${name}`).toBeNull();
        expect(detail.bankDetailsMasked).toMatch(/^.+ \*{4}\d{4}$/);
        // No full account number or routing code of any recorded version, under any key.
        for (const clear of Object.values(BANK_DETAILS)) {
          expect(answer.text).not.toContain(clear.accountNumber);
          expect(answer.text).not.toContain(clear.routingCode);
        }
      }
    }
    const ops = wireInstructionDetail.parse(
      (await send(f, USERS.ops.externalId, 'GET', path(IDS.wire.Verified))).json,
    );
    expect(ops.bankDetailsMasked).toBe('Harbor Street Bank ****5566');
    expect((await send(f, USERS.ops.externalId, 'GET', path(NO_SUCH_ID))).status).toBe(404);
    const { f: withoutBook } = setup(null);
    expect(
      wireInstructionDetail.parse(
        (await send(withoutBook, USERS.ops.externalId, 'GET', path(IDS.wire.Verified))).json,
      ).bankDetails,
    ).toBeNull();
  });

  it('shows what a person typed this session back to the clear readers of that session, and to nobody else', async () => {
    const { f } = setup();
    const typed = { ...freshDetails(), accountNumber: '5550001234', routingCode: '071000013' };
    const created = wireInstructionDetail.parse(
      (
        await send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', {
          sponsorFundId: IDS.fund,
          counterpartyName: FUND_NAME,
          bankDetails: typed,
        })
      ).json,
    );
    expect(created.bankDetails).toEqual(typed);
    for (const who of [USERS.ops, USERS.ops2, USERS.head])
      expect(
        wireInstructionDetail.parse((await send(f, who.externalId, 'GET', path(created.id))).json)
          .bankDetails,
      ).toEqual(typed);
    const admin = await send(f, USERS.admin.externalId, 'GET', path(created.id));
    expect(wireInstructionDetail.parse(admin.json).bankDetails).toBeNull();
    expect(admin.text).not.toContain(typed.accountNumber);
    // The register itself stays masked for every reader.
    const list = await send(f, USERS.ops.externalId, 'GET', LIST);
    expect(list.text).not.toContain(typed.accountNumber);
    expect(list.text).not.toContain(typed.routingCode);
  });

  it('proposes a new version typed by hand: max plus one, Proposed, masked for every reader but the clear ones', async () => {
    const { f, state } = setup();
    const body = {
      sponsorFundId: IDS.fund,
      counterpartyName: FUND_NAME,
      bankDetails: freshDetails(),
      sourceNote: 'Letter received by post and typed in',
    };
    const created = await send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', body);
    expect(created.status).toBe(201);
    expect(created.headers.get('etag')).toBe('"1"');
    const row = wireInstructionDetail.parse(created.json);
    expect(row).toMatchObject({
      version: 5,
      state: 'Proposed',
      active: false,
      proposedBy: { id: USERS.ops.userId },
      proposedAt: env.now(),
      sourceNote: body.sourceNote,
      bankDetailsMasked: 'Meridian Clearing ****7890',
      bankDetails: body.bankDetails,
      callback: null,
      counterparty: { kind: 'sponsor_fund', id: IDS.fund, name: FUND_NAME },
    });
    const masked = wireInstructionDetail.parse(
      (await send(f, USERS.admin.externalId, 'GET', path(row.id))).json,
    );
    expect(masked.bankDetails).toBeNull();
    expect(state.audit.map((e) => e.action)).toContain('wire_instruction.propose');
    // The active version is untouched by a proposal.
    const active = wireInstructionPage
      .parse((await send(f, USERS.ops.externalId, 'GET', `${LIST}&sponsorFundId=${IDS.fund}`)).json)
      .items.filter((r) => r.active);
    expect(active.map((r) => r.version)).toEqual([2]);
    // The body is the only way in, and it is typed (SEC-12.1).
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', {
          ...body,
          investmentId: IDS.open,
        })
      ).status,
    ).toBe(400);
    const digits = await send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', {
      ...body,
      bankDetails: { ...body.bankDetails, accountNumber: 'AB12' },
    });
    expect(digits.status).toBe(400);
    expect(problemDetails.parse(digits.json).errors?.[0]?.path).toBe('bankDetails.accountNumber');
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', {
          ...body,
          sponsorFundId: NO_SUCH_ID,
        })
      ).status,
    ).toBe(404);
    // An investment-level version for a position the proposer can open; a walled one is not found.
    const walled = await send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', {
      investmentId: IDS.walled,
      counterpartyName: 'Walled Holdings Co',
      bankDetails: freshDetails(),
    });
    expect(walled.status).toBe(404);
    const forPosition = wireInstructionDetail.parse(
      (
        await send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', {
          investmentId: IDS.open,
          counterpartyName: 'Company 0001',
          bankDetails: freshDetails(),
        })
      ).json,
    );
    expect(forPosition).toMatchObject({
      version: 1,
      counterparty: { kind: 'investment', id: IDS.open },
    });
  });

  it("verify: the proposer is refused (SEC-12.2); a second person's confirmed callback verifies and supersedes the previous active version", async () => {
    const { f, state } = setup();
    const own = await send(f, USERS.ops.externalId, 'POST', commands(IDS.wire.Proposed), verify);
    expect(own.status).toBe(422);
    expect(problemOf(own).detail).toContain('other than the proposer');
    expect(
      (
        await send(f, USERS.ops2.externalId, 'POST', commands(IDS.wire.Proposed), {
          ...verify,
          callbackResult: 'not_confirmed',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(f, USERS.ops2.externalId, 'POST', commands(IDS.wire.Proposed), {
          command: 'supersede',
        })
      ).status,
    ).toBe(400);
    const after = wireInstructionDetail.parse(
      (await send(f, USERS.ops2.externalId, 'POST', commands(IDS.wire.Proposed), verify)).json,
    );
    expect(after).toMatchObject({
      state: 'Verified',
      active: true,
      verifiedAt: env.now(),
      rowVersion: 2,
      callback: {
        by: { id: USERS.ops2.userId, name: USERS.ops2.displayName },
        at: env.now(),
        numberSource: 'sponsor_website',
        result: 'confirmed',
      },
      // A recorded version: the preview holds its masked form only.
      bankDetails: null,
      bankDetailsMasked: 'Meridian Clearing ****7890',
    });
    const old = wireInstructionDetail.parse(
      (await send(f, USERS.ops.externalId, 'GET', path(IDS.wire.Verified))).json,
    );
    expect(old).toMatchObject({ state: 'Superseded', active: false, rowVersion: 2 });
    const active = wireInstructionPage
      .parse((await send(f, USERS.ops.externalId, 'GET', `${LIST}&sponsorFundId=${IDS.fund}`)).json)
      .items.filter((r) => r.active);
    expect(active.map((r) => r.id)).toEqual([IDS.wire.Proposed]);
    expect(state.audit.map((e) => e.action)).toEqual([
      'wire_instruction.supersede',
      'wire_instruction.verify',
    ]);
    // Verified is not re-verified; Superseded takes no command.
    expect(
      (await send(f, USERS.ops2.externalId, 'POST', commands(IDS.wire.Proposed), verify)).status,
    ).toBe(409);
    expect(
      (
        await send(f, USERS.ops2.externalId, 'POST', commands(IDS.wire.Verified), {
          command: 'reject',
          reason: 'too late',
        })
      ).status,
    ).toBe(409);
  });

  it('reject: the proposer may withdraw with a reason and no callback; a logged callback needs a second person', async () => {
    const { f } = setup();
    const propose = async (): Promise<string> =>
      wireInstructionDetail.parse(
        (
          await send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', {
            sponsorFundId: IDS.fund,
            counterpartyName: FUND_NAME,
            bankDetails: freshDetails(),
          })
        ).json,
      ).id;
    const v5 = await propose();
    const own = await send(f, USERS.ops.externalId, 'POST', commands(v5), {
      command: 'reject',
      callbackNumberSource: 'known_contact',
      callbackResult: 'not_confirmed',
      reason: 'the number did not answer',
    });
    expect(own.status).toBe(422);
    expect(problemOf(own).detail).toContain('SEC-12.2');
    expect(
      (await send(f, USERS.ops.externalId, 'POST', commands(v5), { command: 'reject' })).status,
    ).toBe(400);
    const withdrawn = wireInstructionDetail.parse(
      (
        await send(f, USERS.ops.externalId, 'POST', commands(v5), {
          command: 'reject',
          reason: 'Typed in error; superseded by the letter',
        })
      ).json,
    );
    expect(withdrawn).toMatchObject({
      state: 'Rejected',
      rejectionReason: 'Typed in error; superseded by the letter',
      callback: null,
    });
    const v6 = await propose();
    const notConfirmed = wireInstructionDetail.parse(
      (
        await send(f, USERS.ops2.externalId, 'POST', commands(v6), {
          command: 'reject',
          callbackNumberSource: 'known_contact',
          callbackResult: 'not_confirmed',
          reason: 'the contact did not recognise the account',
        })
      ).json,
    );
    expect(notConfirmed.callback).toEqual({
      by: { id: USERS.ops2.userId, name: USERS.ops2.displayName },
      at: env.now(),
      numberSource: 'known_contact',
      result: 'not_confirmed',
    });
  });

  it('never verifies an older Proposed version over a newer Verified one: 422, reject it instead (W2-4)', async () => {
    const { f } = setup();
    const propose = async (body: object): Promise<string> =>
      wireInstructionDetail.parse(
        (await send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', body)).json,
      ).id;
    const ofFund = async (): Promise<WireInstructionRow[]> =>
      wireInstructionPage.parse(
        (await send(f, USERS.ops.externalId, 'GET', `${LIST}&sponsorFundId=${IDS.fund}`)).json,
      ).items;
    // Version 5 is proposed and verified while version 4 still waits for its callback.
    const v5 = await propose({
      sponsorFundId: IDS.fund,
      counterpartyName: FUND_NAME,
      bankDetails: freshDetails(),
    });
    expect((await send(f, USERS.ops2.externalId, 'POST', commands(v5), verify)).status).toBe(200);
    const older = await send(f, USERS.ops2.externalId, 'POST', commands(IDS.wire.Proposed), verify);
    expect(older.status).toBe(422);
    expect(problemOf(older)).toEqual({
      code: 'workflow-precondition',
      detail:
        'wire_instruction: a newer version of this counterparty is already Verified; reject this older version instead (SEC-12.2)',
    });
    // Nothing moved: version 5 is still the one active version and version 4 still waits.
    expect((await ofFund()).filter((r) => r.active).map((r) => r.version)).toEqual([5]);
    expect((await ofFund()).find((r) => r.id === IDS.wire.Proposed)).toMatchObject({
      state: 'Proposed',
      rowVersion: 1,
    });
    // The key is exact: a first version for a position of the same fund is not older than the
    // fund-level version 5.
    const forPosition = await propose({
      investmentId: IDS.open,
      counterpartyName: 'Company 0001',
      bankDetails: freshDetails(),
    });
    expect(
      (await send(f, USERS.ops2.externalId, 'POST', commands(forPosition), verify)).status,
    ).toBe(200);
    expect((await ofFund()).filter((r) => r.active).map((r) => r.version)).toEqual([5]);
    // The older version is rejected instead.
    const rejected = await send(f, USERS.ops2.externalId, 'POST', commands(IDS.wire.Proposed), {
      command: 'reject',
      reason: 'Superseded by version 5 before its callback',
    });
    expect(rejected.status).toBe(200);
    expect(wireInstructionDetail.parse(rejected.json).state).toBe('Rejected');
  });

  it('logs a failed callback with its number source or not at all: either alone is 400 with the field (W2-5)', async () => {
    const { f } = setup();
    const reject = (body: object) =>
      send(f, USERS.ops2.externalId, 'POST', commands(IDS.wire.Proposed), {
        command: 'reject',
        reason: 'the number did not answer',
        ...body,
      });
    const resultOnly = await reject({ callbackResult: 'not_confirmed' });
    expect(resultOnly.status).toBe(400);
    expect(problemDetails.parse(resultOnly.json).errors).toEqual([
      {
        path: 'callbackNumberSource',
        message: 'The number source is required with a callback result',
      },
    ]);
    const sourceOnly = await reject({ callbackNumberSource: 'known_contact' });
    expect(sourceOnly.status).toBe(400);
    expect(problemDetails.parse(sourceOnly.json).errors).toEqual([
      { path: 'callbackResult', message: 'The callback result is required with a number source' },
    ]);
    // Nothing was written by either; the pair together is logged, and the register row shows it.
    const both = await reject({
      callbackNumberSource: 'known_contact',
      callbackResult: 'not_confirmed',
    });
    expect(both.status).toBe(200);
    const row = wireInstructionPage
      .parse((await send(f, USERS.head.externalId, 'GET', `${LIST}&state=Rejected`)).json)
      .items.find((r) => r.id === IDS.wire.Proposed);
    expect(row).toMatchObject({
      state: 'Rejected',
      rowVersion: 2,
      rejectionReason: 'the number did not answer',
      callback: {
        by: { id: USERS.ops2.userId, name: USERS.ops2.displayName },
        at: env.now(),
        numberSource: 'known_contact',
        result: 'not_confirmed',
      },
    });
  });

  it('rejects every forbidden state and command pair with 409 and honours If-Match', async () => {
    const { f } = setup();
    const byState: Record<WireInstructionRow['state'], string> = {
      Proposed: IDS.wire.Proposed,
      Verified: IDS.wire.Verified,
      Rejected: IDS.wire.Rejected,
      Superseded: IDS.wire.Superseded,
    };
    const bodies: Record<string, object> = {
      verify,
      reject: { command: 'reject', reason: 'a reason for the test' },
    };
    const pairs = forbiddenPairs(wireInstructionMachine).filter((p) => p.command !== 'supersede');
    expect(pairs.length).toBeGreaterThan(0);
    for (const { from, command } of pairs) {
      const answer = await send(
        f,
        USERS.ops2.externalId,
        'POST',
        commands(byState[from]),
        bodies[command],
      );
      expect(answer.status, `${from} ${command}`).toBe(409);
      expect(problemOf(answer).code).toBe('workflow-transition');
    }
    const stale = await send(
      f,
      USERS.ops2.externalId,
      'POST',
      commands(IDS.wire.Proposed),
      verify,
      {
        'if-match': '"7"',
      },
    );
    expect(stale.status).toBe(412);
    const fresh = await send(
      f,
      USERS.ops2.externalId,
      'POST',
      commands(IDS.wire.Proposed),
      verify,
      {
        'if-match': 'W/"1"',
      },
    );
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('etag')).toBe('"2"');
  });
});
