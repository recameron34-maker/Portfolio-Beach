import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  problemDetails,
  valuationDetail,
  valuationRow,
  valuationSuggestionRow,
} from '@pb/contracts';
import type { ExtractionRun, ValuationRow, ValuationSuggestionRow } from '@pb/contracts';
import { STATEMENT_EXAMPLES } from '@pb/synthetic';
import {
  SUGGESTIONS_OFF_REFUSAL,
  SUGGESTION_CHANGED_REFUSAL,
  SUGGESTION_KEY_PREFIX,
} from '@pb/workflows';
import { CAS, PROBLEM, QF, SUGGESTIONS, startSuggestionKit } from './suggestion-kit.js';
import type { SuggestionKit } from './suggestion-kit.js';

/*
 * The commands on a valuation suggestion (docs/04 M10, docs/18 sections 1 and 14, decision
 * 0023): operations open a draft valuation from one, put its value on the Draft already open, or
 * dismiss it; the Draft goes through the valuation workflow like any other, where the people
 * behind the suggestion's figures can take neither approval. A suggestion whose figures moved is
 * replaced or closed at accept. Derivation and reads are tested in suggestions.test.ts.
 */

const SPONSOR_MARK = 'valuation_method.sponsor_mark';
const NO_SOURCE_REVIEWER =
  'valuation: whoever approved or typed a figure behind the suggestion on this valuation cannot approve the valuation (SEC-5.6)';
const IN_PROGRESS =
  'valuation_suggestion: a version for this investment and quarter is already in progress; continue that version';
const NO_DRAFT =
  'valuation_suggestion: no Draft is open for this investment and quarter; only a Draft can take a suggested value';
const NO_VALUE =
  'valuation_suggestion: the suggestion has no value, so there is nothing to put on a valuation';

/** Only the keys a suggestion writes on a Draft. */
const suggestionKeysOf = (inputs: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(inputs).filter(([key]) => key.startsWith(SUGGESTION_KEY_PREFIX)),
  );

