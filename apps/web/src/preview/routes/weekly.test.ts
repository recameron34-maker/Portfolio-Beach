import { beforeEach, describe, expect, it } from 'vitest';
import { D } from '@pb/calc';
import {
  intakeExportList,
  intakeFilePage,
  problemDetails,
  valuationPage,
  weeklyFileDetail,
  weeklyImportResult,
} from '@pb/contracts';
import type { WeeklyImportResult, WeeklyRow } from '@pb/contracts';
import { generateDataset, previewBook, previewWeeklyFiles } from '@pb/synthetic';
import type { WeeklyValues } from '@pb/synthetic';
import { parseCsv, toCsv, weeklyRuleConfigFrom } from '@pb/validation';
import definitions from '../../../../../config/definitions.json';
import { parseBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { VALUATIONS_PATH, createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { USERS, generatedWorld, problemOf, send, serveSamples } from '../test-fixtures.js';
import { priorFor } from './weekly.js';

/**
 * The simulated weekly values intake over the real generator: the small synthetic profile (seed
 * 42) gives the book, the three bundled weekly files and what each one carries, so every
 * expectation here comes from tools/synthetic rather than a hand count. Wall members see the
 * walled deal, everyone else gets the recorded 404.
 */
const dataset = generateDataset({ profile: 'small', seed: 42 });
const book = parseBook(JSON.parse(JSON.stringify(previewBook(dataset))));
const walledId = dataset.scenarios.walled_deal?.[0] ?? '';
const walled = book.investments.find((i) => i.id === walledId);
const fixtures = generatedWorld(book, walledId);
const files = previewWeeklyFiles(dataset);
const samples = new Map<string, string | Uint8Array>();
const byName = new Map<string, WeeklyValues>();
for (const [i, file] of files.entries()) {
  const name = book.weeklySamples[i]?.fileName ?? '';
  samples.set(name, file.csv);
  byName.set(name, file);
}
const sample = (name: string): WeeklyValues => {
  const found = byName.get(name);
  if (found === undefined) throw new Error(`no sample ${name}`);
  return found;
};
const threshold = weeklyRuleConfigFrom(definitions).varianceThresholdPct;

const DROPS = '/api/v1/intake/weekly/drops';
const IMPORT = '/api/v1/intake/weekly';
const FILES = '/api/v1/intake/files?limit=200';
const detailPath = (id: string): string => `/api/v1/intake/weekly/files/${id}`;
const commandsPath = (id: string): string => `${detailPath(id)}/commands`;

let ids = 0;
const env = {
  newId: (): string => `51000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

function setup(options: { book?: boolean } = {}): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  const f = createPreviewFetch(fixtures, serveSamples(samples), {
    env,
    state,
    ...(options.book === false ? {} : { book }),
  });
  return { f, state };
}

async function stage(f: typeof fetch, name: string): Promise<WeeklyImportResult> {
  const answer = await send(f, 'ops.one', 'POST', IMPORT, { dropId: name });
  expect(answer.status, answer.text).toBe(201);
  return weeklyImportResult.parse(answer.json);
}

const detail = async (f: typeof fetch, who: string, id: string) =>
  weeklyFileDetail.parse((await send(f, who, 'GET', detailPath(id))).json);

/** The prior the module defines for a numbered row: the book's latest Locked mark on or before the report date. */
const markPrior = (investmentId: string, reportDate: string): string | null =>
  priorFor(reportDate, book.lockedMarks[investmentId] ?? [], [])?.value ?? null;

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('simulated weekly values intake (docs/04 M2) over the bundled samples and the book', () => {
  it('has a walled deal and three samples to work with', () => {
    expect(walled).toBeDefined();
    expect([...byName.keys()]).toEqual([
      'weekly-values-clean.csv',
      'weekly-values-update.csv',
      'weekly-values-defects.csv',
    ]);
    expect(sample('weekly-values-clean.csv').expectations.walled).toHaveLength(1);
    expect(sample('weekly-values-defects.csv').expectations.walled).toHaveLength(2);
  });

  it('lists the bundled samples as the weekly drop folder, for operations only', async () => {
    const { f } = setup();
    const ok = await send(f, 'ops.one', 'GET', DROPS);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-pb-simulated')).toBe('true');
    const list = intakeExportList.parse(ok.json);
    expect(list.items.map((i) => i.id)).toEqual([...byName.keys()]);
    expect(list.items.every((i) => i.name === i.id)).toBe(true);
    expect(list.items[0]?.receivedAt).toBe(
      `${sample('weekly-values-clean.csv').reportDate}T12:00:00Z`,
    );
    expect((await send(f, 'viewer.one', 'GET', DROPS)).status).toBe(403);
    expect((await send(f, 'deal.one', 'GET', DROPS)).status).toBe(403);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('stages the clean sample: every value equals its prior, the latest Locked mark on or before the report date', async () => {
    const { f, state } = setup();
    const clean = sample('weekly-values-clean.csv');
    const file = await stage(f, 'weekly-values-clean.csv');
    expect(file.duplicate).toBe(false);
    expect(file.source).toBe('weekly');
    expect(file.templateSignature).toBeNull();
    expect(file.fileName).toBe('weekly-values-clean.csv');
    expect(file.receivedBy).toBe(USERS.ops.displayName);
    expect(file.receivedAt).toBe(env.now());
    expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(file.rowCount).toBe(clean.expectations.rows);
    expect(file.counts).toEqual({
      new: 0,
      validated: clean.expectations.rows,
      flagged: 0,
      approved: 0,
      rejected: 0,
      promoted: 0,
    });
    expect(file.status).toBe('validated');
    expect(file.exceptions).toBe(0);
    expect(file.fileFindings).toEqual([]);
    // ops.one is outside the wall: the walled position's row is counted, never shown.
    expect(file.hiddenRows).toBe(clean.expectations.walled.length);
    expect(file.rows).toHaveLength(clean.expectations.rows - clean.expectations.walled.length);
    for (const row of file.rows) {
      expect(row.status, `row ${row.rowNo}`).toBe('validated');
      expect(row.link.status).toBe('matched');
      expect(row.reportDate).toBe(clean.reportDate);
      expect(row.priorSource).toBe('locked_mark');
      expect(row.priorValue).toBe(markPrior(row.link.investmentId ?? '', clean.reportDate));
      expect(D(row.reportedValue ?? '').eq(D(row.priorValue ?? '0'))).toBe(true);
      expect(D(row.variancePct ?? '1').isZero()).toBe(true);
      expect(row.flag).toBeNull();
      expect(row.findings.every((x) => x.severity === 'warning')).toBe(true);
      expect(row.valuationId).toBeNull();
    }
    // The alias row carries a name the company is also known by and no number: it still links.
    for (const rowNo of clean.expectations.aliased) {
      const row = file.rows.find((r) => r.rowNo === rowNo);
      expect(row?.investmentNumber).toBeNull();
      expect(row?.link.status).toBe('matched');
      expect(row?.link.investmentNumber).not.toBeNull();
      expect(row?.companyName).not.toBe(row?.link.companyName);
    }
    // The wall member sees the walled position's row; nothing in the outsider's answer names it.
    const member = await detail(f, 'deal.three', file.id);
    expect(member.hiddenRows).toBe(0);
    expect(member.rows).toHaveLength(clean.expectations.rows);
    const walledRow = member.rows.find((r) => r.link.investmentId === walledId);
    expect(walledRow?.rowNo).toBe(clean.expectations.walled[0]);
    expect(walledRow?.companyName).toBe(walled?.companyName);
    const outsider = await send(f, 'ops.one', 'GET', detailPath(file.id));
    expect(outsider.text).not.toContain(walled?.companyName ?? '');
    expect(outsider.text).not.toContain(walled?.investmentNumber ?? '');
    // The file reads the same for everyone: counts cover every row.
    expect(member.counts).toEqual(file.counts);
    // The generic list carries the file under its source; the weekly page filters by it.
    const page = intakeFilePage.parse(
      (await send(f, 'head.one', 'GET', `${FILES}&source=weekly`)).json,
    );
    expect(page.items.map((i) => [i.id, i.source])).toEqual([[file.id, 'weekly']]);
    expect(
      intakeFilePage.parse((await send(f, 'head.one', 'GET', `${FILES}&source=accounting`)).json)
        .items,
    ).toEqual([]);
    expect(state.audit.map((e) => e.action)).toEqual(['intake.import']);
    expect(state.audit[0]?.details).toEqual({ rowCount: file.rowCount, ...file.counts });
  });

  it('flags each defect row by the rule the generator names, passes the moved rows inside the threshold and counts the exceptions', async () => {
    const { f, state } = setup();
    const defects = sample('weekly-values-defects.csv');
    const staged = await stage(f, 'weekly-values-defects.csv');
    const full = await detail(f, 'deal.three', staged.id);
    expect(full.hiddenRows).toBe(0);
    expect(full.rows).toHaveLength(defects.expectations.rows);
    expect(defects.expectations.flagged.length).toBeGreaterThanOrEqual(8);
    for (const { rowNo, ruleId } of defects.expectations.flagged) {
      const row = full.rows.find((r) => r.rowNo === rowNo);
      expect(row?.status, `row ${rowNo} (${ruleId})`).toBe('flagged');
      expect(
        row?.findings.map((x) => x.ruleId),
        `row ${rowNo}`,
      ).toContain(ruleId);
      expect(row?.findings.find((x) => x.ruleId === ruleId)?.severity).toBe('error');
    }
    // The position moved beyond the threshold carries the flag the page shows as a badge.
    const bound = defects.expectations.flagged.find((x) => x.ruleId === 'WK-BOUND-01');
    const beyond = full.rows.find((r) => r.rowNo === bound?.rowNo);
    expect(beyond?.flag).toBe('above_threshold');
    expect(
      D(beyond?.variancePct ?? '0')
        .abs()
        .gte(threshold),
    ).toBe(true);
    // The three moved positions sit among the position rows (before the appended defects) and pass.
    const firstAppended = Math.min(
      ...defects.expectations.flagged.filter((x) => x.ruleId !== 'WK-BOUND-01').map((x) => x.rowNo),
    );
    expect(defects.expectations.moved).toHaveLength(3);
    for (const moved of defects.expectations.moved) {
      const row = full.rows.find(
        (r) => r.rowNo < firstAppended && r.investmentNumber === moved.investmentNumber,
      );
      expect(row?.status, moved.investmentNumber).toBe('validated');
      expect(row?.flag).toBeNull();
      expect(
        D(row?.variancePct ?? '0')
          .minus(moved.pct)
          .abs()
          .lt('0.000001'),
      ).toBe(true);
    }
    // One exception per unresolved link, with this intake's prefix, as the API opens them.
    const unmatched = full.rows.filter((r) => r.link.status === 'unmatched');
    expect(unmatched).toHaveLength(2);
    expect(staged.exceptions).toBe(unmatched.length);
    const opened = [...state.exceptions.values()];
    expect(opened).toHaveLength(unmatched.length);
    expect(new Set(opened.map((x) => x.source))).toEqual(new Set(['weekly_intake']));
    expect(new Set(opened.map((x) => x.entity))).toEqual(new Set(['stg.valuation']));
    expect(new Set(opened.map((x) => x.ruleId))).toEqual(new Set(['WK-XREF-01']));
    expect(new Set(opened.map((x) => x.severity))).toEqual(new Set(['exception_severity.high']));
    expect(new Set(opened.map((x) => x.entityId))).toEqual(new Set(unmatched.map((r) => r.id)));
    // The walled position's rows (its value and the after-as-of defect built from it) stay behind the wall.
    const outsider = await send(f, 'ops.one', 'GET', detailPath(staged.id));
    const ops = weeklyFileDetail.parse(outsider.json);
    expect(ops.hiddenRows).toBe(defects.expectations.walled.length);
    expect(outsider.text).not.toContain(walled?.companyName ?? '');
    expect(ops.counts).toEqual(full.counts);
    expect(staged.status).toBe('flagged');
    expect(
      full.rows
        .flatMap((r) => r.findings)
        .some((x) => x.message.includes(String.fromCharCode(0x2014))),
    ).toBe(false);
  });

  it('answers the same text again with the file staged before and duplicate true', async () => {
    const { f, state } = setup();
    const update = sample('weekly-values-update.csv');
    const uploaded = await send(f, 'ops.one', 'POST', IMPORT, {
      fileName: 'friday-values.csv',
      csv: update.csv,
    });
    expect(uploaded.status, uploaded.text).toBe(201);
    const first = weeklyImportResult.parse(uploaded.json);
    expect(first.fileName).toBe('friday-values.csv');
    expect(first.counts.flagged).toBe(0);
    const again = await stage(f, 'weekly-values-update.csv');
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
    expect(again.fileName).toBe('friday-values.csv');
    expect(state.weeklyFiles.size).toBe(1);
  });

  it('approve creates a Draft valuation per promoted value, on the board for whoever may see the position', async () => {
    const { f, state } = setup();
    const clean = sample('weekly-values-clean.csv');
    const bookBefore = JSON.stringify(book);
    const staged = await stage(f, 'weekly-values-clean.csv');
    const commands = commandsPath(staged.id);
    const approved = await send(f, 'ops.one', 'POST', commands, { command: 'approve' });
    expect(approved.status, approved.text).toBe(200);
    const after = weeklyFileDetail.parse(approved.json);
    const visibleRows = clean.expectations.rows - clean.expectations.walled.length;
    expect(after.counts.promoted).toBe(visibleRows);
    expect(after.counts.validated).toBe(clean.expectations.walled.length);
    expect(after.status).toBe('validated');
    expect(after.rowVersion).toBe(2);
    for (const row of after.rows) {
      expect(row.status).toBe('promoted');
      expect(row.decidedBy).toBe(USERS.ops.displayName);
      expect(row.decidedAt).toBe(env.now());
      expect(row.decision).toBe('weekly values weekly-values-clean.csv');
      expect(row.valuationId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // Each promoted value is a Draft of method weekly_report at the report date, prepared by the
    // reviewer, on the valuations board as the credential's recorded list overlaid.
    const board = valuationPage.parse((await send(f, 'ops.one', 'GET', VALUATIONS_PATH)).json);
    const draftIds = after.rows.map((r) => r.valuationId);
    expect([...board.items.map((v) => v.id)].sort()).toEqual([...draftIds].sort());
    expect(board.periods).toContain(book.asOf);
    for (const draft of board.items) {
      const row = after.rows.find((r) => r.valuationId === draft.id);
      expect(draft.state).toBe('Draft');
      expect(draft.method).toBe('valuation_method.weekly_report');
      expect(draft.periodEnd).toBe(clean.reportDate);
      expect(draft.quarterEnd).toBe(book.asOf);
      expect(draft.version).toBe(1);
      expect(draft.preparedBy).toBe(USERS.ops.displayName);
      expect(draft.investmentId).toBe(row?.link.investmentId);
      expect(D(draft.fairValue).eq(D(row?.reportedValue ?? '0'))).toBe(true);
    }
    // The standing rule: promotion changes the staged rows and the simulated records only.
    expect(JSON.stringify(book)).toBe(bookBefore);
    expect(state.audit.filter((e) => e.action === 'valuation.create_from_weekly')).toHaveLength(
      visibleRows,
    );
    // Nothing left for ops.one: the command answers the unchanged file.
    const again = weeklyFileDetail.parse(
      (await send(f, 'ops.one', 'POST', commands, { command: 'approve' })).json,
    );
    expect(again.counts).toEqual(after.counts);
    expect(again.rowVersion).toBe(2);
    // The wall member promotes the walled position's value; its Draft shows only inside the wall.
    const finished = weeklyFileDetail.parse(
      (await send(f, 'deal.three', 'POST', commands, { command: 'approve' })).json,
    );
    expect(finished.counts.promoted).toBe(clean.expectations.rows);
    expect(finished.status).toBe('promoted');
    const memberBoard = valuationPage.parse(
      (await send(f, 'deal.three', 'GET', VALUATIONS_PATH)).json,
    );
    expect(memberBoard.items).toHaveLength(clean.expectations.rows);
    expect(memberBoard.items.some((v) => v.investmentId === walledId)).toBe(true);
    const opsBoard = valuationPage.parse((await send(f, 'ops.one', 'GET', VALUATIONS_PATH)).json);
    expect(opsBoard.items).toHaveLength(visibleRows);
    expect(opsBoard.items.some((v) => v.investmentId === walledId)).toBe(false);
    // A promoted row cannot be approved again.
    const named = await send(f, 'deal.three', 'POST', commands, {
      command: 'approve',
      rowIds: [finished.rows[0]?.id ?? ''],
    });
    expect(named.status).toBe(400);
    expect(problemDetails.parse(named.json).errors?.map((e) => e.path)).toEqual(['rowIds']);
  });

  it('takes a weekly value promoted earlier as the prior of the next file', async () => {
    const { f } = setup();
    const clean = sample('weekly-values-clean.csv');
    const update = sample('weekly-values-update.csv');
    const first = await stage(f, 'weekly-values-clean.csv');
    const promoted = weeklyFileDetail.parse(
      (await send(f, 'ops.one', 'POST', commandsPath(first.id), { command: 'approve' })).json,
    );
    const second = await stage(f, 'weekly-values-update.csv');
    expect(second.counts.flagged).toBe(0);
    // The promoted value stands as the prior unless a Locked mark is dated on or after it (the
    // position whose sponsor closes its books a few days early has a mark on the report date
    // itself), which is priorFor's rule in the API's weekly service.
    for (const row of second.rows) {
      const earlier = promoted.rows.find((r) => r.link.investmentId === row.link.investmentId);
      const expected = priorFor(
        clean.reportDate,
        book.lockedMarks[row.link.investmentId ?? ''] ?? [],
        [{ reportDate: clean.reportDate, reportedValue: earlier?.reportedValue ?? '' }],
      );
      expect(row.priorSource, `row ${row.rowNo}`).toBe(expected?.source);
      expect(row.priorDate).toBe(expected?.date);
      expect(row.priorValue).toBe(expected?.value);
    }
    expect(second.rows.filter((r) => r.priorSource === 'weekly').length).toBeGreaterThan(
      second.rows.length / 2,
    );
    for (const moved of update.expectations.moved) {
      const row = second.rows.find((r) => r.investmentNumber === moved.investmentNumber);
      expect(row?.status).toBe('validated');
      expect(
        D(row?.variancePct ?? '0')
          .minus(moved.pct)
          .abs()
          .lt('0.000001'),
      ).toBe(true);
    }
    // The walled position's value was not promoted by ops.one, so its prior is still the mark.
    const member = await detail(f, 'deal.three', second.id);
    const walledRow = member.rows.find((r) => r.link.investmentId === walledId);
    expect(walledRow?.priorSource).toBe('locked_mark');
  });

  it('rejects flagged rows with a reason the table requires, operations only; the walled defect stays flagged', async () => {
    const { f } = setup();
    const defects = sample('weekly-values-defects.csv');
    const staged = await stage(f, 'weekly-values-defects.csv');
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
    const before = await detail(f, 'ops.one', staged.id);
    const visibleFlagged = before.rows.filter((r) => r.status === 'flagged').length;
    expect(visibleFlagged).toBeGreaterThan(0);
    const reason = 'Values sent back to the sponsor';
    const rejected = weeklyFileDetail.parse(
      (await send(f, 'ops.one', 'POST', commands, { command: 'reject', reason })).json,
    );
    expect(rejected.counts.rejected).toBe(visibleFlagged);
    // The after-as-of defect is built from the walled position: past ops.one's wall, it stays flagged.
    expect(rejected.counts.flagged).toBe(1);
    expect(rejected.status).toBe('flagged');
    for (const row of rejected.rows.filter((r) => r.status === 'rejected')) {
      expect(row.decision).toBe(reason);
      expect(row.decidedBy).toBe(USERS.ops.displayName);
      expect(row.decidedAt).toBe(env.now());
      expect(row.valuationId).toBeNull();
    }
    const member = await detail(f, 'deal.three', staged.id);
    const walledFlagged = member.rows.find(
      (r) => r.link.investmentId === walledId && r.status === 'flagged',
    );
    expect(walledFlagged?.rowNo).toBe(defects.expectations.walled[1]);
    expect(walledFlagged?.findings.map((x) => x.ruleId)).toContain('WK-PERIOD-01');
    // A flagged row cannot be approved, named or not; the wall member promotes the validated one.
    const wrongState = await send(f, 'deal.three', 'POST', commands, {
      command: 'approve',
      rowIds: [walledFlagged?.id ?? ''],
    });
    expect(wrongState.status).toBe(400);
    const finished = weeklyFileDetail.parse(
      (await send(f, 'deal.three', 'POST', commands, { command: 'approve' })).json,
    );
    expect(finished.counts.validated).toBe(0);
    expect(finished.counts.flagged).toBe(1);
  });

  it('refuses a viewer on the list and the import, lets reviewers read, and answers 404 for unknown files and drops', async () => {
    const { f } = setup();
    const staged = await stage(f, 'weekly-values-clean.csv');
    expect((await send(f, 'viewer.one', 'GET', detailPath(staged.id))).status).toBe(403);
    expect(
      (await send(f, 'viewer.one', 'POST', IMPORT, { dropId: 'weekly-values-clean.csv' })).status,
    ).toBe(403);
    expect(
      (await send(f, 'deal.one', 'POST', IMPORT, { dropId: 'weekly-values-clean.csv' })).status,
    ).toBe(403);
    for (const who of ['deal.one', 'head.one', 'all.roles'])
      expect((await send(f, who, 'GET', detailPath(staged.id))).status, who).toBe(200);
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
    // A weekly file is not an accounting file: the accounting detail route does not know it.
    expect((await send(f, 'ops.one', 'GET', `/api/v1/intake/files/${staged.id}`)).status).toBe(404);
    const missing = await send(f, 'ops.one', 'POST', IMPORT, { dropId: 'weekly-values-other.csv' });
    expect(missing.status).toBe(404);
    expect(problemOf(missing).detail).toBe('Drop file not found');
    const malformed = await send(f, 'ops.one', 'POST', IMPORT, { fileName: 'x.csv' });
    expect(malformed.status).toBe(400);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('refuses a file the weekly layout does not know and a file over the byte limit, staging nothing', async () => {
    const { f } = setup();
    const header = parseCsv(sample('weekly-values-clean.csv').csv).header;
    const renamed = toCsv(
      header.map((h) => (h === 'ReportedValue' ? 'Value' : h)),
      [['INV-0001', 'Example Co', book.asOf, '1']],
    );
    const refused = await send(f, 'ops.one', 'POST', IMPORT, {
      fileName: 'renamed.csv',
      csv: renamed,
    });
    expect(refused.status).toBe(201);
    const file = weeklyImportResult.parse(refused.json);
    expect(file.rowCount).toBe(0);
    expect(file.status).toBe('new');
    expect(file.rows).toEqual([]);
    expect(file.fileFindings.map((x) => x.ruleId)).toEqual(
      expect.arrayContaining(['LAYOUT-01', 'LAYOUT-02']),
    );
    expect(file.exceptions).toBe(0);
    // A refused file is read again when the same text comes back: refused again, it answers duplicate.
    const again = weeklyImportResult.parse(
      (await send(f, 'ops.one', 'POST', IMPORT, { fileName: 'renamed.csv', csv: renamed })).json,
    );
    expect(again.id).toBe(file.id);
    expect(again.duplicate).toBe(true);
    const huge = await send(f, 'ops.one', 'POST', IMPORT, {
      fileName: 'huge.csv',
      csv: 'é'.repeat(1_500_000),
    });
    expect(huge.status).toBe(400);
    expect(problemOf(huge).detail).toBe('The file is larger than one import accepts');
  });

  it('forgets every weekly file, Draft and exception on reset', async () => {
    const { f, state } = setup();
    const staged = await stage(f, 'weekly-values-defects.csv');
    await send(f, 'ops.one', 'POST', commandsPath(staged.id), { command: 'approve' });
    expect(state.weeklyFiles.size).toBe(1);
    expect(state.exceptions.size).toBeGreaterThan(0);
    const reset = await send(f, 'viewer.one', 'POST', '/api/v1/preview/reset');
    expect(reset.status).toBe(200);
    expect(state.weeklyFiles.size).toBe(0);
    expect(state.exceptions.size).toBe(0);
    expect(intakeFilePage.parse((await send(f, 'ops.one', 'GET', FILES)).json).items).toEqual([]);
    expect(
      valuationPage.parse((await send(f, 'ops.one', 'GET', VALUATIONS_PATH)).json).items,
    ).toEqual([]);
    expect((await send(f, 'ops.one', 'GET', detailPath(staged.id))).status).toBe(404);
    expect((await stage(f, 'weekly-values-defects.csv')).duplicate).toBe(false);
  });

  it('says so when a world carries no book', async () => {
    const { f } = setup({ book: false });
    const answer = await send(f, 'ops.one', 'GET', DROPS);
    expect(answer.status).toBe(503);
    expect(problemOf(answer).code).toBe('unavailable');
    expect(
      (await send(f, 'ops.one', 'POST', IMPORT, { dropId: 'weekly-values-clean.csv' })).status,
    ).toBe(503);
  });

  it('every answer parses through the contract schemas', async () => {
    const { f } = setup();
    const staged = await stage(f, 'weekly-values-update.csv');
    const rows: WeeklyRow[] = (await detail(f, 'deal.three', staged.id)).rows;
    expect(rows.length).toBe(staged.rowCount);
  });
});
