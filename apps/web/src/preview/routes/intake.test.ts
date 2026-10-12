import { beforeEach, describe, expect, it } from 'vitest';
import {
  intakeExportList,
  intakeFileDetail,
  intakeFilePage,
  intakeImportResult,
  problemDetails,
} from '@pb/contracts';
import type { IntakeImportResult } from '@pb/contracts';
import { accountingExports, generateDataset, previewBook } from '@pb/synthetic';
import { parseBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { FixtureBuilder, USERS, investmentFixture, problemOf, send } from '../test-fixtures.js';

/**
 * The simulated intake over the real generator: the small synthetic profile (seed 42) gives the
 * book, the three sample exports and what each one carries, so every expectation here comes from
 * tools/synthetic rather than a hand count. The mock users of the test world decide who may open
 * which investment: wall members see the walled deal, everyone else gets the recorded 404.
 */
const dataset = generateDataset({ profile: 'small', seed: 42 });
// Through JSON, as the build writes it and the shim reads it.
const book = parseBook(JSON.parse(JSON.stringify(previewBook(dataset))));
const samples = new Map(
  accountingExports(dataset).map((sample, i) => [book.samples[i]?.fileName ?? '', sample]),
);
const sample = (name: string) => {
  const found = samples.get(name);
  if (found === undefined) throw new Error(`no sample ${name}`);
  return found;
};
const walledId = dataset.scenarios.walled_deal?.[0] ?? '';
const walledInvestment = dataset.investments.find((i) => i.id === walledId);
const walledName =
  dataset.portfolioCompanies.find((c) => c.id === walledInvestment?.portfolioCompanyId)?.name ?? '';
const WALL_MEMBERS: readonly string[] = [
  USERS.dealWall.externalId,
  USERS.head.externalId,
  USERS.all.externalId,
];

const IMPORT = '/api/v1/intake/accounting';
const EXPORTS = '/api/v1/intake/accounting/exports';
const FILES = '/api/v1/intake/files?limit=200';
const detailPath = (id: string): string => `/api/v1/intake/files/${id}`;
const commandsPath = (id: string): string => `/api/v1/intake/files/${id}/commands`;

/** Every mock user's own view of the book's investments, recorded as the build records them. */
function buildFixtures() {
  const users = Object.values(USERS);
  const b = new FixtureBuilder(users, dataset.asOf);
  b.add('', '/api/v1/auth/mock-users', {
    users: users.map(({ externalId, displayName, roles }) => ({ externalId, displayName, roles })),
  });
  for (const user of users) {
    const c = user.externalId;
    b.add(c, '/api/v1/auth/me', {
      userId: user.userId,
      externalId: c,
      displayName: user.displayName,
      roles: user.roles,
      clientIds: [],
      mockIdentity: true,
    });
    for (const inv of book.investments) {
      const path = `/api/v1/investments/${inv.id}`;
      if (inv.id !== walledId || WALL_MEMBERS.includes(c))
        b.add(
          c,
          path,
          investmentFixture(inv.id, {
            investmentNumber: inv.investmentNumber,
            companyName: inv.companyName,
          }),
        );
      else b.notFound(c, path);
    }
  }
  return b.build();
}
const fixtures = buildFixtures();

/** The static assets beside the page: the bundled sample exports, served as text. */
const assets: typeof fetch = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const found = samples.get(url.split('/').pop() ?? '');
  return Promise.resolve(
    found === undefined
      ? new Response('', { status: 404 })
      : new Response(found.csv, { status: 200, headers: { 'content-type': 'text/csv' } }),
  );
};