describe('valuation suggestions: accept, applyToDraft and dismiss (decision 0023)', () => {
  let k: SuggestionKit;
  let q2: string;
  let q3: string;
  let runs: Map<string, ExtractionRun>;

  const STALE = 'INV-0007';
  const WEEKLY = 'INV-0001';
  const SET_ASIDE = 'INV-0003';
  const NO_FIGURE = 'INV-0005';
  const WALLED = 'INV-0010';
  const runOf = (key: string): ExtractionRun => runs.get(k.written.get(key)!.fileName)!;
  const seededRun = (number: string, schemaId: string): ExtractionRun =>
    [...runs.values()].find(
      (r) => r.investmentNumber === number && r.periodEnd === q2 && r.schemaId === schemaId,
    )!;
  const command = (who: string, id: string, body: object, requestId = 'req-cmd') =>
    k.post(who, `${SUGGESTIONS}/${id}/commands`, body, requestId);
  const decided = async (who: string, id: string, body: object, requestId?: string) =>
    valuationSuggestionRow.parse((await command(who, id, body, requestId).expect(200)).body);
  const versionOf = async (id: string) =>
    valuationDetail.parse((await k.get('ops.one', `/api/v1/valuations/${id}`).expect(200)).body);
  const problemOf = (res: { body: unknown }) => problemDetails.parse(res.body);
  const outcomeOf = async (runId: string) =>
    (await k.list('ops.one', `&state=all&extractionRunId=${runId}`)).runOutcome;
  const suggestionCount = (): Promise<number> =>
    k.count('select count(*)::int as n from mon.valuation_suggestion');
  const valuationCount = (): Promise<number> =>
    k.count('select count(*)::int as n from mon.valuation');

  beforeAll(async () => {
    k = await startSuggestionKit({
      statements: ({ nextQuarter }) => ({
        weekly: { position: WEEKLY, periodEnd: nextQuarter, example: 'ties' },
        // A later statement for the same position and quarter, named by our reference alone.
        weeklyLater: {
          position: WEEKLY,
          periodEnd: nextQuarter,
          shape: {
            fileCompany: null,
            lines: {
              ...STATEMENT_EXAMPLES.ties.lines,
              netGainLoss: '1.87',
              endingBalance: '21.94',
            },
          },
        },
        setAside: { position: SET_ASIDE, periodEnd: nextQuarter, example: 'ties' },
        // The same balance in a reissued statement: another file (a line the value does not
        // rest on differs), named by our reference alone.
        setAsideCopy: {
          position: SET_ASIDE,
          periodEnd: nextQuarter,
          shape: {
            fileCompany: null,
            lines: { ...STATEMENT_EXAMPLES.ties.lines, distributionsToDate: '0.36' },
          },
        },
        noFigure: { position: NO_FIGURE, periodEnd: nextQuarter, example: 'wholeVehicleNoShare' },
        walled: { position: WALLED, periodEnd: nextQuarter },
      }),
    });
    q2 = k.quarterEnd;
    q3 = k.nextQuarter;
    await k.index();
    runs = new Map([
      ...(await k.extractQuarter(q3, CAS)),
      ...(await k.extractQuarter(q2, CAS)),
      ...(await k.extractQuarter(q2, QF)),
    ]);
  }, 120_000);
  afterAll(async () => {
    await k.close();
  });

  describe('the example sequence, through to a Locked sponsor mark', () => {
    let suggestion: ValuationSuggestionRow;
    let draft: ValuationRow;

    it('opens a draft valuation at the suggested value, with where it came from', async () => {
      const statement = seededRun(STALE, 'capital_account_statement');
      // A deal team reviewer approves the statement: they stand behind the figure.
      await k.approve('deal.two', statement.id);
      const open = (await k.open('ops.one', STALE, q2))!;
      expect(open).toMatchObject({
        suggestedValue: '38140000.00',
        inProgress: null,
        sourceReviewerIds: [k.userId('deal.two')],
      });
      const before = await valuationCount();
      const res = await command('ops.two', open.id, { command: 'accept' }, 'req-cmd-accept')
        .set('if-match', `"${open.rowVersion}"`)
        .expect(200);
      suggestion = valuationSuggestionRow.parse(res.body);
      expect(res.headers.etag).toBe(`"${suggestion.rowVersion}"`);
      expect(suggestion).toMatchObject({
        id: open.id,
        state: 'Accepted',
        decidedBy: { id: k.userId('ops.two') },
        decidedAt: k.h.runtime.adapters.clock.now(),
        decisionReason: null,
        supersededReason: null,
        rowVersion: open.rowVersion + 1,
        inProgress: {
          state: 'Draft',
          periodEnd: q2,
          fairValue: '38140000.00',
          method: SPONSOR_MARK,
        },
      });
      expect(suggestion.valuationId).toBe(suggestion.inProgress!.valuationId);
      // The figures of the suggestion are what they were.
      expect(suggestion.suggestedValue).toBe(open.suggestedValue);
      expect(suggestion.workings).toEqual(open.workings);
      expect(await valuationCount()).toBe(before + 1);

      const version = await versionOf(suggestion.valuationId!);
      draft = version;
      expect(version).toMatchObject({
        investmentNumber: STALE,
        periodEnd: q2,
        quarterEnd: q2,
        state: 'Draft',
        method: SPONSOR_MARK,
        fairValue: '38140000.00',
        preparedBy: null,
      });
      // Flat text keys, nothing for a figure that is missing: which suggestion, each input, each other source.
      expect(version.inputs).toEqual({
        'suggestion.id': open.id,
        'suggestion.basis': 'capital_account_balance',
        'suggestion.value': '38140000.00',
        'suggestion.periodEnd': q2,
        'suggestion.documentId': statement.documentId,
        'suggestion.page': '1',
        'suggestion.runId': statement.id,
        'suggestion.input.ending_capital_balance': '38140000',
        'suggestion.crossCheck.sponsor_equity_value': open.crossChecks[0]!.value,
      });

      const events = await k.rows<{
        action: string;
        actor_id: string;
        details: Record<string, unknown>;
      }>(
        "select action, actor_id, details from audit.event where request_id = 'req-cmd-accept' order by id",
      );
      expect(events.map((e) => e.action)).toEqual([
        'valuation.create',
        'valuation_suggestion.accept',
      ]);
      expect(events[0]!.details).toMatchObject({
        fairValue: '38140000.00',
        method: SPONSOR_MARK,
        state: { before: null, after: 'Draft' },
        fromSuggestion: open.id,
      });
      expect(events[1]).toMatchObject({
        actor_id: k.userId('ops.two'),
        details: {
          state: { before: 'Open', after: 'Accepted' },
          valuationId: { before: null, after: version.id },
          decidedBy: { before: null, after: k.userId('ops.two') },
          suggestedValue: '38140000.00',
          valuation: { id: version.id, periodEnd: q2, version: 1 },
        },
      });
    });

    it('refuses every command once the suggestion is decided, and changes nothing', async () => {
      const other = (await k.detail('ops.one', suggestion.id)).rowVersion;
      const first = await command('ops.one', suggestion.id, { command: 'accept' }).expect(409);
      expect(problemOf(first)).toMatchObject({
        type: `${PROBLEM}workflow-transition`,
        detail: 'valuation_suggestion: accept is not allowed from Accepted',
      });
      expect((await k.detail('ops.one', suggestion.id)).rowVersion).toBe(other);
      for (const body of [{ command: 'applyToDraft' }, { command: 'dismiss', reason: 'Too late' }])
        expect((await command('ops.one', suggestion.id, body).expect(409)).body.type).toBe(
          `${PROBLEM}workflow-transition`,
        );
    });

    it('does not raise the same value again when the report arrives', async () => {
      const report = seededRun(STALE, 'quarterly_financials');
      const before = await suggestionCount();
      await k.approve('deal.one', report.id);
      expect(await suggestionCount()).toBe(before);
      expect(await k.open('ops.one', STALE, q2)).toBeUndefined();
      expect(await outcomeOf(report.id)).toEqual({
        outcome: 'none',
        reason: 'on_valuation',
        suggestionId: null,
      });
    });

    it('refuses both approvals to whoever stood behind the figure, and locks as a sponsor mark', async () => {
      await k.valuationCommand('ops.one', draft.id, { command: 'prepare' });
      // deal.two approved the statement run the value was read from.
      const refused = await k
        .post('deal.two', `/api/v1/valuations/${draft.id}/commands`, { command: 'dealTeamApprove' })
        .expect(422);
      expect(problemOf(refused)).toMatchObject({
        type: `${PROBLEM}workflow-precondition`,
        detail: NO_SOURCE_REVIEWER,
      });
      // The batch screen refuses them too, version by version.
      const batch = await k
        .post('deal.two', '/api/v1/valuations/batch-commands', {
          command: 'dealTeamApprove',
          ids: [draft.id],
        })
        .expect(200);
      expect(
        (batch.body as { results: { ok: boolean; problem?: { detail: string } }[] }).results,
      ).toEqual([
        expect.objectContaining({
          ok: false,
          problem: expect.objectContaining({ detail: NO_SOURCE_REVIEWER }),
        }),
      ]);
      await k.valuationCommand('deal.one', draft.id, { command: 'dealTeamApprove' });
      const locked = await k.valuationCommand('head.one', draft.id, { command: 'lock' });
      expect(locked).toMatchObject({
        state: 'Locked',
        method: SPONSOR_MARK,
        fairValue: '38140000.00',
      });
      // The lock text, and so the hash, covers the suggestion's keys.
      const sealed = await versionOf(draft.id);
      expect(sealed.lockText).toContain(`"suggestion.id":"${suggestion.id}"`);
      expect(sealed.lockText).toContain('"suggestion.input.ending_capital_balance":"38140000"');
      // The accepted suggestion stays as it was decided; nothing is open for the quarter.
      expect(await k.detail('audit.one', suggestion.id)).toMatchObject({
        state: 'Accepted',
        valuationId: draft.id,
        inProgress: null,
      });
      expect(await k.open('ops.one', STALE, q2)).toBeUndefined();
    });
  });

  describe('a Draft already open for the quarter', () => {
    let draft: ValuationRow;
    let first: ValuationSuggestionRow;

    it('puts the value and the method on a weekly Draft, which keeps its date and its own inputs', async () => {
      draft = valuationRow.parse(
        (
          await k
            .post('ops.one', '/api/v1/valuations', {
              investmentId: k.investment(WEEKLY).id,
              periodEnd: '2025-09-27',
              method: 'valuation_method.market_multiple',
              fairValue: '9000000.00',
              // A key a suggestion would write is not a person's to send.
              inputs: {
                note: 'weekly mark',
                'suggestion.id': 'forged',
                'suggestion.value': '1.00',
              },
            })
            .expect(201)
        ).body,
      );
      expect((await versionOf(draft.id)).inputs).toEqual({ note: 'weekly mark' });
      await k.approve('ops.one', runOf('weekly').id);
      const open = (await k.open('ops.one', WEEKLY, q3))!;
      expect(open.inProgress).toMatchObject({
        valuationId: draft.id,
        state: 'Draft',
        periodEnd: '2025-09-27',
        fairValue: '9000000.00',
      });
      // A draft cannot be opened beside the one in progress.
      const refused = await command('ops.one', open.id, { command: 'accept' }).expect(422);
      expect(problemOf(refused)).toMatchObject({
        type: `${PROBLEM}workflow-precondition`,
        detail: IN_PROGRESS,
      });
      const before = await valuationCount();
      first = await decided('ops.two', open.id, { command: 'applyToDraft' }, 'req-cmd-apply');
      expect(first).toMatchObject({ state: 'Accepted', valuationId: draft.id });
      expect(await valuationCount()).toBe(before);
      const version = await versionOf(draft.id);
      expect(version).toMatchObject({
        state: 'Draft',
        periodEnd: '2025-09-27',
        quarterEnd: q3,
        method: SPONSOR_MARK,
        fairValue: '20940000.00',
        rowVersion: draft.rowVersion + 1,
      });
      expect(version.inputs).toMatchObject({
        note: 'weekly mark',
        'suggestion.id': open.id,
        'suggestion.value': '20940000.00',
        'suggestion.periodEnd': q3,
        'suggestion.input.ending_capital_balance': '20940000',
      });
      const events = await k.rows<{ action: string; details: Record<string, unknown> }>(
        "select action, details from audit.event where request_id = 'req-cmd-apply' order by id",
      );
      expect(events.map((e) => e.action)).toEqual([
        'valuation.edit',
        'valuation_suggestion.applyToDraft',
      ]);
      expect(events[0]!.details).toMatchObject({
        fromSuggestion: open.id,
        method: { before: 'valuation_method.market_multiple', after: SPONSOR_MARK },
        fairValue: { before: '9000000.00', after: '20940000.00' },
        periodEnd: '2025-09-27',
      });
    });

    it('keeps the suggestion keys whatever an edit of the Draft sends', async () => {
      const stored = suggestionKeysOf((await versionOf(draft.id)).inputs);
      expect(Object.keys(stored).length).toBeGreaterThanOrEqual(7);
      const patch = (inputs: Record<string, unknown>) =>
        k.h
          .http()
          .patch(`/api/v1/valuations/${draft.id}`)
          .set('authorization', k.h.as('ops.one'))
          .send({ inputs })
          .expect(200);
      await patch({ note: 'checked', 'suggestion.value': '1.00', 'suggestion.forged': 'x' });
      expect((await versionOf(draft.id)).inputs).toEqual({ note: 'checked', ...stored });
      // Clearing the inputs clears a person's own and leaves the suggestion's.
      await patch({});
      expect((await versionOf(draft.id)).inputs).toEqual(stored);
    });

    it('takes neither command while the version is being approved, and the later value once it is sent back', async () => {
      await k.valuationCommand('ops.one', draft.id, { command: 'prepare' });
      // A later statement for the quarter: a new suggestion, while the first sits on the version.
      await k.approve('deal.two', runOf('weeklyLater').id);
      const later = (await k.open('ops.one', WEEKLY, q3))!;
      expect(later).toMatchObject({
        suggestedValue: '21940000.00',
        inProgress: { valuationId: draft.id, state: 'OpsPrepared' },
      });
      expect(later.id).not.toBe(first.id);
      expect(
        problemOf(await command('ops.one', later.id, { command: 'applyToDraft' }).expect(422))
          .detail,
      ).toBe(NO_DRAFT);
      expect(
        problemOf(await command('ops.one', later.id, { command: 'accept' }).expect(422)).detail,
      ).toBe(IN_PROGRESS);
      await k.valuationCommand('deal.one', draft.id, {
        command: 'sendBack',
        reason: 'A later statement arrived',
      });
      const applied = await decided('ops.one', later.id, { command: 'applyToDraft' });
      expect(applied).toMatchObject({ state: 'Accepted', valuationId: draft.id });
      const version = await versionOf(draft.id);
      expect(version).toMatchObject({ fairValue: '21940000.00', periodEnd: '2025-09-27' });
      // The later suggestion's keys replace the earlier one's.
      expect(version.inputs).toMatchObject({
        'suggestion.id': later.id,
        'suggestion.value': '21940000.00',
        'suggestion.runId': runOf('weeklyLater').id,
      });
      // Both suggestions sit on the version: whoever stood behind either cannot approve it.
      expect((await k.detail('ops.one', first.id)).valuationId).toBe(draft.id);
      await k.valuationCommand('ops.two', draft.id, { command: 'prepare' });
      for (const who of ['deal.two']) {
        const refused = await k
          .post(who, `/api/v1/valuations/${draft.id}/commands`, { command: 'dealTeamApprove' })
          .expect(422);
        expect(problemOf(refused).detail).toBe(NO_SOURCE_REVIEWER);
      }
      await k.valuationCommand('deal.one', draft.id, { command: 'dealTeamApprove' });
    });

    it('refuses the lock to an approver who stood behind a figure', async () => {
      // No approver reviews a run in the synthetic book, so a suggestion naming one is written to
      // the record: an earlier quarter's, accepted onto the same version.
      const statement = runOf('weekly');
      const earlier = '2025-03-31';
      const [written] = await k.rows<{ id: string }>(
        `insert into mon.valuation_suggestion (investment_id, period_end, basis, method, suggested_value, workings, source_document_id, extraction_run_id, source_reviewer_ids, calc_version)
         values ($1, $2, 'capital_account_balance', 'valuation_method.sponsor_mark', 20000000, '{"inputs": []}'::jsonb, $3, $4, $5::uuid[], 'test')
         returning id`,
        [
          k.investment(WEEKLY).id,
          earlier,
          statement.documentId,
          statement.id,
          `{${k.userId('head.one')}}`,
        ],
      );
      await k.rows(
        "update mon.valuation_suggestion set state = 'Accepted', valuation_id = $2, decided_by = $3, decided_at = now() where id = $1",
        [written!.id, draft.id, k.userId('ops.one')],
      );
      const refused = await k
        .post('head.one', `/api/v1/valuations/${draft.id}/commands`, { command: 'lock' })
        .expect(422);
      expect(problemOf(refused).detail).toBe(NO_SOURCE_REVIEWER);
      expect((await versionOf(draft.id)).state).toBe('DealTeamApproved');
    });
  });

  describe('dismissing', () => {
    let dismissed: ValuationSuggestionRow;

    it('sets a suggestion aside with a reason, and only operations may', async () => {
      await k.approve('ops.one', runOf('setAside').id);
      const open = (await k.open('ops.one', SET_ASIDE, q3))!;
      for (const who of [
        'deal.one',
        'head.one',
        'audit.one',
        'viewer.one',
        'ir.one',
        'admin.one',
      ]) {
        const res = await command(who, open.id, { command: 'dismiss', reason: 'Not ours' }).expect(
          403,
        );
        expect(problemOf(res).type).toBe(`${PROBLEM}forbidden`);
      }
      for (const body of [
        { command: 'dismiss' },
        { command: 'dismiss', reason: 'no' },
        { command: 'supersede' },
        { command: 'accept', reason: 'x' },
      ])
        expect((await command('ops.one', open.id, body).expect(400)).body.type).toBe(
          `${PROBLEM}validation`,
        );
      await command('ops.one', open.id, { command: 'accept' })
        .set('if-match', 'latest')
        .expect(400);
      const stale = await command('ops.one', open.id, { command: 'accept' })
        .set('if-match', `"${open.rowVersion + 1}"`)
        .expect(412);
      expect(problemOf(stale)).toMatchObject({
        type: `${PROBLEM}stale-row-version`,
        detail: `valuation_suggestion: the record changed since it was read (it is now at row version ${open.rowVersion}); open it again`,
      });
      await command('ops.one', '90000000-0000-4000-8000-00000000dead', {
        command: 'accept',
      }).expect(404);
      await command('ops.one', 'not-a-uuid', { command: 'accept' }).expect(404);
      expect((await k.detail('ops.one', open.id)).state).toBe('Open');

      const reason = 'The statement is for the sponsor vehicle, not our account';
      const res = await command(
        'ops.two',
        open.id,
        { command: 'dismiss', reason },
        'req-cmd-dismiss',
      )
        .set('idempotency-key', 'dismiss-set-aside-1')
        .expect(200);
      dismissed = valuationSuggestionRow.parse(res.body);
      expect(dismissed).toMatchObject({
        state: 'Dismissed',
        decisionReason: reason,
        decidedBy: { id: k.userId('ops.two') },
        valuationId: null,
        supersededReason: null,
        suggestedValue: '20940000.00',
      });
      const [event] = await k.rows<{ reason: string; details: Record<string, unknown> }>(
        "select reason, details from audit.event where request_id = 'req-cmd-dismiss' and action = 'valuation_suggestion.dismiss'",
      );
      expect(event).toMatchObject({
        reason,
        details: {
          state: { before: 'Open', after: 'Dismissed' },
          valuationId: { before: null, after: null },
        },
      });
      // The same key and body again: the stored answer, and nothing run.
      const replay = await command('ops.two', open.id, { command: 'dismiss', reason })
        .set('idempotency-key', 'dismiss-set-aside-1')
        .expect(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toEqual(res.body);
      expect((await k.detail('ops.one', open.id)).rowVersion).toBe(dismissed.rowVersion);
      const again = await command('ops.two', open.id, { command: 'dismiss', reason }).expect(409);
      expect(problemOf(again).detail).toBe(
        'valuation_suggestion: dismiss is not allowed from Dismissed',
      );
      expect((await k.list('ops.one', '&state=Dismissed')).items.map((s) => s.id)).toEqual([
        dismissed.id,
      ]);
    });

    it('does not raise the same value from the same source again', async () => {
      const copy = runOf('setAsideCopy');
      const before = await suggestionCount();
      await k.approve('ops.one', copy.id);
      expect(await suggestionCount()).toBe(before);
      expect(await k.open('ops.one', SET_ASIDE, q3)).toBeUndefined();
      expect(await outcomeOf(copy.id)).toEqual({
        outcome: 'none',
        reason: 'dismissed',
        suggestionId: null,
      });
      // A draft can still be started on the board by hand.
      await k
        .post('ops.one', '/api/v1/valuations', {
          investmentId: k.investment(SET_ASIDE).id,
          periodEnd: q3,
          method: SPONSOR_MARK,
          fairValue: '20940000.00',
        })
        .expect(201);
    });

    it('dismisses a suggestion with no value, which can be neither accepted nor put on a draft', async () => {
      await k.approve('ops.one', runOf('noFigure').id);
      const open = (await k.open('ops.one', NO_FIGURE, q3))!;
      expect(open).toMatchObject({ suggestedValue: null, reasonCode: 'no_ending_balance' });
      for (const body of [{ command: 'accept' }, { command: 'applyToDraft' }]) {
        const refused = await command('ops.one', open.id, body).expect(422);
        expect(problemOf(refused)).toMatchObject({
          type: `${PROBLEM}workflow-precondition`,
          detail: NO_VALUE,
        });
      }
      const set = await decided('ops.one', open.id, {
        command: 'dismiss',
        reason: 'The sponsor will send our own account',
      });
      expect(set).toMatchObject({ state: 'Dismissed', suggestedValue: null });
    });
  });

  it('gives operations outside the wall no suggestion to decide', async () => {
    await k.approve('deal.three', runOf('walled').id);
    const inside = (await k.open('deal.three', WALLED, q3))!;
    for (const who of ['ops.one', 'ops.two'])
      await command(who, inside.id, { command: 'dismiss', reason: 'Not visible' }).expect(404);
    // A wall member who is not operations reads it and may not decide it.
    await command('deal.three', inside.id, { command: 'dismiss', reason: 'Not mine' }).expect(403);
    expect((await k.detail('head.one', inside.id)).state).toBe('Open');
  });
});

describe('valuation suggestions: figures that moved, and the switch (decision 0023)', () => {
  let k: SuggestionKit;
  let q2: string;
  let q3: string;
  let runs: Map<string, ExtractionRun>;
  const STALE = 'INV-0007';
  const CLOSING = 'INV-0004';
  const SWITCHED = 'INV-0006';
  const command = (who: string, id: string, body: object, requestId = 'req-cmd2') =>
    k.post(who, `${SUGGESTIONS}/${id}/commands`, body, requestId);
  const runOf = (key: string): ExtractionRun => runs.get(k.written.get(key)!.fileName)!;

  beforeAll(async () => {
    k = await startSuggestionKit({
      statements: ({ nextQuarter }) => ({
        closing: { position: CLOSING, periodEnd: nextQuarter },
        switched: { position: SWITCHED, periodEnd: nextQuarter },
      }),
    });
    q2 = k.quarterEnd;
    q3 = k.nextQuarter;
    await k.index();
    runs = new Map([...(await k.extractQuarter(q3, CAS)), ...(await k.extractQuarter(q2, QF))]);
  }, 120_000);
  afterAll(async () => {
    await k.close();
  });

  it('replaces a suggestion whose figures changed, commits that, and answers 409', async () => {
    const report = [...runs.values()].find(
      (r) => r.investmentNumber === STALE && r.periodEnd === q2,
    )!;
    await k.approve('deal.one', report.id);
    const open = (await k.open('ops.one', STALE, q2))!;
    expect(open).toMatchObject({ basis: 'sponsor_equity_value', reasonCode: null });
    // Cash moves after the last Locked mark: our stake may have changed, and no approval says so.
    await k.rows(
      "insert into mon.cash_flow (investment_id, flow_date, flow_type, amount, status) values ($1, '2025-05-20', 'flow_type.contribution', -1500000, 'record_status.approved')",
      [k.investment(STALE).id],
    );
    const valuations = await k.count('select count(*)::int as n from mon.valuation');
    const refused = await command(
      'ops.one',
      open.id,
      { command: 'accept' },
      'req-cmd2-changed',
    ).expect(409);
    expect(problemDetails.parse(refused.body)).toMatchObject({
      type: `${PROBLEM}conflict`,
      detail: SUGGESTION_CHANGED_REFUSAL,
    });
    expect(await k.count('select count(*)::int as n from mon.valuation')).toBe(valuations);
    // The replacement was committed with the refusal: the old one names it.
    const replacement = (await k.open('ops.one', STALE, q2))!;
    expect(replacement).toMatchObject({
      basis: 'sponsor_equity_value',
      suggestedValue: null,
      reasonCode: 'flows_since_reference_mark',
      source: { extractionRunId: report.id },
    });
    expect(await k.detail('ops.one', open.id)).toMatchObject({
      state: 'Superseded',
      supersededReason: 'figures_changed',
      supersededById: replacement.id,
      valuationId: null,
    });
    const events = await k.rows<{
      action: string;
      actor_id: string;
      details: Record<string, unknown>;
    }>(
      "select action, actor_id, details from audit.event where request_id = 'req-cmd2-changed' order by id",
    );
    expect(events.map((e) => [e.action, e.actor_id, e.details.mode])).toEqual([
      ['valuation_suggestion.supersede', k.userId('ops.one'), 'refresh'],
      ['valuation_suggestion.open', k.userId('ops.one'), 'refresh'],
    ]);
    // The replacement has no value: nothing to accept.
    await command('ops.one', replacement.id, { command: 'accept' }).expect(422);
  });

  it('closes a suggestion that no longer applies, and answers 409', async () => {
    await k.approve('ops.one', runOf('closing').id);
    const open = (await k.open('ops.one', CLOSING, q3))!;
    await k.rows(
      "update core.investment set is_active = false, exit_date = '2025-09-15' where id = $1",
      [k.investment(CLOSING).id],
    );
    for (const body of [{ command: 'applyToDraft' }]) {
      const refused = await command('ops.one', open.id, body).expect(409);
      expect(problemDetails.parse(refused.body).detail).toBe(SUGGESTION_CHANGED_REFUSAL);
    }
    expect(await k.detail('ops.one', open.id)).toMatchObject({
      state: 'Superseded',
      supersededReason: 'position_closed',
      supersededById: null,
    });
    expect(await k.open('ops.one', CLOSING, q3)).toBeUndefined();
  });

  it('accepts nothing while the switch is off; reading and dismissing still work', async () => {
    await k.approve('ops.one', runOf('switched').id);
    const open = (await k.open('ops.one', SWITCHED, q3))!;
    const setSwitch = (enabled: boolean) =>
      k.h
        .http()
        .patch('/api/v1/flags/valuation.suggestions')
        .set('authorization', k.h.as('platform_admin'))
        .send({ enabled, reason: 'set by the test' })
        .expect(200);
    await setSwitch(false);
    for (const body of [{ command: 'accept' }, { command: 'applyToDraft' }]) {
      const refused = await command('ops.one', open.id, body).expect(409);
      expect(problemDetails.parse(refused.body)).toMatchObject({
        type: `${PROBLEM}kill-switch`,
        detail: SUGGESTIONS_OFF_REFUSAL,
      });
    }
    expect((await k.detail('deal.one', open.id)).state).toBe('Open');
    expect((await k.list('ops.one')).items.map((s) => s.id)).toContain(open.id);
    const dismissed = valuationSuggestionRow.parse(
      (
        await command('ops.one', open.id, {
          command: 'dismiss',
          reason: 'Set aside while switched off',
        }).expect(200)
      ).body,
    );
    expect(dismissed.state).toBe('Dismissed');
    await setSwitch(true);
  });
});
