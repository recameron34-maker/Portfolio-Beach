import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { problemDetails, wireInstructionDetail, wireInstructionPage } from '@pb/contracts';
import type { WireInstructionDetail, WireInstructionRow } from '@pb/contracts';
import { DEV_FIELD_KEY, FieldCipher, encryptBankDetails, maskBankDetails } from '@pb/db';
import { forbiddenPairs, wireInstructionMachine } from '@pb/workflows';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';

describe('wire instruction register (M16, docs/18 section 11, SEC-12.1 to SEC-12.3)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const seeded = () => h.dataset.wireInstructions!;
  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const wireChangeFund = (): string => {
    const notice = h.dataset.capitalNotices.find((n) => n.scenarioTag === 'wire_change')!;
    return h.dataset.investments.find((i) => i.id === notice.investmentId)!.sponsorFundId!;
  };
  const get = (who: string, path: string, requestId = 'req-wire-get') =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
  const list = async (who: string, query = '') =>
    wireInstructionPage.parse(
      (await get(who, `/api/v1/wire-instructions${query}`).expect(200)).body,
    );
  const detail = async (
    who: string,
    id: string,
    requestId = 'req-wire-detail',
  ): Promise<WireInstructionDetail> =>
    wireInstructionDetail.parse(
      (await get(who, `/api/v1/wire-instructions/${id}`, requestId).expect(200)).body,
    );
  const propose = (who: string, body: object, requestId = 'req-wire-propose') =>
    h
      .http()
      .post('/api/v1/wire-instructions')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const command = (
    who: string,
    id: string,
    body: object,
    requestId = 'req-wire-command',
    ifMatch?: string,
  ) => {
    let req = h
      .http()
      .post(`/api/v1/wire-instructions/${id}/commands`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId);
    if (ifMatch !== undefined) req = req.set('if-match', ifMatch);
    return req.send(body);
  };
  const problemOf = async (
    res: Promise<{ body: unknown }>,
    code: string,
  ): Promise<ReturnType<typeof problemDetails.parse>> => {
    const problem = problemDetails.parse((await res).body);
    expect(problem.type).toBe(`${PROBLEM}${code}`);
    return problem;
  };
  const auditRows = async (
    action: string,
    requestId: string,
  ): Promise<{ entity_id: string; reason: string | null; details: Record<string, unknown> }[]> =>
    h.runtime.db.query(
      'select entity_id, reason, details from audit.event where action = $1 and request_id = $2 order by id',
      [action, requestId],
    );
  const walk = async (who: string, limit: number, query = ''): Promise<WireInstructionRow[]> => {
    const rows: WireInstructionRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const after: string = cursor === null ? '' : `&cursor=${cursor}`;
      const page = await list(who, `?limit=${limit}${query}${after}`);
      rows.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 100);
    return rows;
  };
  const freshDetails = () => ({
    bankName: 'Meridian Clearing',
    accountName: 'Synthetic Fund IV LP',
    accountNumber: '1234567890',
    routingCode: '021000021',
    reference: 'LP capital account',
  });
  /** Every account and routing number the seed holds in clear: none may appear in any response. */
  const seededSecrets = (): string[] =>
    seeded().flatMap((w) => [w.bankDetails.accountNumber, w.bankDetails.routingCode]);
  const expectNoSecret = (payload: unknown): void => {
    const text = JSON.stringify(payload);
    for (const secret of seededSecrets()) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/accountNumber|routingCode/);
  };

  it('answers 403 to roles outside the register on every route (viewer, deal team, investor relations)', async () => {
    const id = seeded()[0]!.id;
    for (const who of ['viewer.one', 'deal.one', 'ir.one']) {
      await get(who, '/api/v1/wire-instructions').expect(403);
      await get(who, `/api/v1/wire-instructions/${id}`).expect(403);
      await propose(who, {
        sponsorFundId: wireChangeFund(),
        counterpartyName: 'x',
        bankDetails: freshDetails(),
      }).expect(403);
      await command(who, id, {
        command: 'verify',
        callbackNumberSource: 'prior_instruction',
        callbackResult: 'confirmed',
      }).expect(403);
    }
    // Auditors and platform admins read; only operations propose; operations and approvers verify.
    await propose('audit.one', {
      sponsorFundId: wireChangeFund(),
      counterpartyName: 'x',
      bankDetails: freshDetails(),
    }).expect(403);
    await command('audit.one', id, { command: 'reject', reason: 'not for auditors' }).expect(403);
    await h.http().get('/api/v1/wire-instructions').expect(401);
  });

  it('lists every seeded version newest first, masked, filtered by counterparty and state, paged without gaps', async () => {
    const rows = await walk('audit.one', 200);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(seeded().map((w) => w.id)));
    expect(seeded().length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      expect(a.proposedAt > b.proposedAt || (a.proposedAt === b.proposedAt && a.id > b.id)).toBe(
        true,
      );
    }
    const byId = new Map(seeded().map((w) => [w.id, w]));
    for (const r of rows) {
      const seed = byId.get(r.id)!;
      expect(r.bankDetailsMasked).toBe(maskBankDetails(seed.bankDetails));
      expect(r.bankDetailsMasked).toMatch(/^.+ \*{4}\d{4}$/);
      expect(r.version).toBe(seed.version);
      expect(r.state).toBe(seed.state);
      expect(r.active).toBe(seed.active);
      expect(r.counterparty).toEqual({
        kind: seed.investmentId === null ? 'sponsor_fund' : 'investment',
        id: seed.investmentId ?? seed.sponsorFundId,
        name: seed.counterpartyName,
      });
      expect(r.proposedBy.id).toBe(seed.proposedBy);
      if (seed.state === 'Verified') {
        expect(r.callback).not.toBeNull();
        expect(r.callback!.by.id).toBe(seed.callbackBy);
        expect(r.callback!.by.id).not.toBe(r.proposedBy.id);
        expect(r.callback!.result).toBe('confirmed');
      } else expect(r.callback).toBeNull();
      expect('bankDetails' in r).toBe(false);
    }
    expectNoSecret(rows);
    expect(JSON.stringify(rows)).not.toContain(String.fromCharCode(0x2014));

    const fund = wireChangeFund();
    const ofFund = await list('operations', `?sponsorFundId=${fund}`);
    expect(ofFund.items.map((r) => r.version).sort()).toEqual([1, 2]);
    const proposed = await list('operations', '?state=Proposed');
    expect(proposed.items.length).toBe(1);
    expect(proposed.items[0]!.counterparty.id).toBe(fund);
    expect(proposed.items[0]!.version).toBe(2);

    const single = (await list('audit.one', '?limit=200')).items.map((r) => r.id);
    expect((await walk('audit.one', 3)).map((r) => r.id)).toEqual(single);
    await problemOf(
      get('audit.one', '/api/v1/wire-instructions?cursor=garbage').expect(400),
      'validation',
    );
    await problemOf(get('audit.one', '/api/v1/wire-instructions?bank=1').expect(400), 'validation');
  });

  it('decrypts the bank details for operations and approvers only, audits each clear read, masks for everyone else', async () => {
    const seed = seeded().find((w) => w.state === 'Verified' && w.active)!;
    const ops = await detail('ops.one', seed.id, 'req-wire-clear-ops');
    expect(ops.bankDetails).toEqual(seed.bankDetails);
    expect(ops.bankDetailsMasked).toBe(maskBankDetails(seed.bankDetails));
    const head = await detail('head.one', seed.id, 'req-wire-clear-head');
    expect(head.bankDetails).toEqual(seed.bankDetails);
    const auditor = await detail('audit.one', seed.id, 'req-wire-masked-auditor');
    expect(auditor.bankDetails).toBeNull();
    const admin = await detail('admin.one', seed.id, 'req-wire-masked-admin');
    expect(admin.bankDetails).toBeNull();
    expectNoSecret(auditor);
    expectNoSecret(admin);

    // Every decrypted read is on the audit trail, with no content in the event (SEC-11.1).
    for (const requestId of ['req-wire-clear-ops', 'req-wire-clear-head']) {
      const rows = await auditRows('wire_instruction.read', requestId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.entity_id).toBe(seed.id);
      expect(rows[0]!.details).toEqual({});
    }
    for (const requestId of ['req-wire-masked-auditor', 'req-wire-masked-admin'])
      expect((await auditRows('wire_instruction.read', requestId)).length).toBe(0);

    await get('ops.one', `/api/v1/wire-instructions/${NO_SUCH_ID}`).expect(404);
    await get('ops.one', '/api/v1/wire-instructions/not-a-uuid').expect(404);
  });

  it("keeps a walled position's instruction visible to operations: the register is a control, not a deal record", async () => {
    const details = {
      bankName: 'Northline Trust',
      accountName: 'Walled Holdings Co',
      accountNumber: '9988776655',
      routingCode: '111000025',
    };
    const [inserted] = await h.runtime.db.query<{ id: string }>(
      `insert into mon.wire_instruction
         (investment_id, counterparty_name, version, bank_details_enc, bank_details_masked, state, proposed_by, source_note)
       values ($1, $2, 1, $3, $4, 'Proposed', $5, 'Typed from the closing set')
       returning id`,
      [
        walledId(),
        'Walled Holdings Co',
        encryptBankDetails(new FieldCipher(DEV_FIELD_KEY), details),
        maskBankDetails(details),
        user('ops.one').id,
      ],
    );
    const id = inserted!.id;
    // ops.one is not on the wall: the position itself is not found, the instruction is.
    await get('ops.one', `/api/v1/investments/${walledId()}`).expect(404);
    const clear = await detail('ops.one', id);
    expect(clear.counterparty).toEqual({
      kind: 'investment',
      id: walledId(),
      name: 'Walled Holdings Co',
    });
    expect(clear.bankDetails).toEqual(details);
    const masked = await detail('audit.one', id);
    expect(masked.bankDetails).toBeNull();
    expect(masked.bankDetailsMasked).toBe('Northline Trust ****6655');
    await get('viewer.one', `/api/v1/wire-instructions/${id}`).expect(403);
    // The wall member is deal team: no register access either.
    await get('deal.three', `/api/v1/wire-instructions/${id}`).expect(403);
    expect((await list('ops.one', `?investmentId=${walledId()}`)).items.map((r) => r.id)).toEqual([
      id,
    ]);

    // An investment-level version verifies like any other, by a second person.
    const verified = wireInstructionDetail.parse(
      (
        await command('ops.two', id, {
          command: 'verify',
          callbackNumberSource: 'known_contact',
          callbackResult: 'confirmed',
        }).expect(200)
      ).body,
    );
    expect(verified.state).toBe('Verified');
    expect(verified.active).toBe(true);
    expect(verified.callback!.by.id).toBe(user('ops.two').id);
  });

  it("journey: the proposer cannot verify; a second person's confirmed callback verifies and supersedes the previous active version", async () => {
    const fund = wireChangeFund();
    const v1 = seeded().find((w) => w.sponsorFundId === fund && w.version === 1)!;
    const v2 = seeded().find((w) => w.sponsorFundId === fund && w.version === 2)!;
    expect(v1.state).toBe('Verified');
    expect(v1.active).toBe(true);
    expect(v2.state).toBe('Proposed');
    expect(v2.proposedBy).toBe(user('ops.one').id);
    const verify = {
      command: 'verify',
      callbackNumberSource: 'sponsor_website',
      callbackResult: 'confirmed',
    };

    const own = await problemOf(
      command('ops.one', v2.id, verify).expect(422),
      'workflow-precondition',
    );
    expect(own.detail).toContain('SEC-12.2');
    expect(own.detail).toContain('other than the proposer');
    await problemOf(
      command('ops.two', v2.id, { ...verify, callbackResult: 'not_confirmed' }).expect(400),
      'validation',
    );
    await problemOf(command('ops.two', v2.id, { command: 'supersede' }).expect(400), 'validation');
    // Nothing moved.
    expect((await detail('ops.one', v2.id)).state).toBe('Proposed');

    const after = wireInstructionDetail.parse(
      (await command('ops.two', v2.id, verify, 'req-wire-verify').expect(200)).body,
    );
    expect(after.state).toBe('Verified');
    expect(after.active).toBe(true);
    expect(after.callback).toEqual({
      by: { id: user('ops.two').id, name: user('ops.two').displayName },
      at: h.runtime.adapters.clock.now(),
      numberSource: 'sponsor_website',
      result: 'confirmed',
    });
    expect(after.verifiedAt).toBe(h.runtime.adapters.clock.now());
    expect(after.bankDetails).toEqual(v2.bankDetails);
    expect(after.rowVersion).toBe(2);

    const old = await detail('ops.one', v1.id);
    expect(old.state).toBe('Superseded');
    expect(old.active).toBe(false);
    const active = (await list('ops.one', `?sponsorFundId=${fund}`)).items.filter((r) => r.active);
    expect(active.map((r) => r.id)).toEqual([v2.id]);

    const verifyEvents = await auditRows('wire_instruction.verify', 'req-wire-verify');
    expect(verifyEvents.length).toBe(1);
    expect(verifyEvents[0]!.entity_id).toBe(v2.id);
    expect(verifyEvents[0]!.details).toMatchObject({
      version: 2,
      state: { before: 'Proposed', after: 'Verified' },
      active: { before: false, after: true },
      callback: { numberSource: 'sponsor_website', result: 'confirmed' },
      superseded: [v1.id],
    });
    const supersedeEvents = await auditRows('wire_instruction.supersede', 'req-wire-verify');
    expect(supersedeEvents.length).toBe(1);
    expect(supersedeEvents[0]!.entity_id).toBe(v1.id);
    expect(supersedeEvents[0]!.details).toMatchObject({
      state: { before: 'Verified', after: 'Superseded' },
      supersededBy: v2.id,
    });
    expectNoSecret(verifyEvents);

    // Verified is not re-verified; Superseded takes no command (409, docs/18 section 11).
    await problemOf(command('ops.two', v2.id, verify).expect(409), 'workflow-transition');
    await problemOf(
      command('ops.two', v1.id, { command: 'reject', reason: 'too late' }).expect(409),
      'workflow-transition',
    );

    // Ciphertext at rest: the account number is nowhere in the row.
    const [row] = await h.runtime.db.query<{ enc: string; masked: string }>(
      'select bank_details_enc as enc, bank_details_masked as masked from mon.wire_instruction where id = $1',
      [v2.id],
    );
    expect(row!.enc).not.toContain(v2.bankDetails.accountNumber);
    expect(row!.enc).not.toContain(v2.bankDetails.routingCode);
    expect(row!.masked).toBe(maskBankDetails(v2.bankDetails));
  });

  it('proposes a new version typed by hand: version max + 1, encrypted at rest, audited masked; the proposer may reject it without a callback, a logged callback needs a second person', async () => {
    const fund = wireChangeFund();
    const fundName = h.dataset.sponsorFunds.find((f) => f.id === fund)!.name;
    const body = {
      sponsorFundId: fund,
      counterpartyName: fundName,
      bankDetails: freshDetails(),
      sourceNote: 'Letter received by post and typed in',
    };
    const created = wireInstructionDetail.parse(
      (await propose('ops.one', body, 'req-wire-propose-3').expect(201)).body,
    );
    expect(created.version).toBe(3);
    expect(created.state).toBe('Proposed');
    expect(created.active).toBe(false);
    expect(created.proposedBy.id).toBe(user('ops.one').id);
    expect(created.proposedAt).toBe(h.runtime.adapters.clock.now());
    expect(created.sourceNote).toBe(body.sourceNote);
    expect(created.bankDetailsMasked).toBe('Meridian Clearing ****7890');
    expect(created.bankDetails).toEqual(body.bankDetails);
    expect(created.callback).toBeNull();
    expect(created.counterparty).toEqual({ kind: 'sponsor_fund', id: fund, name: fundName });

    const events = await auditRows('wire_instruction.propose', 'req-wire-propose-3');
    expect(events.length).toBe(1);
    expect(events[0]!.details).toMatchObject({
      counterparty: { kind: 'sponsor_fund', id: fund, name: fundName },
      version: 3,
      state: { before: null, after: 'Proposed' },
      bankDetailsMasked: 'Meridian Clearing ****7890',
    });
    expect(JSON.stringify(events)).not.toContain('1234567890');
    expect(JSON.stringify(events)).not.toContain('021000021');
    const [row] = await h.runtime.db.query<{ enc: string }>(
      'select bank_details_enc as enc from mon.wire_instruction where id = $1',
      [created.id],
    );
    expect(row!.enc).not.toContain('1234567890');
    expect(JSON.parse(new FieldCipher(DEV_FIELD_KEY).decrypt(row!.enc))).toEqual(body.bankDetails);
    // The active version is untouched by a proposal.
    const active = (await list('ops.one', `?sponsorFundId=${fund}`)).items.filter((r) => r.active);
    expect(active.map((r) => r.version)).toEqual([2]);

    // The body is the only way in, and it is typed: shape and digits are checked (SEC-12.1).
    await problemOf(
      propose('ops.one', { ...body, investmentId: walledId() }).expect(400),
      'validation',
    );
    const { sponsorFundId: _noKey, ...withoutKey } = body;
    await problemOf(propose('ops.one', withoutKey).expect(400), 'validation');
    await problemOf(
      propose('ops.one', {
        ...body,
        bankDetails: { ...body.bankDetails, accountNumber: 'AB12' },
      }).expect(400),
      'validation',
    );
    await problemOf(propose('ops.one', { ...body, bankText: 'pasted' }).expect(400), 'validation');
    await problemOf(
      propose('ops.one', { ...body, sponsorFundId: NO_SUCH_ID }).expect(404),
      'not-found',
    );

    // A failed callback is logged by a second person; the proposer may only withdraw with a reason.
    const own = await problemOf(
      command('ops.one', created.id, {
        command: 'reject',
        callbackNumberSource: 'known_contact',
        callbackResult: 'not_confirmed',
        reason: 'the number did not answer',
      }).expect(422),
      'workflow-precondition',
    );
    expect(own.detail).toContain('SEC-12.2');
    await problemOf(
      command('ops.one', created.id, { command: 'reject' }).expect(400),
      'validation',
    );
    const rejected = wireInstructionDetail.parse(
      (
        await command(
          'ops.one',
          created.id,
          { command: 'reject', reason: 'Typed in error; superseded by the letter' },
          'req-wire-reject-3',
        ).expect(200)
      ).body,
    );
    expect(rejected.state).toBe('Rejected');
    expect(rejected.rejectionReason).toBe('Typed in error; superseded by the letter');
    expect(rejected.callback).toBeNull();
    const rejectEvents = await auditRows('wire_instruction.reject', 'req-wire-reject-3');
    expect(rejectEvents.length).toBe(1);
    expect(rejectEvents[0]!.reason).toBe('Typed in error; superseded by the letter');
    expect(rejectEvents[0]!.details).toMatchObject({
      version: 3,
      state: { before: 'Proposed', after: 'Rejected' },
      callback: null,
    });

    const v4 = wireInstructionDetail.parse((await propose('ops.one', body).expect(201)).body);
    expect(v4.version).toBe(4);
    const notConfirmed = wireInstructionDetail.parse(
      (
        await command('ops.two', v4.id, {
          command: 'reject',
          callbackNumberSource: 'known_contact',
          callbackResult: 'not_confirmed',
          reason: 'the contact did not recognise the account',
        }).expect(200)
      ).body,
    );
    expect(notConfirmed.state).toBe('Rejected');
    expect(notConfirmed.callback).toEqual({
      by: { id: user('ops.two').id, name: user('ops.two').displayName },
      at: h.runtime.adapters.clock.now(),
      numberSource: 'known_contact',
      result: 'not_confirmed',
    });
    expect(notConfirmed.active).toBe(false);
  });

  it('rejects every forbidden state and command pair with 409', async () => {
    const fund = wireChangeFund();
    const rows = (await list('ops.one', `?sponsorFundId=${fund}&limit=200`)).items;
    const byState = (state: string): WireInstructionRow =>
      rows.find((r) => r.state === state) ??
      (() => {
        throw new Error(`no ${state} version to test`);
      })();
    const bodies: Record<string, object> = {
      verify: {
        command: 'verify',
        callbackNumberSource: 'prior_instruction',
        callbackResult: 'confirmed',
      },
      reject: { command: 'reject', reason: 'a reason for the test' },
    };
    const pairs = forbiddenPairs(wireInstructionMachine).filter((p) => p.command !== 'supersede');
    expect(pairs.length).toBeGreaterThan(0);
    for (const { from, command: cmd } of pairs) {
      const row = byState(from);
      const res = await command('ops.two', row.id, bodies[cmd]!).expect(409);
      expect(problemDetails.parse(res.body).type, `${from} ${cmd}`).toBe(
        `${PROBLEM}workflow-transition`,
      );
    }
    // supersede is the system's step inside verify, never a route command.
    expect(wireInstructionMachine.commands).toContain('supersede');
  });

  it('honours If-Match: 412 when stale, 400 when malformed, the write when current', async () => {
    const fund = wireChangeFund();
    const fundName = h.dataset.sponsorFunds.find((f) => f.id === fund)!.name;
    const v5 = wireInstructionDetail.parse(
      (
        await propose('ops.one', {
          sponsorFundId: fund,
          counterpartyName: fundName,
          bankDetails: { ...freshDetails(), accountNumber: '5555666677' },
        }).expect(201)
      ).body,
    );
    expect(v5.rowVersion).toBe(1);
    const verify = {
      command: 'verify',
      callbackNumberSource: 'fund_administrator',
      callbackResult: 'confirmed',
    };
    const stale = await problemOf(
      command('ops.two', v5.id, verify, 'req-wire-stale', '"7"').expect(412),
      'stale-row-version',
    );
    expect(stale.detail).toContain('row version 1');
    await problemOf(
      command('ops.two', v5.id, verify, 'req-wire-bad-match', 'garbage').expect(400),
      'validation',
    );
    expect((await detail('ops.one', v5.id)).state).toBe('Proposed');
    const after = wireInstructionDetail.parse(
      (await command('ops.two', v5.id, verify, 'req-wire-match', 'W/"1"').expect(200)).body,
    );
    expect(after.state).toBe('Verified');
    expect(after.rowVersion).toBe(2);
    // The previous active version (v2 after the journey) is superseded; one active remains.
    const active = (await list('ops.one', `?sponsorFundId=${fund}&limit=200`)).items.filter(
      (r) => r.active,
    );
    expect(active.map((r) => r.id)).toEqual([v5.id]);
  });
});