let ids = 0;
const env = {
  newId: (): string => `50000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

function setup(options: { book?: boolean } = {}): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  const f = createPreviewFetch(fixtures, assets, {
    env,
    state,
    ...(options.book === false ? {} : { book }),
  });
  return { f, state };
}

async function stage(f: typeof fetch, name: string): Promise<IntakeImportResult> {
  const answer = await send(f, 'ops.one', 'POST', IMPORT, { exportId: name });
  expect(answer.status, answer.text).toBe(201);
  return intakeImportResult.parse(answer.json);
}

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('simulated intake (docs/04 M2) over the bundled samples and the book', () => {
  it('has a walled deal and three samples to work with', () => {
    expect(walledInvestment).toBeDefined();
    expect(walledName).not.toBe('');
    expect([...samples.keys()]).toEqual([
      'accounting-clean.csv',
      'accounting-update.csv',
      'accounting-defects.csv',
    ]);
  });

  it('lists the bundled samples as the drop folder, for operations only', async () => {
    const { f } = setup();
    const ok = await send(f, 'ops.one', 'GET', EXPORTS);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-pb-simulated')).toBe('true');
    const list = intakeExportList.parse(ok.json);
    expect(list.items.map((i) => i.id)).toEqual([...samples.keys()]);
    expect(list.items.every((i) => i.name === i.id && i.receivedAt.startsWith(book.asOf))).toBe(
      true,
    );
    expect((await send(f, 'viewer.one', 'GET', EXPORTS)).status).toBe(403);
    expect((await send(f, 'deal.one', 'GET', EXPORTS)).status).toBe(403);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('stages the update sample with the counts the generator promises and nothing flagged', async () => {
    const { f, state } = setup();
    const update = sample('accounting-update.csv');
    const file = await stage(f, 'accounting-update.csv');
    expect(file.duplicate).toBe(false);
    expect(file.source).toBe('accounting');
    expect(file.fileName).toBe('accounting-update.csv');
    expect(file.receivedBy).toBe(USERS.ops.displayName);
    expect(file.receivedAt).toBe(env.now());
    expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(file.rowCount).toBe(update.expectations.rows);
    expect(file.counts).toEqual({
      new: 0,
      validated: update.expectations.rows,
      flagged: 0,
      approved: 0,
      rejected: 0,
      promoted: 0,
    });
    expect(file.status).toBe('validated');
    expect(file.exceptions).toBe(0);
    expect(file.fileFindings).toEqual([]);
    // ops.one is outside the wall: the walled position's row is counted, never shown.
    expect(file.hiddenRows).toBe(1);
    expect(file.rows).toHaveLength(update.expectations.rows - 1);
    expect(file.rows.map((r) => r.rowNo)).toEqual(
      [...file.rows.map((r) => r.rowNo)].sort((a, b) => a - b),
    );
    const by = (kind: 'changed' | 'new'): (string | null)[] =>
      file.rows.filter((r) => r.diff.kind === kind).map((r) => r.investmentNumber);
    expect(by('changed')).toEqual(update.expectations.changed);
    expect(by('new')).toEqual(update.expectations.added);
    const changed = file.rows.find((r) => r.diff.kind === 'changed');
    expect(changed?.diff.changes.map((c) => c.field).sort()).toEqual(['ebitdaLtm', 'revenueLtm']);
    expect(changed?.targetId).not.toBeNull();
    expect(file.rows.find((r) => r.diff.kind === 'new')?.targetId).toBeNull();
    // Every row linked; warnings may travel with a row, errors would have flagged it.
    expect(
      file.rows.every(
        (r) =>
          r.link.status === 'matched' &&
          r.link.investmentId !== null &&
          r.findings.every((x) => x.severity === 'warning'),
      ),
    ).toBe(true);
    expect(file.rows.every((r) => r.targetEntity === 'quarterly_performance')).toBe(true);
    // The import is recorded with counts only.
    expect(state.audit.map((e) => e.action)).toEqual(['intake.import']);
    expect(state.audit[0]?.details).toEqual({ rowCount: file.rowCount, ...file.counts });
    expect(state.audit[0]?.entity).toBe('intake_file');
  });

  it('answers the same text again with the file staged before and duplicate true', async () => {
    const { f, state } = setup();
    const update = sample('accounting-update.csv');
    const uploaded = await send(f, 'ops.one', 'POST', IMPORT, {
      fileName: 'restated-q2.csv',
      csv: update.csv,
    });
    expect(uploaded.status).toBe(201);
    const first = intakeImportResult.parse(uploaded.json);
    expect(first.fileName).toBe('restated-q2.csv');
    const again = await stage(f, 'accounting-update.csv');
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
    expect(again.fileName).toBe('restated-q2.csv');
    expect(state.intakeFiles.size).toBe(1);
    const page = intakeFilePage.parse((await send(f, 'ops.one', 'GET', FILES)).json);
    expect(page.items.map((i) => i.id)).toEqual([first.id]);
    expect(page.nextCursor).toBeNull();
  });

  it('flags each defect row by the rule the generator names and counts the exceptions', async () => {
    const { f } = setup();
    const defects = sample('accounting-defects.csv');
    const staged = await stage(f, 'accounting-defects.csv');
    // deal.three is on the wall and sees every row.
    const full = intakeFileDetail.parse(
      (await send(f, 'deal.three', 'GET', detailPath(staged.id))).json,
    );
    expect(full.hiddenRows).toBe(0);
    expect(full.rows).toHaveLength(defects.expectations.rows);
    expect(defects.expectations.flagged.length).toBeGreaterThanOrEqual(6);
    for (const { rowNo, ruleId } of defects.expectations.flagged) {
      const row = full.rows.find((r) => r.rowNo === rowNo);
      expect(row?.status, `row ${rowNo} (${ruleId})`).toBe('flagged');
      expect(
        row?.findings.map((x) => x.ruleId),
        `row ${rowNo}`,
      ).toContain(ruleId);
      expect(row?.findings.find((x) => x.ruleId === ruleId)?.severity).toBe('error');
    }
    const unmatched = full.rows.filter((r) => r.link.status === 'unmatched');
    const guarded = full.rows.filter((r) => r.link.status === 'guarded');
    const ties = full.rows.flatMap((r) => r.findings.filter((x) => x.ruleId === 'TIE-01'));
    expect(unmatched).toHaveLength(2);
    expect(guarded).toHaveLength(1);
    expect(ties).toHaveLength(1);
    // One exception per unresolved link and one per fair value that does not tie, as the API opens them.
    expect(staged.exceptions).toBe(unmatched.length + guarded.length + ties.length);
    expect(staged.status).toBe('flagged');
    expect(staged.counts.flagged).toBe(full.rows.filter((r) => r.status === 'flagged').length);
    expect(staged.counts.flagged + staged.counts.validated).toBe(defects.expectations.rows);
    // A near miss offers its candidate to a person, never a link.
    const nearMiss = unmatched.find((r) => r.investmentNumber === null);
    expect(nearMiss?.link.candidates).toHaveLength(1);
    expect(nearMiss?.link.candidates[0]?.reason).toBe('near miss');
    expect(nearMiss?.targetId).toBeNull();
    expect(guarded[0]?.link.candidates.some((c) => c.reason === 'match guard')).toBe(true);
    expect(guarded[0]?.companyName).toBe(book.matchGuards[0]?.nameB);
    // The duplicate row shares its natural key with the row it repeats and is flagged, not dropped.
    const dup = defects.expectations.flagged.find((x) => x.ruleId === 'DUP-01');
    const dupRow = full.rows.find((r) => r.rowNo === dup?.rowNo);
    const original = full.rows.find(
      (r) => dup !== undefined && r.rowNo < dup.rowNo && r.naturalKey === dupRow?.naturalKey,
    );
    expect(original?.status).toBe('validated');
    expect(full.rows.flatMap((r) => r.findings).some((x) => x.message.includes('—'))).toBe(false);
  });

  it('hides rows linked past the reader wall and counts them; a wall member sees every row', async () => {
    const { f } = setup();
    const staged = await stage(f, 'accounting-clean.csv');
    const ops = await send(f, 'ops.one', 'GET', detailPath(staged.id));
    expect(ops.status).toBe(200);
    const opsView = intakeFileDetail.parse(ops.json);
    expect(opsView.hiddenRows).toBe(1);
    expect(opsView.rows.some((r) => r.link.investmentId === walledId)).toBe(false);
    expect(ops.text).not.toContain(walledId);
    expect(ops.text).not.toContain(walledName);
    expect(ops.text).not.toContain(walledInvestment?.investmentNumber ?? '');
    const outsider = intakeFileDetail.parse(
      (await send(f, 'deal.one', 'GET', detailPath(staged.id))).json,
    );
    expect(outsider.hiddenRows).toBe(1);
    expect(outsider.rows).toHaveLength(opsView.rows.length);
    // The file reads the same for everyone: counts cover every row, hidden ones included.
    expect(outsider.counts).toEqual(opsView.counts);
    expect(outsider.rowCount).toBe(opsView.rowCount);
    const member = intakeFileDetail.parse(
      (await send(f, 'deal.three', 'GET', detailPath(staged.id))).json,
    );
    expect(member.hiddenRows).toBe(0);
    expect(member.rows).toHaveLength(opsView.rows.length + 1);
    const walledRow = member.rows.find((r) => r.link.investmentId === walledId);
    expect(walledRow?.link.status).toBe('matched');
    expect(walledRow?.status).toBe('validated');
    expect(walledRow?.companyName).toBe(walledName);
    // Naming a hidden row is the same as naming a row of another file.
    for (const who of ['deal.one', 'ops.one']) {
      const refused = await send(f, who, 'POST', commandsPath(staged.id), {
        command: 'approve',
        rowIds: [walledRow?.id ?? ''],
      });
      expect(refused.status, who).toBe(400);
      expect(problemDetails.parse(refused.json).errors?.map((e) => e.path)).toEqual(['rowIds']);
    }
    // Approvers read; a viewer is told the route is not theirs.
    expect((await send(f, 'head.one', 'GET', detailPath(staged.id))).status).toBe(200);
    expect((await send(f, 'viewer.one', 'GET', detailPath(staged.id))).status).toBe(403);
  });

  it('approve-all promotes the validated rows the caller sees; the wall member finishes the file', async () => {
    const { f, state } = setup();
    const update = sample('accounting-update.csv');
    const bookBefore = JSON.stringify(book);
    const staged = await stage(f, 'accounting-update.csv');
    const commands = commandsPath(staged.id);
    const approved = await send(f, 'ops.one', 'POST', commands, { command: 'approve' });
    expect(approved.status, approved.text).toBe(200);
    const after = intakeFileDetail.parse(approved.json);
    expect(after.counts.promoted).toBe(update.expectations.rows - 1);
    expect(after.counts.validated).toBe(1);
    expect(after.status).toBe('validated');
    expect(after.hiddenRows).toBe(1);
    expect(after.rowVersion).toBe(2);
    for (const row of after.rows) {
      expect(row.status).toBe('promoted');
      expect(row.decidedBy).toBe(USERS.ops.displayName);
      expect(row.promotedAt).toBe(env.now());
      expect(row.decision).toBe('accounting import accounting-update.csv');
      expect(row.targetId).not.toBeNull();
    }
    // The standing rule: promotion changes the staged rows only, never the recorded figures.
    expect(JSON.stringify(book)).toBe(bookBefore);
    expect(state.audit.filter((e) => e.action === 'quarterly_performance.promote')).toHaveLength(
      update.expectations.rows - 1,
    );
    expect(state.audit.filter((e) => e.action === 'intake.approve')).toHaveLength(1);
    // Nothing left for ops.one: the command answers the unchanged file.
    const again = intakeFileDetail.parse(
      (await send(f, 'ops.one', 'POST', commands, { command: 'approve' })).json,
    );
    expect(again.counts).toEqual(after.counts);
    expect(again.rowVersion).toBe(2);
    // The wall member approves the walled position's row and the file reads promoted.
    const finished = intakeFileDetail.parse(
      (await send(f, 'deal.three', 'POST', commands, { command: 'approve' })).json,
    );
    expect(finished.hiddenRows).toBe(0);
    expect(finished.counts.promoted).toBe(update.expectations.rows);
    expect(finished.status).toBe('promoted');
    const promoted = intakeFilePage.parse(
      (await send(f, 'ops.one', 'GET', `${FILES}&status=promoted`)).json,
    );
    expect(promoted.items.map((i) => i.id)).toEqual([staged.id]);
    expect(
      intakeFilePage.parse((await send(f, 'ops.one', 'GET', `${FILES}&status=flagged`)).json).items,
    ).toEqual([]);
    // A promoted row cannot be approved again.
    const named = await send(f, 'deal.three', 'POST', commands, {
      command: 'approve',
      rowIds: [finished.rows[0]?.id ?? ''],
    });
    expect(named.status).toBe(400);
  });

  it('rejects flagged rows with a reason the table requires, operations only; the walled defect stays flagged', async () => {
    const { f } = setup();
    const staged = await stage(f, 'accounting-defects.csv');
    const commands = commandsPath(staged.id);
    const noReason = await send(f, 'ops.one', 'POST', commands, { command: 'reject' });
    expect(noReason.status).toBe(422);
    expect(problemOf(noReason)).toEqual({
      code: 'workflow-precondition',
      detail: 'staging: a reason is required',
    });
    const dealTeam = await send(f, 'deal.one', 'POST', commands, {
      command: 'reject',
      reason: 'Not ours to decide',
    });
    expect(dealTeam.status).toBe(403);
    expect(problemOf(dealTeam).code).toBe('forbidden');
    const before = intakeFileDetail.parse(
      (await send(f, 'ops.one', 'GET', detailPath(staged.id))).json,
    );
    const visibleFlagged = before.rows.filter((r) => r.status === 'flagged').length;
    expect(visibleFlagged).toBeGreaterThan(0);
    const reason = 'Names sent back to the accounting team';
    const rejected = intakeFileDetail.parse(
      (await send(f, 'ops.one', 'POST', commands, { command: 'reject', reason })).json,
    );
    expect(rejected.counts.rejected).toBe(visibleFlagged);
    // The walled position's defect row is past ops.one's wall: it stays flagged, and so does the file.
    expect(rejected.counts.flagged).toBe(before.counts.flagged - visibleFlagged);
    expect(rejected.counts.flagged).toBe(1);
    expect(rejected.status).toBe('flagged');
    for (const row of rejected.rows.filter((r) => r.status === 'rejected')) {
      expect(row.decision).toBe(reason);
      expect(row.decidedBy).toBe(USERS.ops.displayName);
      expect(row.promotedAt).toBeNull();
    }
    // A flagged row cannot be approved, with the row named or not.
    const member = intakeFileDetail.parse(
      (await send(f, 'deal.three', 'GET', detailPath(staged.id))).json,
    );
    const walledFlagged = member.rows.find(
      (r) => r.link.investmentId === walledId && r.status === 'flagged',
    );
    expect(walledFlagged).toBeDefined();
    const wrongState = await send(f, 'deal.three', 'POST', commands, {
      command: 'approve',
      rowIds: [walledFlagged?.id ?? ''],
    });
    expect(wrongState.status).toBe(400);
    const finished = intakeFileDetail.parse(
      (await send(f, 'deal.three', 'POST', commands, { command: 'approve' })).json,
    );
    expect(finished.counts.validated).toBe(0);
    expect(finished.counts.flagged).toBe(1);
    expect(finished.status).toBe('flagged');
  });

  it('refuses a viewer on the list and the import, and answers 404 for unknown files and exports', async () => {
    const { f } = setup();
    expect((await send(f, 'viewer.one', 'GET', FILES)).status).toBe(403);
    expect(
      (await send(f, 'viewer.one', 'POST', IMPORT, { exportId: 'accounting-clean.csv' })).status,
    ).toBe(403);
    expect(
      (await send(f, 'deal.one', 'POST', IMPORT, { exportId: 'accounting-clean.csv' })).status,
    ).toBe(403);
    const unknown = '00000000-0000-4000-8000-00000000abcd';
    expect(
      (await send(f, 'head.one', 'POST', commandsPath(unknown), { command: 'approve' })).status,
    ).toBe(403);
    for (const id of ['not-a-uuid', unknown]) {
      expect((await send(f, 'ops.one', 'GET', detailPath(id))).status, id).toBe(404);
      expect(
        (await send(f, 'ops.one', 'POST', commandsPath(id), { command: 'approve' })).status,
        id,
      ).toBe(404);
    }
    const missing = await send(f, 'ops.one', 'POST', IMPORT, { exportId: 'accounting-other.csv' });
    expect(missing.status).toBe(404);
    expect(problemOf(missing).detail).toBe('Export not found');
    const malformed = await send(f, 'ops.one', 'POST', IMPORT, { fileName: 'x.csv' });
    expect(malformed.status).toBe(400);
    expect(problemDetails.parse(malformed.json).errors?.length).toBeGreaterThan(0);
    expect((await send(f, 'ops.one', 'GET', '/api/v1/intake/files?limit=0')).status).toBe(400);
    const badCursor = await send(f, 'ops.one', 'GET', '/api/v1/intake/files?cursor=nonsense');
    expect(badCursor.status).toBe(400);
    expect(problemOf(badCursor).detail).toBe('Invalid cursor');
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('refuses a file the layout does not know and a file over the byte limit, staging nothing', async () => {
    const { f } = setup();
    const renamed = await send(f, 'ops.one', 'POST', IMPORT, {
      fileName: 'renamed.csv',
      csv: 'InvestmentNumber,Period,RevenueLTM\nINV-0001,2025-06-30,1\n',
    });
    expect(renamed.status).toBe(201);
    const file = intakeImportResult.parse(renamed.json);
    expect(file.rowCount).toBe(0);
    expect(file.status).toBe('new');
    expect(file.rows).toEqual([]);
    expect(file.counts).toEqual({
      new: 0,
      validated: 0,
      flagged: 0,
      approved: 0,
      rejected: 0,
      promoted: 0,
    });
    expect(file.fileFindings.map((x) => x.ruleId)).toEqual(
      expect.arrayContaining(['LAYOUT-01', 'LAYOUT-02']),
    );
    expect(file.exceptions).toBe(0);
    // Two bytes per character, so the text is under the contract's character cap and over the byte limit.
    const huge = await send(f, 'ops.one', 'POST', IMPORT, {
      fileName: 'huge.csv',
      csv: 'é'.repeat(1_500_000),
    });
    expect(huge.status).toBe(400);
    expect(problemOf(huge).detail).toBe('The file is larger than one import accepts');
  });

  it('pages the list newest first with an opaque cursor, and forgets everything on reset', async () => {
    const { f, state } = setup();
    const first = await stage(f, 'accounting-clean.csv');
    const second = await stage(f, 'accounting-update.csv');
    const page1 = intakeFilePage.parse(
      (await send(f, 'head.one', 'GET', '/api/v1/intake/files?limit=1')).json,
    );
    expect(page1.items.map((i) => i.id)).toEqual([second.id]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = intakeFilePage.parse(
      (
        await send(
          f,
          'head.one',
          'GET',
          `/api/v1/intake/files?limit=1&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
        )
      ).json,
    );
    expect(page2.items.map((i) => i.id)).toEqual([first.id]);
    expect(page2.nextCursor).toBeNull();
    const reset = await send(f, 'viewer.one', 'POST', '/api/v1/preview/reset');
    expect(reset.status).toBe(200);
    expect(state.intakeFiles.size).toBe(0);
    expect(intakeFilePage.parse((await send(f, 'ops.one', 'GET', FILES)).json).items).toEqual([]);
    expect((await send(f, 'ops.one', 'GET', detailPath(first.id))).status).toBe(404);
    // The same text stages afresh after a reset.
    expect((await stage(f, 'accounting-clean.csv')).duplicate).toBe(false);
  });

  it('says so when a world carries no book', async () => {
    const { f } = setup({ book: false });
    const answer = await send(f, 'ops.one', 'GET', EXPORTS);
    expect(answer.status).toBe(503);
    expect(problemOf(answer).code).toBe('unavailable');
    expect(
      (await send(f, 'ops.one', 'POST', IMPORT, { exportId: 'accounting-clean.csv' })).status,
    ).toBe(503);
  });
});
