import { beforeEach, describe, expect, it } from 'vitest';
import {
  intakeExportList,
  intakeFileDetail,
  intakeFilePage,
  intakeImportResult,
  problemDetails,
} from '@pb/contracts';
import type { IntakeImportResult, IntakeRow } from '@pb/contracts';
import {
  OPS_DROP_TEMPLATE,
  accountingExports,
  generateDataset,
  previewBook,
  previewOpsDropWorkbooks,
} from '@pb/synthetic';
import type { OpsDropWorkbook } from '@pb/synthetic';
import definitions from '../../../../../config/definitions.json';
import { base64Of } from '../../pages/intake/intake.js';
import { parseBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { USERS, generatedWorld, problemOf, send, serveSamples } from '../test-fixtures.js';

/**
 * The simulated operations workbook drop over the real generator: the small synthetic profile
 * (seed 42) gives the book and the four bundled workbooks (the accounting export's scenarios as
 * .xlsx, plus one under a header no template knows), read in the test with the same
 * DecompressionStream inflater the browser uses.
 */
const dataset = generateDataset({ profile: 'small', seed: 42 });
const book = parseBook(JSON.parse(JSON.stringify(previewBook(dataset))));
const walledId = dataset.scenarios.walled_deal?.[0] ?? '';
const fixtures = generatedWorld(book, walledId);
const workbooks = previewOpsDropWorkbooks(dataset);
const samples = new Map<string, string | Uint8Array>();
const byName = new Map<string, OpsDropWorkbook>();
for (const [i, workbook] of workbooks.entries()) {
  const name = book.opsDropSamples[i]?.fileName ?? '';
  samples.set(name, workbook.bytes);
  byName.set(name, workbook);
}
for (const [i, sample] of accountingExports(dataset).entries())
  samples.set(book.samples[i]?.fileName ?? '', sample.csv);
const workbook = (name: string): OpsDropWorkbook => {
  const found = byName.get(name);
  if (found === undefined) throw new Error(`no workbook ${name}`);
  return found;
};

const DROPS = '/api/v1/intake/ops-drop/drops';
const IMPORT = '/api/v1/intake/ops-drop';
const FILES = '/api/v1/intake/files?limit=200';
const detailPath = (id: string): string => `/api/v1/intake/files/${id}`;
const commandsPath = (id: string): string => `${detailPath(id)}/commands`;

let ids = 0;
const env = {
  newId: (): string => `53000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
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

async function stage(f: typeof fetch, dropId: string): Promise<IntakeImportResult> {
  const answer = await send(f, 'ops.one', 'POST', IMPORT, { dropId });
  expect(answer.status, answer.text).toBe(201);
  expect(answer.headers.get('x-pb-simulated')).toBe('true');
  return intakeImportResult.parse(answer.json);
}

/** What a staged row holds apart from its ids: the same for a workbook and the export it was written from. */
const essence = (r: IntakeRow) => ({
  rowNo: r.rowNo,
  naturalKey: r.naturalKey,
  investmentNumber: r.investmentNumber,
  companyName: r.companyName,
  periodEnd: r.periodEnd,
  figures: r.figures,
  link: r.link,
  diff: r.diff,
  findings: r.findings,
  status: r.status,
  targetId: r.targetId,
});

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('simulated ops drop (docs/04 M2) over the bundled workbooks and the book', () => {
  it('has four workbooks to work with, one of them under an unknown header', () => {
    expect([...byName.keys()]).toEqual([
      'ops-drop-clean.xlsx',
      'ops-drop-update.xlsx',
      'ops-drop-defects.xlsx',
      'ops-drop-unknown-template.xlsx',
    ]);
    expect(workbook('ops-drop-unknown-template.xlsx').expectations.refused).toBe(true);
    expect(workbook('ops-drop-clean.xlsx').template).toBe(OPS_DROP_TEMPLATE);
  });

  it('lists the bundled workbooks as the ops drop folder, for operations only', async () => {
    const { f } = setup();
    const ok = await send(f, 'ops.one', 'GET', DROPS);
    expect(ok.status).toBe(200);
    const list = intakeExportList.parse(ok.json);
    expect(list.items.map((i) => i.id)).toEqual([...byName.keys()]);
    expect(list.items.every((i) => i.name === i.id && i.receivedAt.startsWith(book.asOf))).toBe(
      true,
    );
    expect((await send(f, 'viewer.one', 'GET', DROPS)).status).toBe(403);
    expect((await send(f, 'deal.one', 'GET', DROPS)).status).toBe(403);
  });

  it('stages the clean workbook through the accounting staging, matched to its template, with the same rows as the export', async () => {
    const { f, state } = setup();
    const clean = workbook('ops-drop-clean.xlsx');
    const file = await stage(f, 'ops-drop-clean.xlsx');
    expect(file.duplicate).toBe(false);
    expect(file.source).toBe('ops_drop');
    expect(file.templateSignature).toBe(OPS_DROP_TEMPLATE);
    expect(file.fileName).toBe('ops-drop-clean.xlsx');
    expect(file.receivedBy).toBe(USERS.ops.displayName);
    expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(file.rowCount).toBe(clean.expectations.rows);
    expect(file.status).toBe('validated');
    expect(file.counts.validated).toBe(clean.expectations.rows);
    expect(file.exceptions).toBe(0);
    expect(file.fileFindings).toEqual([]);
    expect(file.hiddenRows).toBe(1);
    // The same rows the accounting export stages: the workbook was written from it and the
    // template maps every header cell back onto the layout.
    const exported = intakeImportResult.parse(
      (
        await send(f, 'ops.one', 'POST', '/api/v1/intake/accounting', {
          exportId: 'accounting-clean.csv',
        })
      ).json,
    );
    expect(exported.source).toBe('accounting');
    expect(file.rows.map(essence)).toEqual(exported.rows.map(essence));
    expect(file.counts).toEqual(exported.counts);
    // The shared list carries both under their sources, newest first; the source filter picks one.
    const page = intakeFilePage.parse((await send(f, 'head.one', 'GET', FILES)).json);
    expect(page.items.map((i) => [i.id, i.source])).toEqual([
      [exported.id, 'accounting'],
      [file.id, 'ops_drop'],
    ]);
    expect(
      intakeFilePage
        .parse((await send(f, 'head.one', 'GET', `${FILES}&source=ops_drop`)).json)
        .items.map((i) => i.id),
    ).toEqual([file.id]);
    // The wall member sees the walled position's row and approves; the reason names the ops drop.
    const member = intakeFileDetail.parse(
      (await send(f, 'deal.three', 'GET', detailPath(file.id))).json,
    );
    expect(member.hiddenRows).toBe(0);
    expect(member.templateSignature).toBe(OPS_DROP_TEMPLATE);
    const approved = intakeFileDetail.parse(
      (await send(f, 'ops.one', 'POST', commandsPath(file.id), { command: 'approve' })).json,
    );
    expect(approved.counts.promoted).toBe(clean.expectations.rows - 1);
    expect(approved.rows[0]?.decision).toBe('ops drop import ops-drop-clean.xlsx');
    expect(state.audit.filter((e) => e.action === 'intake.import')).toHaveLength(2);
  });

  it('answers the same bytes uploaded as base64 with the file staged before and duplicate true', async () => {
    const { f, state } = setup();
    const clean = workbook('ops-drop-clean.xlsx');
    const uploaded = await send(f, 'ops.one', 'POST', IMPORT, {
      fileName: 'figures-q2.xlsx',
      workbookBase64: base64Of(clean.bytes),
    });
    expect(uploaded.status, uploaded.text).toBe(201);
    const first = intakeImportResult.parse(uploaded.json);
    expect(first.fileName).toBe('figures-q2.xlsx');
    expect(first.templateSignature).toBe(OPS_DROP_TEMPLATE);
    expect(first.rowCount).toBe(clean.expectations.rows);
    const again = await stage(f, 'ops-drop-clean.xlsx');
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
    expect(again.fileName).toBe('figures-q2.xlsx');
    expect(state.intakeFiles.size).toBe(1);
  });

  it('refuses a workbook that matches no template with the LAYOUT-05 finding naming the templates, staging nothing, and reads it again when it comes back', async () => {
    const { f, state } = setup();
    const unknown = workbook('ops-drop-unknown-template.xlsx');
    expect(unknown.template).toBeNull();
    const file = await stage(f, 'ops-drop-unknown-template.xlsx');
    expect(file.duplicate).toBe(false);
    expect(file.rowCount).toBe(0);
    expect(file.rows).toEqual([]);
    expect(file.status).toBe('new');
    expect(file.templateSignature).toBeNull();
    expect(file.exceptions).toBe(0);
    expect(file.fileFindings).toHaveLength(1);
    const finding = file.fileFindings[0];
    expect(finding?.ruleId).toBe('LAYOUT-05');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toBe('No template matches this workbook');
    expect(finding?.expected).toBe(OPS_DROP_TEMPLATE);
    expect(finding?.actual).toContain('sheets: Figures, Notes');
    expect(finding?.actual).toMatch(/header hash: [0-9a-f]{64} \(Figures\)/);
    // Never a cell: the header the workbook carries is not quoted.
    expect(finding?.actual).not.toContain('Revenue (LTM)');
    expect(state.exceptions.size).toBe(0);
    // Listed and readable, like a CSV the layout refused; the same bytes are read again and refused again.
    const page = intakeFilePage.parse(
      (await send(f, 'head.one', 'GET', `${FILES}&status=new`)).json,
    );
    expect(page.items.map((i) => [i.id, i.source, i.templateSignature])).toEqual([
      [file.id, 'ops_drop', null],
    ]);
    const again = await stage(f, 'ops-drop-unknown-template.xlsx');
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(file.id);
    expect(again.rowCount).toBe(0);
    expect(state.intakeFiles.size).toBe(1);
  });

  it('flags each defect row of the defects workbook by the rule the generator names and counts the exceptions', async () => {
    const { f, state } = setup();
    const defects = workbook('ops-drop-defects.xlsx');
    const staged = await stage(f, 'ops-drop-defects.xlsx');
    expect(staged.status).toBe('flagged');
    const full = intakeFileDetail.parse(
      (await send(f, 'deal.three', 'GET', detailPath(staged.id))).json,
    );
    expect(full.rows).toHaveLength(defects.expectations.rows);
    for (const { rowNo, ruleId } of defects.expectations.flagged) {
      const row = full.rows.find((r) => r.rowNo === rowNo);
      expect(row?.status, `row ${rowNo} (${ruleId})`).toBe('flagged');
      expect(
        row?.findings.map((x) => x.ruleId),
        `row ${rowNo}`,
      ).toContain(ruleId);
    }
    const unresolved = full.rows.filter((r) => r.link.status !== 'matched').length;
    const ties = full.rows.flatMap((r) => r.findings.filter((x) => x.ruleId === 'TIE-01')).length;
    expect(staged.exceptions).toBe(unresolved + ties);
    const opened = [...state.exceptions.values()];
    expect(opened).toHaveLength(unresolved + ties);
    expect(new Set(opened.map((x) => x.source))).toEqual(new Set(['ops_drop_import']));
    expect(new Set(opened.map((x) => x.entity))).toEqual(new Set(['stg.intake_row']));
    expect(opened.every((x) => x.context.intakeFileName === 'ops-drop-defects.xlsx')).toBe(true);
  });

  it('refuses what the parser refuses and an upload past the limits, as the API does', async () => {
    const { f, state } = setup();
    const notZip = await send(f, 'ops.one', 'POST', IMPORT, {
      fileName: 'notes.xlsx',
      workbookBase64: base64Of(new TextEncoder().encode('hello, not a workbook')),
    });
    expect(notZip.status).toBe(422);
    expect(problemOf(notZip).code).toBe('workbook-refused');
    const notBase64 = await send(f, 'ops.one', 'POST', IMPORT, {
      fileName: 'notes.xlsx',
      workbookBase64: 'not base64 at all!!',
    });
    expect(notBase64.status).toBe(422);
    const tooLong = await send(f, 'ops.one', 'POST', IMPORT, {
      fileName: 'huge.xlsx',
      workbookBase64: 'A'.repeat(definitions.intake.maxWorkbookBase64Chars + 4),
    });
    expect(tooLong.status).toBe(400);
    expect(problemDetails.parse(tooLong.json).errors?.map((e) => e.path)).toEqual([
      'workbookBase64',
    ]);
    expect(state.intakeFiles.size).toBe(0);
    const malformed = await send(f, 'ops.one', 'POST', IMPORT, { fileName: 'x.xlsx' });
    expect(malformed.status).toBe(400);
  });

  it('refuses a viewer and the deal team where the API does, and answers 404 for an unknown drop', async () => {
    const { f } = setup();
    expect(
      (await send(f, 'viewer.one', 'POST', IMPORT, { dropId: 'ops-drop-clean.xlsx' })).status,
    ).toBe(403);
    expect(
      (await send(f, 'deal.one', 'POST', IMPORT, { dropId: 'ops-drop-clean.xlsx' })).status,
    ).toBe(403);
    const missing = await send(f, 'ops.one', 'POST', IMPORT, { dropId: 'ops-drop-other.xlsx' });
    expect(missing.status).toBe(404);
    expect(problemOf(missing).detail).toBe('Workbook not found');
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('forgets every staged workbook on reset, and says so when a world carries no book', async () => {
    const { f, state } = setup();
    await stage(f, 'ops-drop-update.xlsx');
    expect((await send(f, 'viewer.one', 'POST', '/api/v1/preview/reset')).status).toBe(200);
    expect(state.intakeFiles.size).toBe(0);
    expect((await stage(f, 'ops-drop-update.xlsx')).duplicate).toBe(false);
    const bookless = setup({ book: false });
    expect((await send(bookless.f, 'ops.one', 'GET', DROPS)).status).toBe(503);
    expect(
      (await send(bookless.f, 'ops.one', 'POST', IMPORT, { dropId: 'ops-drop-clean.xlsx' })).status,
    ).toBe(503);
  });
});
