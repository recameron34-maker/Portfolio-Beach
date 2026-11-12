import { beforeEach, describe, expect, it } from 'vitest';
import { D } from '@pb/calc';
import {
  intakeFilePage,
  lookthroughReconcileResult,
  lookthroughRunDetail,
  problemDetails,
} from '@pb/contracts';
import type { LookthroughReconcileResult } from '@pb/contracts';
import { generateDataset, previewBook, previewLookthroughExtracts } from '@pb/synthetic';
import type { LookthroughExtract } from '@pb/synthetic';
import { parseBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { generatedWorld, problemOf, send, serveSamples } from '../test-fixtures.js';
import { recordAt } from './lookthrough.js';

/**
 * The simulated look-through reconcile over the real generator: the small synthetic profile
 * (seed 42) gives the book and the two bundled extracts (the defects extract for the as-of date,
 * the clean one for the quarter end before it), so every expectation here comes from
 * tools/synthetic rather than a hand count.
 */
const dataset = generateDataset({ profile: 'small', seed: 42 });
const book = parseBook(JSON.parse(JSON.stringify(previewBook(dataset))));
const walledId = dataset.scenarios.walled_deal?.[0] ?? '';
const walled = book.investments.find((i) => i.id === walledId);
const fixtures = generatedWorld(book, walledId);
const extracts = previewLookthroughExtracts(dataset);
const samples = new Map<string, string | Uint8Array>();
for (const [i, extract] of extracts.entries())
  samples.set(book.lookthroughSamples[i]?.fileName ?? '', extract.json);
const extractFor = (scenario: 'clean' | 'defects'): LookthroughExtract => {
  const index = book.lookthroughSamples.findIndex((s) => s.scenario === scenario);
  const found = extracts[index];
  if (found === undefined) throw new Error(`no ${scenario} extract`);
  return found;
};

const RECONCILE = '/api/v1/intake/lookthrough/reconcile';
const FILES = '/api/v1/intake/files?limit=200';
const runPath = (id: string): string => `/api/v1/intake/lookthrough/runs/${id}`;

let ids = 0;
const env = {
  newId: (): string => `52000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
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

async function reconcile(f: typeof fetch, asOf: string): Promise<LookthroughReconcileResult> {
  const answer = await send(f, 'ops.one', 'POST', RECONCILE, { asOf });
  expect(answer.status, answer.text).toBe(201);
  expect(answer.headers.get('x-pb-simulated')).toBe('true');
  return lookthroughReconcileResult.parse(answer.json);
}

const run = async (f: typeof fetch, who: string, id: string) =>
  lookthroughRunDetail.parse((await send(f, who, 'GET', runPath(id))).json);

/** The differences the contract carries: a stale as-of is a finding, not a field the record compares. */
const contractDifferences = (extract: LookthroughExtract) =>
  extract.expectations.differences.filter((d) => d.field !== 'asOf');

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('simulated look-through reconcile (docs/04 M2) over the bundled extracts and the book', () => {
  it('has a walled deal and two extracts, one per as-of date, to work with', () => {
    expect(walled).toBeDefined();
    expect(book.lookthroughSamples.map((s) => [s.scenario, s.asOf])).toEqual([
      ['clean', '2025-03-31'],
      ['defects', book.asOf],
    ]);
    expect(extractFor('defects').expectations.walled).toHaveLength(2);
    expect(contractDifferences(extractFor('defects'))).toHaveLength(3);
  });

  it('reconciles the defects extract for the as-of date: links, maps and compares every row, opening an exception per difference, unmapped label and unresolved link', async () => {
    const { f, state } = setup();
    const defects = extractFor('defects');
    const result = await reconcile(f, book.asOf);
    expect(result.duplicate).toBe(false);
    expect(result.source).toBe('lookthrough');
    expect(result.fileName).toBe(`lookthrough-${book.asOf}.json`);
    expect(result.asOf).toBe(book.asOf);
    expect(result.rowCount).toBe(defects.expectations.rows);
    expect(result.status).toBe('flagged');
    expect(result.fileFindings).toEqual([]);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.templateSignature).toBeNull();
    const full = await run(f, 'deal.three', result.id);
    expect(full.hiddenRows).toBe(0);
    expect(full.rows).toHaveLength(defects.expectations.rows);
    // Every difference the generator planted is reported on its row, by field, and nothing else is.
    const expected = contractDifferences(defects);
    for (const { rowNo, field } of expected) {
      const row = full.rows.find((r) => r.rowNo === rowNo);
      expect(row?.status, `row ${rowNo} (${field})`).toBe('flagged');
      expect(row?.differences.map((d) => d.field)).toContain(field);
    }
    expect(full.rows.reduce((n, r) => n + r.differences.length, 0)).toBe(expected.length);
    for (const rowNo of defects.expectations.unmatched) {
      const row = full.rows.find((r) => r.rowNo === rowNo);
      expect(row?.link.status).toBe('unmatched');
      expect(row?.status).toBe('flagged');
      expect(row?.findings.map((x) => x.ruleId)).toContain('LT-XREF-01');
      expect(row?.approved).toEqual({ exposureAtCost: null, exposureAtNav: null });
    }
    for (const rowNo of defects.expectations.unmapped) {
      const row = full.rows.find((r) => r.rowNo === rowNo);
      expect(row?.mapped.sector).toBeNull();
      expect(row?.findings.map((x) => x.ruleId)).toContain('LT-MAP-01');
    }
    for (const rowNo of defects.expectations.duplicates)
      expect(full.rows.find((r) => r.rowNo === rowNo)?.findings.map((x) => x.ruleId)).toContain(
        'LT-DUP-01',
      );
    const stale = defects.expectations.differences.find((d) => d.field === 'asOf');
    const staleRow = full.rows.find((r) => r.rowNo === stale?.rowNo);
    expect(staleRow?.findings.map((x) => x.ruleId)).toContain('LT-STALE-01');
    expect((staleRow?.asOf ?? full.asOf) < full.asOf).toBe(true);
    // The moved rows sit inside the tolerance and pass; the alias row links by name with no number.
    for (const { rowNo } of defects.expectations.moved) {
      const row = full.rows.find((r) => r.rowNo === rowNo);
      expect(row?.status, `row ${rowNo}`).toBe('validated');
      expect(row?.differences).toEqual([]);
    }
    for (const rowNo of defects.expectations.aliased) {
      const row = full.rows.find((r) => r.rowNo === rowNo);
      expect(row?.investmentNumber).toBeNull();
      expect(row?.link.status).toBe('matched');
    }
    // A linked row carries the record it was compared with: the book's NAV and invested cost.
    const agreeing = full.rows.find(
      (r) => r.link.status === 'matched' && r.differences.length === 0 && r.status === 'validated',
    );
    const record = recordAt(book, agreeing?.link.investmentId ?? '', book.asOf);
    expect(agreeing?.approved).toEqual({
      exposureAtCost: record?.exposureAtCost ?? null,
      exposureAtNav: record?.exposureAtNav ?? null,
    });
    expect(
      D(agreeing?.approved.exposureAtNav ?? '0').eq(D(agreeing?.provider.exposureAtNav ?? '1')),
    ).toBe(true);
    expect(agreeing?.approved.exposureAtCost).toBe(
      book.investedCost[book.asOf]?.[agreeing?.link.investmentId ?? ''],
    );
    // One exception per unresolved link, per unmapped label and per difference, with their tiers.
    const wanted =
      defects.expectations.unmatched.length +
      defects.expectations.unmapped.length +
      expected.length;
    expect(result.exceptions).toBe(wanted);
    expect(full.rows.reduce((n, r) => n + r.exceptions, 0)).toBe(wanted);
    const opened = [...state.exceptions.values()];
    expect(opened).toHaveLength(wanted);
    expect(new Set(opened.map((x) => x.source))).toEqual(new Set(['lookthrough_reconcile']));
    expect(new Set(opened.map((x) => x.entity))).toEqual(new Set(['stg.intake_row']));
    const tier = (ruleId: string): Set<string> =>
      new Set(opened.filter((x) => x.ruleId === ruleId).map((x) => x.severity));
    expect(tier('LT-XREF-01')).toEqual(new Set(['exception_severity.high']));
    expect(tier('LT-TIE-01')).toEqual(new Set(['exception_severity.high']));
    expect(tier('LT-TIE-02')).toEqual(new Set(['exception_severity.high']));
    expect(tier('LT-MAP-01')).toEqual(new Set(['exception_severity.medium']));
    expect(tier('LT-DIFF-01')).toEqual(new Set(['exception_severity.medium']));
    expect(opened.every((x) => x.context.intakeFileId === result.id)).toBe(true);
    // The walled position's rows (its own and the stale copy) stay behind the wall for ops.one.
    const outsider = await send(f, 'ops.one', 'GET', runPath(result.id));
    const ops = lookthroughRunDetail.parse(outsider.json);
    expect(ops.hiddenRows).toBe(defects.expectations.walled.length);
    expect(outsider.text).not.toContain(walled?.companyName ?? '');
    expect(outsider.text).not.toContain(walled?.investmentNumber ?? '');
    expect(ops.counts).toEqual(full.counts);
    expect(ops.exceptions).toBe(wanted);
    // The run is an intake file of source lookthrough on the shared list.
    const page = intakeFilePage.parse(
      (await send(f, 'head.one', 'GET', `${FILES}&source=lookthrough`)).json,
    );
    expect(page.items.map((i) => [i.id, i.source, i.status])).toEqual([
      [result.id, 'lookthrough', 'flagged'],
    ]);
    expect(state.audit.map((e) => e.action)).toEqual(['intake.reconcile']);
    expect(state.audit[0]?.details?.differences).toBe(expected.length);
    expect(state.audit[0]?.details?.exceptions).toBe(wanted);
  });

  it('reconciles the clean extract for the quarter end before: every row agrees and nothing is opened', async () => {
    const { f, state } = setup();
    const clean = extractFor('clean');
    const result = await reconcile(f, clean.asOf);
    expect(result.asOf).toBe('2025-03-31');
    expect(result.rowCount).toBe(clean.expectations.rows);
    expect(result.status).toBe('validated');
    expect(result.exceptions).toBe(0);
    expect(result.hiddenRows).toBe(clean.expectations.walled.length);
    expect(state.exceptions.size).toBe(0);
    const full = await run(f, 'deal.three', result.id);
    expect(full.rows).toHaveLength(clean.expectations.rows);
    for (const row of full.rows) {
      expect(row.status, `row ${row.rowNo}`).toBe('validated');
      expect(row.differences).toEqual([]);
      expect(row.link.status).toBe('matched');
      expect(row.mapped.sector).not.toBeNull();
      expect(row.mapped.geography).not.toBeNull();
      expect(row.exceptions).toBe(0);
      expect(D(row.approved.exposureAtNav ?? '0').eq(D(row.provider.exposureAtNav))).toBe(true);
      expect(D(row.approved.exposureAtCost ?? '0').eq(D(row.provider.exposureAtCost))).toBe(true);
    }
    expect(full.rows.some((r) => r.link.investmentId === walledId)).toBe(true);
  });

  it('answers the same extract again with the run made before and duplicate true', async () => {
    const { f, state } = setup();
    const first = await reconcile(f, book.asOf);
    const again = await reconcile(f, book.asOf);
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
    expect(again.exceptions).toBe(first.exceptions);
    expect(state.lookthroughRuns.size).toBe(1);
    expect(state.exceptions.size).toBe(first.exceptions);
  });

  it('stages a run with no rows and a file finding for a date the folder holds nothing for, and refuses a date after today', async () => {
    const { f } = setup();
    const empty = await reconcile(f, '2024-12-31');
    expect(empty.rowCount).toBe(0);
    expect(empty.rows).toEqual([]);
    expect(empty.status).toBe('new');
    expect(empty.exceptions).toBe(0);
    expect(empty.fileFindings.map((x) => [x.ruleId, x.severity, x.expected])).toEqual([
      ['LT-FILE-01', 'error', '2024-12-31.json'],
    ]);
    expect((await reconcile(f, '2024-12-31')).duplicate).toBe(true);
    const future = await send(f, 'ops.one', 'POST', RECONCILE, { asOf: '2025-07-01' });
    expect(future.status).toBe(400);
    expect(problemDetails.parse(future.json).errors?.map((e) => e.path)).toEqual(['asOf']);
    expect((await send(f, 'ops.one', 'POST', RECONCILE, { asOf: '2025-13-01' })).status).toBe(400);
    expect(
      (await send(f, 'ops.one', 'POST', RECONCILE, { asOf: book.asOf, extra: 1 })).status,
    ).toBe(400);
  });

  it('refuses a viewer and the deal team where the API does, lets reviewers read, and answers 404 for an unknown run', async () => {
    const { f } = setup();
    const result = await reconcile(f, book.asOf);
    expect((await send(f, 'viewer.one', 'POST', RECONCILE, { asOf: book.asOf })).status).toBe(403);
    expect((await send(f, 'deal.one', 'POST', RECONCILE, { asOf: book.asOf })).status).toBe(403);
    expect((await send(f, 'viewer.one', 'GET', runPath(result.id))).status).toBe(403);
    for (const who of ['deal.one', 'head.one', 'all.roles'])
      expect((await send(f, who, 'GET', runPath(result.id))).status, who).toBe(200);
    for (const id of ['not-a-uuid', '00000000-0000-4000-8000-00000000abcd'])
      expect((await send(f, 'ops.one', 'GET', runPath(id))).status, id).toBe(404);
    // A run is not an accounting file: the accounting detail route does not know it.
    expect((await send(f, 'ops.one', 'GET', `/api/v1/intake/files/${result.id}`)).status).toBe(404);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('forgets every run and its exceptions on reset', async () => {
    const { f, state } = setup();
    const result = await reconcile(f, book.asOf);
    expect(state.lookthroughRuns.size).toBe(1);
    expect((await send(f, 'viewer.one', 'POST', '/api/v1/preview/reset')).status).toBe(200);
    expect(state.lookthroughRuns.size).toBe(0);
    expect(state.exceptions.size).toBe(0);
    expect((await send(f, 'ops.one', 'GET', runPath(result.id))).status).toBe(404);
    expect(intakeFilePage.parse((await send(f, 'ops.one', 'GET', FILES)).json).items).toEqual([]);
    expect((await reconcile(f, book.asOf)).duplicate).toBe(false);
  });

  it('says so when a world carries no book', async () => {
    const { f } = setup({ book: false });
    const answer = await send(f, 'ops.one', 'POST', RECONCILE, { asOf: book.asOf });
    expect(answer.status).toBe(503);
    expect(problemOf(answer).code).toBe('unavailable');
  });
});
