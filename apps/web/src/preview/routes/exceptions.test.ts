import { beforeEach, describe, expect, it } from 'vitest';
import {
  dataException,
  dataExceptionListQuery,
  dataExceptionPage,
  dataHealth,
  intakeImportResult,
  lookthroughReconcileResult,
  problemDetails,
} from '@pb/contracts';
import type { DataException, LookthroughReconcileResult } from '@pb/contracts';
import {
  accountingExports,
  generateDataset,
  previewBook,
  previewLookthroughExtracts,
} from '@pb/synthetic';
import { parseCsv, toCsv } from '@pb/validation';
import { parseBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { USERS, generatedWorld, problemOf, send, serveSamples } from '../test-fixtures.js';

/**
 * The simulated data exceptions queue over what the simulated intakes open: the look-through
 * defects extract (differences, an unmapped label, unresolved links) and an accounting row of the
 * walled position whose fair value does not tie, so one exception sits behind the wall.
 */
const dataset = generateDataset({ profile: 'small', seed: 42 });
const book = parseBook(JSON.parse(JSON.stringify(previewBook(dataset))));
const walledId = dataset.scenarios.walled_deal?.[0] ?? '';
const walled = book.investments.find((i) => i.id === walledId);
const fixtures = generatedWorld(book, walledId);
const samples = new Map<string, string | Uint8Array>();
for (const [i, extract] of previewLookthroughExtracts(dataset).entries())
  samples.set(book.lookthroughSamples[i]?.fileName ?? '', extract.json);
const exports = accountingExports(dataset);
for (const [i, sample] of exports.entries())
  samples.set(book.samples[i]?.fileName ?? '', sample.csv);

/** The walled position's clean row with a fair value that cannot tie to its Locked mark: one TIE-01 exception inside the wall. */
function walledTieCsv(): string {
  const table = parseCsv(exports[0]?.csv ?? '');
  const number = table.header.indexOf('InvestmentNumber');
  const fairValue = table.header.indexOf('FairValue');
  const row = table.rows.find((r) => r[number] === walled?.investmentNumber);
  if (row === undefined) throw new Error('the clean export has no row for the walled position');
  const cells = [...row];
  cells[fairValue] = '1.00';
  return toCsv(table.header, [cells]);
}

const LIST = '/api/v1/data-exceptions?limit=200';
const HEALTH = '/api/v1/data-health';
const RECONCILE = '/api/v1/intake/lookthrough/reconcile';
const path = (id: string): string => `/api/v1/data-exceptions/${id}`;
const commandsPath = (id: string): string => `${path(id)}/commands`;

let ids = 0;
let clock = 0;
const env = {
  newId: (): string => `54000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  // Each call a second later, so opening times order the queue.
  now: (): string =>
    `2025-07-01T09:${String(Math.floor(++clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}.000Z`,
};

function setup(): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  const f = createPreviewFetch(fixtures, serveSamples(samples), { env, state, book });
  return { f, state };
}

async function reconcileDefects(f: typeof fetch): Promise<LookthroughReconcileResult> {
  const answer = await send(f, 'ops.one', 'POST', RECONCILE, { asOf: book.asOf });
  expect(answer.status, answer.text).toBe(201);
  return lookthroughReconcileResult.parse(answer.json);
}

async function stageWalledTie(f: typeof fetch): Promise<string> {
  const answer = await send(f, 'ops.one', 'POST', '/api/v1/intake/accounting', {
    fileName: 'walled-tie.csv',
    csv: walledTieCsv(),
  });
  expect(answer.status, answer.text).toBe(201);
  const file = intakeImportResult.parse(answer.json);
  expect(file.exceptions).toBe(1);
  expect(file.hiddenRows).toBe(1);
  return file.id;
}

const list = async (f: typeof fetch, who: string, query = LIST) => {
  const answer = await send(f, who, 'GET', query);
  expect(answer.status, answer.text).toBe(200);
  return dataExceptionPage.parse(answer.json);
};

const command = async (f: typeof fetch, who: string, id: string, body: unknown) =>
  send(f, who, 'POST', commandsPath(id), body);

const health = async (f: typeof fetch, who: string): Promise<number> =>
  dataHealth.parse((await send(f, who, 'GET', HEALTH)).json).openExceptions;

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('simulated data exceptions queue (docs/18 section 9) over what the intakes opened', () => {
  it('lists what the intakes opened, newest first, with the context a reader may see, hiding what sits behind their wall', async () => {
    const { f } = setup();
    const run = await reconcileDefects(f);
    const tieFileId = await stageWalledTie(f);
    const ops = await list(f, 'ops.one');
    const member = await list(f, 'deal.three');
    expect(ops.items).toHaveLength(run.exceptions);
    expect(member.items).toHaveLength(run.exceptions + 1);
    expect(ops.nextCursor).toBeNull();
    expect(ops.items.some((x) => x.context.investmentId === walledId)).toBe(false);
    // Newest first: the fair value that does not tie was opened after the reconcile.
    const tie = member.items[0];
    expect(tie?.ruleId).toBe('TIE-01');
    expect(tie?.source).toBe('accounting_import');
    expect(tie?.entity).toBe('stg.intake_row');
    expect(tie?.severity).toBe('exception_severity.high');
    expect(tie?.state).toBe('open');
    expect(tie?.owner).toBeNull();
    expect(tie?.externalTicket).toBeNull();
    expect(tie?.expected).toBeNull();
    expect(tie?.actual).toBeNull();
    expect(tie?.candidates).toEqual([]);
    expect(tie?.rowVersion).toBe(1);
    expect(tie?.context).toEqual({
      intakeFileId: tieFileId,
      intakeFileName: 'walled-tie.csv',
      rowNo: 1,
      investmentId: walledId,
      investmentNumber: walled?.investmentNumber,
      companyName: walled?.companyName,
    });
    // Nothing in the outsider's answer names the walled position; the exception itself is not found for them.
    const outsider = await send(f, 'ops.one', 'GET', LIST);
    expect(outsider.text).not.toContain(walled?.companyName ?? '');
    expect(outsider.text).not.toContain(walled?.investmentNumber ?? '');
    expect((await send(f, 'ops.one', 'GET', path(tie?.id ?? ''))).status).toBe(404);
    expect((await send(f, 'deal.three', 'GET', path(tie?.id ?? ''))).status).toBe(200);
    expect((await send(f, 'head.one', 'GET', path(tie?.id ?? ''))).status).toBe(200);
    // A reconcile exception names the run, the row and, for an unresolved link, no position.
    const unresolved = ops.items.find((x) => x.ruleId === 'LT-XREF-01');
    expect(unresolved?.context.intakeFileId).toBe(run.id);
    expect(unresolved?.context.intakeFileName).toBe(run.fileName);
    expect(unresolved?.context.rowNo).toBeGreaterThan(0);
    expect(unresolved?.context.investmentId).toBeNull();
    expect(unresolved?.expected).toBe('a position on record');
    const nearMiss = ops.items.find((x) => x.ruleId === 'LT-XREF-01' && x.candidates.length > 0);
    expect(nearMiss?.candidates).toEqual([{ reason: 'near miss' }]);
    // A difference names the position the reader may open, with what the record says and what the provider sent.
    const tieNav = ops.items.find((x) => x.ruleId === 'LT-TIE-01');
    expect(tieNav?.context.investmentNumber).not.toBeNull();
    expect(tieNav?.expected).not.toBeNull();
    expect(tieNav?.actual).not.toBeNull();
    expect(tieNav?.severity).toBe('exception_severity.high');
    // Every reviewing role reads the queue; a viewer is told it is not theirs.
    expect((await send(f, 'viewer.one', 'GET', LIST)).status).toBe(403);
    for (const who of ['deal.one', 'head.one', 'all.roles'])
      expect((await send(f, who, 'GET', LIST)).status, who).toBe(200);
    expect((await send(f, 'ops.one', 'GET', path('not-a-uuid'))).status).toBe(404);
    for (const x of member.items) dataException.parse(x);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('filters by state, source and severity, and pages on a cursor', async () => {
    const { f } = setup();
    const run = await reconcileDefects(f);
    await stageWalledTie(f);
    const all = await list(f, 'deal.three');
    const high = await list(f, 'deal.three', `${LIST}&severity=exception_severity.high`);
    expect(high.items.every((x) => x.severity === 'exception_severity.high')).toBe(true);
    expect(high.items.length).toBeGreaterThan(0);
    expect(high.items.length).toBeLessThan(all.items.length);
    const reconciled = await list(f, 'deal.three', `${LIST}&source=lookthrough_reconcile`);
    expect(reconciled.items).toHaveLength(run.exceptions);
    expect((await list(f, 'deal.three', `${LIST}&source=accounting_import`)).items).toHaveLength(1);
    const first = all.items[0];
    const ack = await command(f, 'ops.one', all.items[1]?.id ?? '', { command: 'acknowledge' });
    expect(ack.status, ack.text).toBe(200);
    expect(
      (await list(f, 'deal.three', `${LIST}&state=acknowledged`)).items.map((x) => x.id),
    ).toEqual([all.items[1]?.id]);
    expect((await list(f, 'deal.three', `${LIST}&state=open`)).items).toHaveLength(
      all.items.length - 1,
    );
    // A page of one, then the next from the cursor, in the same order as the whole list.
    const page1 = await list(f, 'deal.three', '/api/v1/data-exceptions?limit=1');
    expect(page1.items.map((x) => x.id)).toEqual([first?.id]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await list(
      f,
      'deal.three',
      `/api/v1/data-exceptions?limit=1&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
    );
    expect(page2.items.map((x) => x.id)).toEqual([all.items[1]?.id]);
    const bad = await send(f, 'deal.three', 'GET', '/api/v1/data-exceptions?cursor=nonsense');
    expect(bad.status).toBe(400);
    expect(problemOf(bad).detail).toBe('Invalid cursor');
    // The file filter joins the contract with the change that adds it to the query.
    const fileFilter = `${LIST}&intakeFileId=${run.id}`;
    if ('intakeFileId' in dataExceptionListQuery.shape) {
      const ofRun = await list(f, 'deal.three', fileFilter);
      expect(ofRun.items).toHaveLength(run.exceptions);
      expect(ofRun.items.every((x) => x.context.intakeFileId === run.id)).toBe(true);
    } else {
      expect((await send(f, 'deal.three', 'GET', fileFilter)).status).toBe(400);
    }
  });

  it('works an exception through the table: acknowledge, resolve or close with a reason, set a ticket; refuses what the table lacks', async () => {
    const { f, state } = setup();
    await reconcileDefects(f);
    const [x1, x2, x3] = (await list(f, 'ops.one')).items;
    if (x1 === undefined || x2 === undefined || x3 === undefined)
      throw new Error('the defects extract opened fewer than three exceptions');
    expect((await command(f, 'viewer.one', x1.id, { command: 'acknowledge' })).status).toBe(403);
    expect((await command(f, 'deal.one', x1.id, { command: 'acknowledge' })).status).toBe(403);
    expect((await command(f, 'head.one', x1.id, { command: 'acknowledge' })).status).toBe(403);

    const acknowledged = await command(f, 'ops.one', x1.id, { command: 'acknowledge' });
    expect(acknowledged.status, acknowledged.text).toBe(200);
    expect(acknowledged.headers.get('x-pb-simulated')).toBe('true');
    const taken = dataException.parse(acknowledged.json);
    expect(taken.state).toBe('acknowledged');
    expect(taken.owner).toBe(USERS.ops.displayName);
    expect(taken.rowVersion).toBe(2);
    expect(taken.updatedAt > taken.createdAt).toBe(true);
    // A reason is required to resolve or close (the contract refuses before the table would).
    const noReason = await command(f, 'ops.one', x1.id, { command: 'resolve' });
    expect(noReason.status).toBe(400);
    expect(problemDetails.parse(noReason.json).errors?.map((e) => e.path)).toEqual(['reason']);
    const resolved = dataException.parse(
      (
        await command(f, 'ops.one', x1.id, {
          command: 'resolve',
          reason: 'Provider resent the row',
        })
      ).json,
    );
    expect(resolved.state).toBe('resolved');
    expect(resolved.owner).toBe(USERS.ops.displayName);
    expect(resolved.rowVersion).toBe(3);
    // A terminal state lists no transition: the table lacks the row, the 409 WORKFLOW_REFUSALS maps.
    const again = await command(f, 'ops.one', x1.id, { command: 'acknowledge' });
    expect(again.status).toBe(409);
    expect(problemOf(again)).toEqual({
      code: 'workflow-transition',
      detail: 'data_exception: acknowledge is not allowed from resolved',
    });
    const closed = dataException.parse(
      (await command(f, 'ops.two', x2.id, { command: 'wont_fix', reason: 'The provider rounds' }))
        .json,
    );
    expect(closed.state).toBe('wont_fix');
    expect(closed.owner).toBeNull();
    expect(
      (await command(f, 'ops.one', x2.id, { command: 'resolve', reason: 'Now fixed' })).status,
    ).toBe(409);
    // The ticket is not a transition: set in any state, the state stays.
    const ticketed = dataException.parse(
      (await command(f, 'ops.one', x3.id, { command: 'set_ticket', externalTicket: 'HD-1234' }))
        .json,
    );
    expect(ticketed.state).toBe('open');
    expect(ticketed.externalTicket).toBe('HD-1234');
    expect(ticketed.rowVersion).toBe(2);
    const noTicket = await command(f, 'ops.one', x3.id, { command: 'set_ticket' });
    expect(noTicket.status).toBe(400);
    expect(problemDetails.parse(noTicket.json).errors?.map((e) => e.path)).toEqual([
      'externalTicket',
    ]);
    const onResolved = dataException.parse(
      (await command(f, 'ops.one', x1.id, { command: 'set_ticket', externalTicket: 'HD-9' })).json,
    );
    expect(onResolved.state).toBe('resolved');
    expect(onResolved.externalTicket).toBe('HD-9');
    // The detail reads what the commands left; the audit names each command.
    const detail = dataException.parse((await send(f, 'head.one', 'GET', path(x1.id))).json);
    expect(detail).toEqual(onResolved);
    expect(state.audit.map((e) => e.action)).toEqual([
      'intake.reconcile',
      'data_exception.acknowledge',
      'data_exception.resolve',
      'data_exception.wont_fix',
      'data_exception.set_ticket',
      'data_exception.set_ticket',
    ]);
    expect(
      (
        await command(f, 'ops.one', '00000000-0000-4000-8000-00000000abcd', {
          command: 'acknowledge',
        })
      ).status,
    ).toBe(404);
    expect((await command(f, 'ops.one', x3.id, { command: 'close' })).status).toBe(400);
  });

  it('refuses a command on an exception behind the caller wall as not found', async () => {
    const { f } = setup();
    await stageWalledTie(f);
    const tie = (await list(f, 'deal.three')).items[0];
    expect(tie?.context.investmentId).toBe(walledId);
    expect((await command(f, 'ops.one', tie?.id ?? '', { command: 'acknowledge' })).status).toBe(
      404,
    );
    // all.roles holds operations and sits on the wall, so it may work it.
    const taken = await command(f, 'all.roles', tie?.id ?? '', { command: 'acknowledge' });
    expect(taken.status, taken.text).toBe(200);
    expect(dataException.parse(taken.json).owner).toBe(USERS.all.displayName);
  });

  it('adds the open and acknowledged exceptions to Data Health for every reader, and forgets them on reset', async () => {
    const { f, state } = setup();
    expect(await health(f, 'viewer.one')).toBe(0);
    const run = await reconcileDefects(f);
    await stageWalledTie(f);
    const opened = run.exceptions + 1;
    expect(await health(f, 'viewer.one')).toBe(opened);
    expect(await health(f, 'ops.one')).toBe(opened);
    const items = (await list(f, 'ops.one')).items;
    await command(f, 'ops.one', items[0]?.id ?? '', { command: 'acknowledge' });
    expect(await health(f, 'viewer.one')).toBe(opened);
    await command(f, 'ops.one', items[0]?.id ?? '', {
      command: 'resolve',
      reason: 'Fixed at source',
    });
    expect(await health(f, 'viewer.one')).toBe(opened - 1);
    await command(f, 'ops.one', items[1]?.id ?? '', { command: 'wont_fix', reason: 'Rounding' });
    expect(await health(f, 'deal.three')).toBe(opened - 2);
    expect((await send(f, 'viewer.one', 'POST', '/api/v1/preview/reset')).status).toBe(200);
    expect(state.exceptions.size).toBe(0);
    expect(await health(f, 'viewer.one')).toBe(0);
    expect((await list(f, 'deal.three')).items).toEqual([]);
    expect((await send(f, 'ops.one', 'GET', path(items[0]?.id ?? ''))).status).toBe(404);
    const parsed: DataException[] = (await list(f, 'ops.one')).items;
    expect(parsed).toEqual([]);
  });
});
