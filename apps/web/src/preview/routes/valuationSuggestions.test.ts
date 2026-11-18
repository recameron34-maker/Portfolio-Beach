import { beforeEach, describe, expect, it } from 'vitest';
import {
  D,
  addDays,
  alignedQuarterEnd,
  impliedStakeMark,
  latestQuarterEndOnOrBefore,
  toDecimalString,
  valueChange,
} from '@pb/calc';
import {
  documentPage,
  extractionBatch,
  extractionRunDetail,
  extractionRunPage,
  intakeImportResult,
  valuationDetail,
  valuationRow,
  valuationSuggestionPage,
  valuationSuggestionRow,
} from '@pb/contracts';
import type {
  ExtractionRun,
  InvestmentDetail,
  ValuationRow,
  ValuationSuggestionPage,
  ValuationSuggestionRow,
} from '@pb/contracts';
import {
  STATEMENT_EXAMPLES,
  SYNTHETIC_DOC_TYPES,
  accountingExports,
  generateDataset,
  generateDocuments,
  positionStatementDocument,
  previewBook,
} from '@pb/synthetic';
import type { DocumentSet } from '@pb/synthetic';
import {
  SUGGESTIONS_OFF_REFUSAL,
  SUGGESTION_CHANGED_REFUSAL,
  SUGGESTION_KEY_PREFIX,
} from '@pb/workflows';
import { parseBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import {
  USERS,
  generatedWorld,
  investmentFixture,
  problemOf,
  send,
  serveSamples,
  testBook,
  valuationFixture,
  buildWorld,
} from '../test-fixtures.js';

/**
 * The valuation suggestions of the static preview (docs/18 section 14, decision 0023), over the
 * generator's own book and documents: what the simulation derives, lists and decides is what the
 * API derives, lists and decides for the same seed (apps/api/src/test/suggestions.test.ts and
 * suggestion-commands.test.ts), since both read their sources through the same rules of
 * @pb/workflows and @pb/calc. Nothing is recorded: every suggestion here comes from an approval
 * made in the test's own session.
 */

const QF = SYNTHETIC_DOC_TYPES.quarterlyFinancials;
const LIST = '/api/v1/valuation-suggestions';
const SPONSOR_MARK = 'valuation_method.sponsor_mark';
const REPORT_INDICATION = 'valuation_method.report_indication';
const APPROVED = 'record_status.approved';

const dataset = generateDataset({ profile: 'small', seed: 42 });
const generated = generateDocuments(dataset);
const quarter = latestQuarterEndOnOrBefore(dataset.asOf);
const nextQuarter = latestQuarterEndOnOrBefore(addDays(quarter, 93));
const walledId = dataset.scenarios.walled_deal?.[0] ?? '';

const numberOf = (scenario: string): string =>
  dataset.investments.find((i) => i.id === dataset.scenarios[scenario]?.[0])?.investmentNumber ??
  '';
const STALE = numberOf('stale_valuation');
const WALLED = numberOf('walled_deal');
const investment = (number: string) => {
  const found = dataset.investments.find((i) => i.investmentNumber === number);
  if (found === undefined) throw new Error(`no investment ${number}`);
  return found;
};
const companyOf = (number: string): string =>
  dataset.portfolioCompanies.find((c) => c.id === investment(number).portfolioCompanyId)?.name ??
  '';

/** The walled position's statement for the quarter after the as-of date: no mark is Locked for it yet. */
const walledNext = (() => {
  const position = investment(WALLED);
  const fund = dataset.sponsorFunds.find((f) => f.id === position.sponsorFundId);
  if (fund === undefined) throw new Error('the walled position has no fund');
  return positionStatementDocument({
    periodEnd: nextQuarter,
    fund,
    vehicleName: dataset.vehicles.find((v) => v.id === position.vehicleId)?.name ?? '',
    investment: {
      id: position.id,
      investmentNumber: position.investmentNumber,
      companyName: companyOf(WALLED),
    },
    ...STATEMENT_EXAMPLES.ties,
  });
})();

/**
 * Two statements of the stale position for the quarter after the as-of date: one named by the
 * company, and a second named by our reference alone, with another balance.
 */
const [staleNext, staleNextSecond] = (() => {
  const position = investment(STALE);
  const fund = dataset.sponsorFunds.find((f) => f.id === position.sponsorFundId);
  if (fund === undefined) throw new Error('the stale position has no fund');
  const shared = {
    periodEnd: nextQuarter,
    fund,
    vehicleName: dataset.vehicles.find((v) => v.id === position.vehicleId)?.name ?? '',
    investment: {
      id: position.id,
      investmentNumber: position.investmentNumber,
      companyName: companyOf(STALE),
    },
  };
  return [
    positionStatementDocument({ ...shared, ...STATEMENT_EXAMPLES.ties }),
    positionStatementDocument({
      ...shared,
      fileCompany: null,
      // Its lines are 50,000 apart: it does not tie, and its balance stands all the same.
      lines: { ...STATEMENT_EXAMPLES.ties.lines, netGainLoss: '1.82', endingBalance: '21.94' },
    }),
  ] as const;
})();

/**
 * Another position's statement for the quarter after the as-of date, whose lines are for a whole
 * vehicle of which a quarter is ours.
 */
const WHOLE =
  generated.expectations.positionStatements
    .map((p) => p.investmentNumber)
    .find((number) => number !== STALE && number !== WALLED) ?? '';
const wholeNext = (() => {
  const position = investment(WHOLE);
  const fund = dataset.sponsorFunds.find((f) => f.id === position.sponsorFundId);
  if (fund === undefined) throw new Error('the position has no fund');
  return positionStatementDocument({
    periodEnd: nextQuarter,
    fund,
    vehicleName: dataset.vehicles.find((v) => v.id === position.vehicleId)?.name ?? '',
    investment: {
      id: position.id,
      investmentNumber: position.investmentNumber,
      companyName: companyOf(WHOLE),
    },
    ...STATEMENT_EXAMPLES.wholeVehicle,
  });
})();

const set: DocumentSet = {
  documents: [...generated.documents, walledNext, staleNext, staleNextSecond, wholeNext],
  expectations: generated.expectations,
};
const book = parseBook(JSON.parse(JSON.stringify(previewBook(dataset, { documents: set }))));
const bookInvestment = (id: string) => {
  const found = book.investments.find((i) => i.id === id);
  if (found === undefined) throw new Error(`no book investment ${id}`);
  return found;
};

/** The valuation versions of the dataset as the board records them. */
const valuations: ValuationRow[] = dataset.valuations.map((v) => {
  const inv = bookInvestment(v.investmentId);
  return valuationFixture(
    v.id,
    investmentFixture(inv.id, {
      investmentNumber: inv.investmentNumber,
      companyName: inv.companyName,
      dealType: inv.dealType,
    }),
    {
      periodEnd: v.periodEnd,
      quarterEnd: alignedQuarterEnd(v.periodEnd, 7),
      version: v.version,
      state: v.state,
      method: v.method,
      fairValue: v.fairValue,
    },
  );
});
const cashFlows = new Map<string, InvestmentDetail['cashFlows']>();
for (const flow of dataset.cashFlows) {
  if (flow.investmentId === null || flow.status !== APPROVED) continue;
  cashFlows.set(flow.investmentId, [
    ...(cashFlows.get(flow.investmentId) ?? []),
    { date: flow.flowDate, flowType: flow.flowType, amount: flow.amount },
  ]);
}
const fixtures = generatedWorld(book, walledId, [], {
  valuations,
  cashFlows,
  flags: [
    { key: 'valuation.suggestions', enabled: true, description: 'Valuation suggestions switch' },
  ],
});
const assets = serveSamples(new Map(set.documents.map((d) => [d.fileName, d.bytes])));
/** The clean accounting export of the generator, uploaded as a person would. */
const cleanExport = accountingExports(dataset)[0]?.csv ?? '';

const reportFile = (number: string, periodEnd: string): string =>
  generated.documents.find(
    (d) =>
      d.truth.docType === QF &&
      d.truth.investmentNumber === number &&
      d.truth.periodEnd === periodEnd &&
      d.truth.scenarios.length === 0,
  )?.fileName ??
  generated.documents.find(
    (d) =>
      d.truth.docType === QF &&
      d.truth.investmentNumber === number &&
      d.truth.periodEnd === periodEnd,
  )?.fileName ??
  '';
const statementFile = (number: string, periodEnd: string): string =>
  generated.expectations.positionStatements.find(
    (p) => p.investmentNumber === number && p.periodEnd === periodEnd,
  )?.fileName ?? '';
const fundStatementFile = (number: string): string => {
  const fund = dataset.sponsorFunds.find((f) => f.id === investment(number).sponsorFundId);
  return `${quarter} ${fund?.name ?? ''} - Capital account statement.pdf`;
};

let ids = 0;
let ticks = 0;
const env = {
  newId: (): string => `7a000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => new Date(Date.UTC(2025, 6, 1, 9, 0, 0) + ++ticks * 1000).toISOString(),
};

interface Session {
  f: typeof fetch;
  state: PreviewState;
}

function setup(): Session {
  const state = createPreviewState();
  return { f: createPreviewFetch(fixtures, assets, { env, state, book }), state };
}

const ok = async (
  f: typeof fetch,
  who: string,
  method: string,
  path: string,
  body?: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Promise<unknown> => {
  const answer = await send(f, who, method, path, body, extra);
  expect(answer.status, `${method} ${path}: ${answer.text}`).toBe(status);
  return answer.json;
};

/** A session with the inbox indexed and extraction on. */
async function ready(): Promise<Session> {
  const session = setup();
  await ok(session.f, 'ops.one', 'POST', '/api/v1/documents/index');
  await ok(session.f, 'admin.one', 'PATCH', '/api/v1/flags/ai.extraction', {
    enabled: true,
    reason: 'test',
  });
  return session;
}

/** Queues and runs the documents named (one type per batch), as the user given; answers the runs by file name. */
async function extract(
  f: typeof fetch,
  fileNames: readonly string[],
  who = 'ops.one',
): Promise<Map<string, ExtractionRun>> {
  const all = documentPage.parse(await ok(f, 'all.roles', 'GET', '/api/v1/documents?limit=200'));
  const out = new Map<string, ExtractionRun>();
  for (const fileName of fileNames) {
    const doc = all.items.find((d) => d.fileName === fileName);
    if (doc === undefined) throw new Error(`no document ${fileName}`);
    const batch = extractionBatch.parse(
      await ok(f, who, 'POST', '/api/v1/extraction/batches', { documentIds: [doc.id] }, 201),
    );
    const runs = extractionRunPage.parse(
      await ok(f, 'all.roles', 'GET', `/api/v1/extraction/runs?limit=200&batchId=${batch.id}`),
    ).items;
    const run = runs.find((r) => r.documentId === doc.id);
    if (run === undefined) throw new Error(`no run for ${fileName}`);
    expect(run.state, fileName).toBe('Succeeded');
    out.set(fileName, run);
  }
  return out;
}

const runCommands = (id: string): string => `/api/v1/extraction/runs/${id}/commands`;

/** Decides every value of a run (clean and flagged accepted, the rest rejected). */
async function review(f: typeof fetch, who: string, runId: string): Promise<void> {
  const before = extractionRunDetail.parse(
    await ok(f, who, 'GET', `/api/v1/extraction/runs/${runId}`),
  );
  for (const value of before.values) {
    if (value.decision !== null || value.validationState === 'clean') continue;
    await ok(
      f,
      who,
      'POST',
      runCommands(runId),
      value.validationState === 'flagged'
        ? { command: 'accept', field: value.field }
        : { command: 'reject', field: value.field, reason: 'not read in this test' },
    );
  }
  await ok(f, who, 'POST', runCommands(runId), { command: 'acceptClean' });
}

async function approve(f: typeof fetch, who: string, runId: string): Promise<void> {
  await review(f, who, runId);
  await ok(f, who, 'POST', runCommands(runId), { command: 'approve' });
}

const list = async (f: typeof fetch, who: string, query = ''): Promise<ValuationSuggestionPage> =>
  valuationSuggestionPage.parse(await ok(f, who, 'GET', `${LIST}?limit=200${query}`));
const detail = async (f: typeof fetch, who: string, id: string): Promise<ValuationSuggestionRow> =>
  valuationSuggestionRow.parse(await ok(f, who, 'GET', `${LIST}/${id}`));
const outcomeOf = async (f: typeof fetch, who: string, runId: string) =>
  (await list(f, who, `&extractionRunId=${runId}&state=all`)).runOutcome;
const command = (f: typeof fetch, who: string, row: ValuationSuggestionRow, body: object) =>
  send(f, who, 'POST', `${LIST}/${row.id}/commands`, body, {
    'if-match': `"${row.rowVersion}"`,
  });
const decided = async (
  f: typeof fetch,
  who: string,
  row: ValuationSuggestionRow,
  body: object,
): Promise<ValuationSuggestionRow> => {
  const answer = await command(f, who, row, body);
  expect(answer.status, answer.text).toBe(200);
  return valuationSuggestionRow.parse(answer.json);
};
const valuationCommand = async (
  f: typeof fetch,
  who: string,
  id: string,
  body: object,
): Promise<ValuationRow> =>
  valuationRow.parse(await ok(f, who, 'POST', `/api/v1/valuations/${id}/commands`, body));

const userId = (key: keyof typeof USERS): string => USERS[key].userId;
const staleId = investment(STALE).id;
const lockedMark = (number: string, periodEnd: string): string =>
  dataset.valuations.find(
    (v) =>
      v.investmentId === investment(number).id && v.periodEnd === periodEnd && v.state === 'Locked',
  )?.fairValue ?? '';
const bookQuarter = (number: string, periodEnd: string) => {
  const found = book.quarters[investment(number).id]?.find(
    (q) => q.periodEnd === periodEnd && !q.isEntrySnapshot,
  );
  if (found === undefined) throw new Error(`no quarter ${periodEnd} for ${number}`);
  return found;
};
const previousQuarter = latestQuarterEndOnOrBefore(addDays(quarter, -1));

/** The stale position's report and statement of the latest quarter, extracted. */
async function staleRuns(
  f: typeof fetch,
): Promise<{ report: ExtractionRun; statement: ExtractionRun }> {
  const files = [reportFile(STALE, quarter), statementFile(STALE, quarter)];
  const runs = await extract(f, files);
  const report = runs.get(files[0] ?? '');
  const statement = runs.get(files[1] ?? '');
  if (report === undefined || statement === undefined) throw new Error('runs not found');
  return { report, statement };
}

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('preview: valuation suggestions before anything is approved', () => {
  const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
  const ID = '58000000-0000-4000-8000-000000000001';
  const bare = (): typeof fetch =>
    createPreviewFetch(buildWorld().fixtures, never, { book: testBook() });

  it('lists nothing for the roles that read, whatever the filters', async () => {
    const f = bare();
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
    const f = bare();
    for (const user of [USERS.viewer, USERS.admin]) {
      const answer = await send(f, user.externalId, 'GET', LIST);
      expect(answer.status, user.externalId).toBe(403);
      expect(problemOf(answer).code).toBe('forbidden');
    }
    const refused = await send(f, USERS.deal.externalId, 'POST', `${LIST}/${ID}/commands`, {
      command: 'accept',
    });
    expect(refused.status).toBe(403);
  });

  it('validates a request with the contract before it answers', async () => {
    const f = bare();
    const badState = await send(f, USERS.ops.externalId, 'GET', `${LIST}?state=Locked`);
    expect(badState.status).toBe(400);
    const badBody = await send(f, USERS.ops.externalId, 'POST', `${LIST}/${ID}/commands`, {
      command: 'dismiss',
    });
    expect(badBody.status).toBe(400);
    const badCursor = await send(f, USERS.ops.externalId, 'GET', `${LIST}?cursor=not-a-cursor`);
    expect(badCursor.status).toBe(400);
  });

  it('answers 404 for a suggestion that does not exist', async () => {
    const f = bare();
    const read = await send(f, USERS.ops.externalId, 'GET', `${LIST}/${ID}`);
    expect(read.status).toBe(404);
    expect(problemOf(read)).toEqual({
      code: 'not-found',
      detail: 'Valuation suggestion not found',
    });
    const refused = await send(
      f,
      USERS.ops.externalId,
      'POST',
      `${LIST}/${ID}/commands`,
      { command: 'dismiss', reason: 'not ours' },
      { 'if-match': '"1"' },
    );
    expect(refused.status).toBe(404);
    expect(problemOf(refused).code).toBe('not-found');
  });
});

describe('preview: the example sequence on the position with no mark for the quarter', () => {
  it('opens a suggestion from the sponsor report, then replaces it when the statement is approved', async () => {
    const { f, state } = await ready();
    const { report, statement } = await staleRuns(f);
    expect(await outcomeOf(f, 'deal.one', report.id)).toBeNull();
    expect((await list(f, 'ops.one')).items).toEqual([]);

    // The report first: the last Locked mark scaled by the change in equity value (rule 12.2).
    await approve(f, 'deal.one', report.id);
    const first = await list(f, 'ops.one');
    expect(first.openCount).toBe(1);
    expect(first.items).toHaveLength(1);
    const fromReport = first.items[0]!;
    const mark = lockedMark(STALE, previousQuarter);
    expect(mark).toBe('46078308.34');
    const earlier = bookQuarter(STALE, previousQuarter);
    const promoted = state.promotedQuarters.get(`${staleId}|${quarter}`);
    expect(promoted?.source.runId).toBe(report.id);
    const reportEv = promoted?.figures.ev;
    if (typeof reportEv !== 'string') throw new Error('the report promoted no enterprise value');
    const expected = impliedStakeMark({
      referenceMark: mark,
      flowsSinceReferenceMark: false,
      reference: { ev: earlier.ev, netDebt: earlier.netDebt },
      current: { ev: reportEv, netDebt: promoted?.figures.netDebt ?? null },
    });
    expect(expected.value).not.toBeNull();
    expect(fromReport).toMatchObject({
      investmentId: staleId,
      investmentNumber: STALE,
      companyName: companyOf(STALE),
      periodEnd: quarter,
      basis: 'sponsor_equity_value',
      method: REPORT_INDICATION,
      reasonCode: null,
      state: 'Open',
      decidedBy: null,
      valuationId: null,
      supersededReason: null,
      checks: null,
      crossChecks: [],
      inProgress: null,
      sourceReviewerIds: [userId('deal')],
      currentMark: {
        value: mark,
        periodEnd: previousQuarter,
        reportsFor: previousQuarter,
        previousQuarter: true,
        ageQuarters: 1,
      },
      source: {
        documentId: report.documentId,
        fileName: report.fileName,
        extractionRunId: report.id,
        locator: 'field:enterprise_value',
      },
      rowVersion: 1,
    });
    expect(D(fromReport.suggestedValue!).eq(D(expected.value!))).toBe(true);
    // To the cent, as the column holds it.
    expect(fromReport.suggestedValue).toMatch(/^\d+\.\d{2}$/);
    expect(fromReport.source.page).toBeGreaterThanOrEqual(1);
    expect(fromReport.workings.inputs.map((i) => [i.key, i.source.kind, i.periodEnd])).toEqual([
      ['reference_mark', 'valuation', previousQuarter],
      ['reference_enterprise_value', 'record', previousQuarter],
      ['reference_net_debt', 'record', previousQuarter],
      ['enterprise_value', 'document', quarter],
      ['net_debt', 'document', quarter],
    ]);
    for (const input of fromReport.workings.inputs) {
      expect(input.edited).toBe(false);
      expect(input.source.fileName).toBe(input.source.kind === 'document' ? report.fileName : null);
    }
    expect(fromReport.comparison.changePct).toBe(
      toDecimalString(valueChange(fromReport.suggestedValue, mark)),
    );
    expect(fromReport.comparison.netOfFlows).toBeNull();
    // More than ten percent below the previous quarter's mark: the board's variance flag.
    expect(fromReport.flags).toEqual({
      variance: true,
      ties: null,
      contributionsDiffer: false,
      sourcesDiffer: false,
      editedByReviewer: false,
    });
    expect(await outcomeOf(f, 'deal.one', report.id)).toEqual({
      outcome: 'opened',
      reason: null,
      suggestionId: fromReport.id,
    });
    // Read with its ETag by the roles that read, with the same row.
    for (const who of ['deal.one', 'ops.two', 'head.one']) {
      const read = await send(f, who, 'GET', `${LIST}/${fromReport.id}`);
      expect(read.status, who).toBe(200);
      expect(read.headers.get('etag')).toBe(`"${fromReport.rowVersion}"`);
      expect(valuationSuggestionRow.parse(read.json)).toEqual(fromReport);
    }
    expect(state.audit.filter((e) => e.entity === 'valuation_suggestion')).toMatchObject([
      { action: 'valuation_suggestion.open', actorExternalId: 'deal.one', to: 'Open' },
    ]);

    // The statement next: its ending balance replaces the report's indication, which stays beside it.
    await approve(f, 'ops.one', statement.id);
    const second = await list(f, 'ops.one');
    expect(second.openCount).toBe(1);
    const fromStatement = second.items[0]!;
    expect(fromStatement).toMatchObject({
      investmentNumber: STALE,
      periodEnd: quarter,
      basis: 'capital_account_balance',
      method: SPONSOR_MARK,
      suggestedValue: '38140000.00',
      reasonCode: null,
      state: 'Open',
      sourceReviewerIds: [userId('ops')],
      source: {
        documentId: statement.documentId,
        extractionRunId: statement.id,
        page: 1,
        locator: 'field:ending_capital_balance',
      },
    });
    expect(fromStatement.workings.inputs).toEqual([
      {
        key: 'ending_capital_balance',
        value: '38140000',
        periodEnd: quarter,
        source: {
          kind: 'document',
          id: statement.documentId,
          page: 1,
          fileName: statement.fileName,
        },
        edited: false,
      },
    ]);
    expect(fromStatement.crossChecks).toHaveLength(1);
    const [beside] = fromStatement.crossChecks;
    expect(beside).toMatchObject({ basis: 'sponsor_equity_value', reason: null, differs: false });
    expect(D(beside!.value!).eq(D(fromReport.suggestedValue!))).toBe(true);
    expect(D(beside!.difference!).eq(D(fromReport.suggestedValue!).minus('38140000'))).toBe(true);
    expect(D(beside!.difference!).abs().lt(10000)).toBe(true);
    expect(fromStatement.checks).toMatchObject({
      ties: true,
      ownAccount: true,
      tieToleranceUsd: '25000',
      contributionsCheck: { differs: false, notChecked: null, record: '37860237.78' },
    });
    expect(fromStatement.flags).toEqual({
      variance: true,
      ties: true,
      contributionsDiffer: false,
      sourcesDiffer: false,
      editedByReviewer: false,
    });

    const replaced = await detail(f, 'ops.one', fromReport.id);
    expect(replaced).toMatchObject({
      state: 'Superseded',
      supersededReason: 'better_source',
      supersededById: fromStatement.id,
      decisionReason: null,
      valuationId: null,
      // The system actor superseded it: no person is named.
      decidedBy: null,
      rowVersion: fromReport.rowVersion + 1,
      // The figures of a suggestion never change: a new one replaced it.
      suggestedValue: fromReport.suggestedValue,
      workings: fromReport.workings,
    });
    expect(replaced.decidedAt).not.toBeNull();
    expect((await list(f, 'head.one', '&state=Superseded')).items.map((s) => s.id)).toEqual([
      fromReport.id,
    ]);
    expect((await list(f, 'head.one', '&state=all')).items.map((s) => s.id)).toEqual([
      fromStatement.id,
      fromReport.id,
    ]);
    expect(await outcomeOf(f, 'ops.one', statement.id)).toEqual({
      outcome: 'replaced',
      reason: null,
      suggestionId: fromStatement.id,
    });
    expect((await outcomeOf(f, 'ops.one', report.id))?.outcome).toBe('opened');
    expect(
      state.audit.filter((e) => e.entity === 'valuation_suggestion').map((e) => e.action),
    ).toEqual([
      'valuation_suggestion.open',
      'valuation_suggestion.supersede',
      'valuation_suggestion.open',
    ]);

    // Paged newest first, and filtered by position, quarter and state.
    const pageOf = async (query: string) =>
      valuationSuggestionPage.parse(
        await ok(f, 'ops.one', 'GET', `${LIST}?state=all&limit=1${query}`),
      );
    const newest = await pageOf('');
    expect(newest.items.map((s) => s.id)).toEqual([fromStatement.id]);
    expect(newest.nextCursor).not.toBeNull();
    const older = await pageOf(`&cursor=${encodeURIComponent(newest.nextCursor!)}`);
    expect(older.items.map((s) => s.id)).toEqual([fromReport.id]);
    expect(older.nextCursor).toBeNull();
    const here = `&investmentId=${staleId}`;
    expect((await list(f, 'ops.one', `${here}&periodEnd=${quarter}`)).items).toHaveLength(1);
    expect((await list(f, 'ops.one', `${here}&periodEnd=${previousQuarter}`)).items).toEqual([]);
    expect((await list(f, 'ops.one', `&investmentId=${investment('INV-0001').id}`)).items).toEqual(
      [],
    );
    expect((await list(f, 'ops.one', '&state=Dismissed')).items).toEqual([]);
    // A report approved after the statement changes only what stands beside it.
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('suggests the ending balance at once when the statement comes first, with the quarter on record beside it', async () => {
    const { f } = await ready();
    const { report, statement } = await staleRuns(f);
    await approve(f, 'ops.one', statement.id);
    const [open] = (await list(f, 'ops.one')).items;
    expect(open).toMatchObject({
      basis: 'capital_account_balance',
      suggestedValue: '38140000.00',
      state: 'Open',
    });
    // The seeded quarter on record gives the report's indication before any report run is approved.
    expect(open?.crossChecks).toMatchObject([{ basis: 'sponsor_equity_value', reason: null }]);
    expect(await outcomeOf(f, 'ops.one', statement.id)).toEqual({
      outcome: 'opened',
      reason: null,
      suggestionId: open?.id,
    });
    // The report arrives: the statement still gives the suggestion and nothing is replaced.
    await approve(f, 'deal.one', report.id);
    const after = await list(f, 'ops.one', '&state=all');
    expect(after.items.map((s) => [s.id, s.state])).toEqual([[open?.id, 'Open']]);
    expect(await outcomeOf(f, 'ops.one', report.id)).toEqual({
      outcome: 'unchanged',
      reason: null,
      suggestionId: open?.id,
    });
    // A reset forgets the suggestion with everything else of the session.
    await ok(f, 'viewer.one', 'POST', '/api/v1/preview/reset');
    expect(await list(f, 'ops.one', '&state=all')).toMatchObject({ items: [], openCount: 0 });
  });
});

describe('preview: two statements for one quarter, and a figure a reviewer typed', () => {
  it('counts the later of two approved statements, whichever that is', async () => {
    for (const order of ['named first', 'named last'] as const) {
      const { f } = await ready();
      const files = [staleNext.fileName, staleNextSecond.fileName];
      expect(new Set(files).size).toBe(2);
      const runs = await extract(f, files);
      const [named, second] = files.map((name) => runs.get(name)!);
      const [first, last] = order === 'named first' ? [named, second] : [second, named];
      await approve(f, 'ops.one', first!.id);
      await approve(f, 'ops.two', last!.id);
      const all = (await list(f, 'ops.one', '&state=all')).items;
      expect(
        all.map((s) => [s.periodEnd, s.state, s.suggestedValue, s.supersededReason]),
        order,
      ).toEqual(
        order === 'named first'
          ? [
              [nextQuarter, 'Open', '21940000.00', null],
              [nextQuarter, 'Superseded', '20940000.00', 'figures_changed'],
            ]
          : [
              [nextQuarter, 'Open', '20940000.00', null],
              [nextQuarter, 'Superseded', '21940000.00', 'figures_changed'],
            ],
      );
      // The suggestion that stands is read with its own statement, and names who approved it.
      expect(all[0]?.source.extractionRunId, order).toBe(last!.id);
      expect(all[0]?.sourceReviewerIds, order).toEqual([userId('ops2')]);
      expect(all[1]?.source.extractionRunId, order).toBe(first!.id);
      expect(all[1]?.sourceReviewerIds, order).toEqual([userId('ops')]);
      // Each is read with the lines of the statement it came from, whichever is the later one.
      expect(
        all.map((s) => s.checks?.ties),
        order,
      ).toEqual(order === 'named first' ? [false, true] : [true, false]);
      // Derived again at accept, the later statement still gives the suggestion: it is accepted.
      const accepted = await decided(f, 'ops.one', all[0]!, { command: 'accept' });
      expect(accepted.state, order).toBe('Accepted');
      expect(accepted.inProgress?.fairValue, order).toBe(all[0]?.suggestedValue);
    }
  });

  it('says a reviewer typed a figure, cites no page for it and names them as a source reviewer', async () => {
    const { f } = await ready();
    const { statement } = await staleRuns(f);
    await review(f, 'ops.two', statement.id);
    await ok(f, 'ops.two', 'POST', runCommands(statement.id), {
      command: 'edit',
      field: 'ending_capital_balance',
      value: '38.20',
      unit: 'USD_M',
      reason: 'The sponsor corrected the balance by letter.',
    });
    await ok(f, 'ops.one', 'POST', runCommands(statement.id), { command: 'approve' });
    const [open] = (await list(f, 'ops.one')).items;
    expect(open).toMatchObject({
      basis: 'capital_account_balance',
      suggestedValue: '38200000.00',
      // The approver of the run, and whoever typed the figure.
      sourceReviewerIds: [userId('ops'), userId('ops2')].sort(),
      source: { extractionRunId: statement.id, page: null, locator: null },
      flags: { editedByReviewer: true },
    });
    expect(open?.workings.inputs).toEqual([
      {
        key: 'ending_capital_balance',
        value: '38200000',
        periodEnd: quarter,
        source: { kind: 'reviewer', id: userId('ops2'), page: null, fileName: null },
        edited: true,
      },
    ]);
    // The typed balance no longer adds up with the lines read from the statement.
    expect(open?.checks?.ties).toBe(false);
    expect(open?.flags.ties).toBe(false);
  });

  it('falls to the report rule when the statement gives no value, with the statement beside it', async () => {
    const { f } = await ready();
    const { statement } = await staleRuns(f);
    // The reviewer stands behind every line but the ending balance, which is rejected.
    await ok(f, 'ops.one', 'POST', runCommands(statement.id), {
      command: 'reject',
      field: 'ending_capital_balance',
      reason: 'The balance is not the one on the signed copy',
    });
    await approve(f, 'ops.one', statement.id);
    const [open] = (await list(f, 'ops.one')).items;
    // Rule 12.2 over the quarter on record: the statement's approval raised it, and none of its
    // figures was read from the statement.
    expect(open).toMatchObject({
      basis: 'sponsor_equity_value',
      method: REPORT_INDICATION,
      reasonCode: null,
      source: { extractionRunId: statement.id, page: null },
      sourceReviewerIds: [],
      checks: null,
    });
    expect(open?.suggestedValue).toMatch(/^\d+\.\d{2}$/);
    expect(open?.workings.inputs.map((input) => input.source.kind)).toEqual([
      'valuation',
      'record',
      'record',
      'record',
      'record',
    ]);
    expect(open?.crossChecks).toEqual([
      {
        basis: 'capital_account_balance',
        value: null,
        reason: 'no_ending_balance',
        difference: null,
        differencePct: null,
        differs: false,
      },
    ]);
    expect(await outcomeOf(f, 'ops.one', statement.id)).toEqual({
      outcome: 'opened',
      reason: null,
      suggestionId: open?.id,
    });
  });

  it('says the sources differ when the statement is far from what the report indicates', async () => {
    const { f } = await ready();
    const { report, statement } = await staleRuns(f);
    await approve(f, 'deal.one', report.id);
    const [fromReport] = (await list(f, 'ops.one')).items;
    // The account of the worked example on this position: a balance far from the report's.
    await review(f, 'ops.two', statement.id);
    await ok(f, 'ops.two', 'POST', runCommands(statement.id), {
      command: 'edit',
      field: 'ending_capital_balance',
      value: '20.94',
      unit: 'USD_M',
      reason: 'The balance on the signed copy',
    });
    await ok(f, 'ops.one', 'POST', runCommands(statement.id), { command: 'approve' });
    const [open] = (await list(f, 'ops.one')).items;
    expect(open).toMatchObject({
      basis: 'capital_account_balance',
      suggestedValue: '20940000.00',
      flags: { sourcesDiffer: true },
    });
    // The report's indication sits beside it with the difference, and nothing is averaged.
    expect(open?.crossChecks).toHaveLength(1);
    const check = open?.crossChecks[0];
    expect(check).toMatchObject({
      basis: 'sponsor_equity_value',
      value: fromReport?.suggestedValue,
      reason: null,
      differs: true,
    });
    expect(check?.difference).toBe(
      toDecimalString(D(fromReport?.suggestedValue ?? '0').minus('20940000')),
    );
    expect(check?.differencePct).toBe(
      toDecimalString(valueChange(fromReport?.suggestedValue ?? null, '20940000.00')),
    );
  });

  it('never reads the lines of a whole vehicle as our account while nobody stands behind the share', async () => {
    const { f } = await ready();
    const run = (await extract(f, [wholeNext.fileName])).get(wholeNext.fileName)!;
    const staged = extractionRunDetail.parse(
      await ok(f, 'ops.one', 'GET', `/api/v1/extraction/runs/${run.id}`),
    ).values;
    expect(staged.find((v) => v.field === 'investor_share_pct')).toMatchObject({
      value: '0.2500',
      decision: null,
    });
    // Every line the statement states is accepted; our share of the vehicle is left undecided.
    for (const v of staged) {
      if (v.field === 'investor_share_pct' || v.value === null) continue;
      await ok(f, 'ops.one', 'POST', runCommands(run.id), { command: 'accept', field: v.field });
    }
    const approveIt = () => send(f, 'ops.one', 'POST', runCommands(run.id), { command: 'approve' });
    const undecided = await approveIt();
    expect(undecided.status).toBe(409);
    expect(problemOf(undecided).detail).toBe(
      "extraction: Our share of the vehicle was read and is not accepted or edited, so Beginning capital balance is the whole vehicle's and not our account's; accept or edit the share, or reject the lines it scales",
    );
    // Rejecting the share does not make the lines ours either.
    await ok(f, 'ops.one', 'POST', runCommands(run.id), {
      command: 'reject',
      field: 'investor_share_pct',
      reason: 'The share is not the one on the signed copy',
    });
    expect((await approveIt()).status).toBe(409);
    expect((await list(f, 'ops.one', '&state=all')).items).toEqual([]);
    // With the share typed by the reviewer, the suggestion is the balance times it.
    await ok(f, 'ops.two', 'POST', runCommands(run.id), {
      command: 'edit',
      field: 'investor_share_pct',
      value: '0.2500',
      unit: 'PCT',
      reason: 'The share on the signed copy',
    });
    expect((await approveIt()).status).toBe(200);
    const [open] = (await list(f, 'ops.one')).items;
    expect(open).toMatchObject({
      investmentNumber: WHOLE,
      suggestedValue: '20940000.00',
      checks: { ownAccount: false },
    });
    expect(open?.workings.inputs.map((input) => [input.key, input.value, input.edited])).toEqual([
      ['ending_capital_balance', '83760000', false],
      ['investor_share_pct', '0.2500', true],
    ]);
  });
});

describe('preview: when no mark is suggested', () => {
  it('says why for a fund statement and for a quarter whose mark is Locked', async () => {
    const { f } = await ready();
    // Our account in a fund commitment: no position, no valuation record.
    const fundRuns = await extract(f, [fundStatementFile(STALE)]);
    const fundRun = [...fundRuns.values()][0]!;
    await approve(f, 'ops.one', fundRun.id);
    expect(await outcomeOf(f, 'ops.one', fundRun.id)).toEqual({
      outcome: 'none',
      reason: 'fund_commitment',
      suggestionId: null,
    });
    // The stale position's statement of the quarter before: its mark is Locked.
    const earlierFile = statementFile(STALE, previousQuarter);
    const earlierRun = (await extract(f, [earlierFile])).get(earlierFile)!;
    await approve(f, 'ops.one', earlierRun.id);
    expect(await outcomeOf(f, 'ops.one', earlierRun.id)).toEqual({
      outcome: 'none',
      reason: 'mark_locked',
      suggestionId: null,
    });
    expect((await list(f, 'ops.one', '&state=all')).items).toEqual([]);
    // A run nobody approved, and a run that is neither a statement nor a report, say nothing.
    const { report } = await staleRuns(f);
    expect(await outcomeOf(f, 'ops.one', report.id)).toBeNull();
  });

  it('derives nothing while the switch is off, and reads still work', async () => {
    const { f } = await ready();
    const { statement } = await staleRuns(f);
    await ok(f, 'admin.one', 'PATCH', '/api/v1/flags/valuation.suggestions', {
      enabled: false,
      reason: 'test',
    });
    await approve(f, 'ops.one', statement.id);
    expect(await list(f, 'ops.one', '&state=all')).toMatchObject({ items: [], openCount: 0 });
    // No rule keeps a mark from being suggested, and none was.
    expect(await outcomeOf(f, 'ops.one', statement.id)).toEqual({
      outcome: 'none',
      reason: null,
      suggestionId: null,
    });
  });
});

describe('preview: behind the wall', () => {
  it('shows a walled statement and its suggestion to the wall members only', async () => {
    const { f } = await ready();
    const run = (await extract(f, [walledNext.fileName], 'all.roles')).get(walledNext.fileName)!;
    await approve(f, 'all.roles', run.id);
    const inside = await list(f, 'deal.three');
    expect(inside.openCount).toBe(1);
    expect(inside.items).toMatchObject([
      {
        investmentNumber: WALLED,
        periodEnd: nextQuarter,
        basis: 'capital_account_balance',
        suggestedValue: '20940000.00',
        state: 'Open',
      },
    ]);
    const hidden = inside.items[0]!;
    expect((await detail(f, 'head.one', hidden.id)).id).toBe(hidden.id);
    for (const who of ['ops.one', 'deal.one']) {
      expect(await list(f, who, '&state=all'), who).toMatchObject({ items: [], openCount: 0 });
      expect((await send(f, who, 'GET', `${LIST}/${hidden.id}`)).status, who).toBe(404);
      expect(await outcomeOf(f, who, run.id), who).toBeNull();
    }
    // Operations outside the wall has nothing to decide.
    const refused = await command(f, 'ops.one', hidden, { command: 'dismiss', reason: 'not ours' });
    expect(refused.status).toBe(404);
    expect((await detail(f, 'deal.three', hidden.id)).state).toBe('Open');
  });
});

describe('preview: deciding a suggestion', () => {
  /** A session with the statement-based suggestion of the stale position Open, its run approved by the user given. */
  async function withStatement(
    approver = 'ops.one',
  ): Promise<Session & { open: ValuationSuggestionRow; statement: ExtractionRun }> {
    const session = await ready();
    const { statement } = await staleRuns(session.f);
    await approve(session.f, approver, statement.id);
    const [open] = (await list(session.f, 'ops.one')).items;
    if (open === undefined) throw new Error('no open suggestion');
    return { ...session, open, statement };
  }

  it('opens a draft valuation at the suggested value, with where it came from', async () => {
    const { f, state, open, statement } = await withStatement('deal.one');
    // Only operations decides.
    for (const who of ['deal.one', 'head.one']) {
      const refused = await command(f, who, open, { command: 'accept' });
      expect(refused.status, who).toBe(403);
    }
    const stale = await send(
      f,
      'ops.one',
      'POST',
      `${LIST}/${open.id}/commands`,
      { command: 'accept' },
      { 'if-match': '"7"' },
    );
    expect(stale.status).toBe(412);
    expect(problemOf(stale).detail).toContain('valuation_suggestion');

    const accepted = await decided(f, 'ops.one', open, { command: 'accept' });
    expect(accepted).toMatchObject({
      id: open.id,
      state: 'Accepted',
      decidedBy: { id: userId('ops'), name: USERS.ops.displayName },
      decisionReason: null,
      rowVersion: open.rowVersion + 1,
      suggestedValue: open.suggestedValue,
      inProgress: {
        periodEnd: quarter,
        version: 1,
        state: 'Draft',
        method: SPONSOR_MARK,
        fairValue: '38140000.00',
      },
    });
    expect(accepted.valuationId).toBe(accepted.inProgress?.valuationId);
    const draft = valuationDetail.parse(
      await ok(f, 'ops.one', 'GET', `/api/v1/valuations/${accepted.valuationId}`),
    );
    expect(draft).toMatchObject({
      investmentId: staleId,
      periodEnd: quarter,
      state: 'Draft',
      method: SPONSOR_MARK,
      fairValue: '38140000.00',
    });
    // The keys say which suggestion the value came from, each input and what stood beside it.
    expect(draft.inputs).toMatchObject({
      'suggestion.id': open.id,
      'suggestion.basis': 'capital_account_balance',
      'suggestion.value': '38140000.00',
      'suggestion.periodEnd': quarter,
      'suggestion.documentId': statement.documentId,
      'suggestion.page': '1',
      'suggestion.runId': statement.id,
      'suggestion.input.ending_capital_balance': '38140000',
    });
    expect(draft.inputs['suggestion.crossCheck.sponsor_equity_value']).toMatch(/^\d+\.\d{2}$/);
    expect(
      state.audit.filter((e) => e.entityId === open.id || e.entityId === draft.id),
    ).toMatchObject([
      { action: 'valuation_suggestion.open' },
      { action: 'valuation.create', actorExternalId: 'ops.one', to: 'Draft' },
      { action: 'valuation_suggestion.accept', from: 'Open', to: 'Accepted' },
    ]);
    expect((await list(f, 'ops.one')).openCount).toBe(0);

    // Decided: every command is refused and nothing changes.
    for (const body of [
      { command: 'accept' },
      { command: 'applyToDraft' },
      { command: 'dismiss', reason: 'changed my mind' },
    ]) {
      const refused = await command(f, 'ops.one', accepted, body);
      expect(refused.status, body.command).toBe(409);
      expect(problemOf(refused).code, body.command).toBe('workflow-transition');
    }
    // The same request again answers what it answered (Idempotency-Key).
    const again = await send(
      f,
      'ops.one',
      'POST',
      `${LIST}/${open.id}/commands`,
      { command: 'accept' },
      { 'if-match': `"${accepted.rowVersion}"`, 'idempotency-key': 'k-accept-twice' },
    );
    expect(again.status).toBe(409);

    // An edit of the Draft keeps the suggestion's keys whatever it sends.
    const edited = valuationRow.parse(
      await ok(
        f,
        'ops.one',
        'PATCH',
        `/api/v1/valuations/${draft.id}`,
        { inputs: { note: 'checked', 'suggestion.value': '1.00', 'suggestion.extra': 'x' } },
        200,
        { 'if-match': `"${draft.rowVersion}"` },
      ),
    );
    const afterEdit = valuationDetail.parse(
      await ok(f, 'ops.one', 'GET', `/api/v1/valuations/${edited.id}`),
    );
    expect(afterEdit.inputs.note).toBe('checked');
    expect(afterEdit.inputs['suggestion.value']).toBe('38140000.00');
    expect(afterEdit.inputs['suggestion.extra']).toBeUndefined();
    expect(afterEdit.inputs['suggestion.id']).toBe(open.id);

    // Whoever approved the run behind the figure can take neither approval of this valuation.
    await valuationCommand(f, 'ops.two', draft.id, { command: 'prepare' });
    const barred = await send(f, 'deal.one', 'POST', `/api/v1/valuations/${draft.id}/commands`, {
      command: 'dealTeamApprove',
    });
    expect(barred.status).toBe(422);
    expect(problemOf(barred).code).toBe('workflow-precondition');
    await valuationCommand(f, 'deal.three', draft.id, { command: 'dealTeamApprove' });
    const locked = await valuationCommand(f, 'head.one', draft.id, { command: 'lock' });
    expect(locked).toMatchObject({
      state: 'Locked',
      method: SPONSOR_MARK,
      fairValue: '38140000.00',
    });
    // The report arriving afterwards raises nothing: the value is on the Locked mark.
    const { report } = await staleRuns(f);
    await approve(f, 'ops.two', report.id);
    expect((await list(f, 'ops.one', '&state=all')).items.map((s) => s.state)).toEqual([
      'Accepted',
    ]);
    expect(await outcomeOf(f, 'ops.one', report.id)).toEqual({
      outcome: 'none',
      reason: 'mark_locked',
      suggestionId: null,
    });
  });

  it('refuses the lock to an approver who stood behind the figure', async () => {
    const { f, open } = await withStatement('all.roles');
    expect(open.sourceReviewerIds).toEqual([userId('all')]);
    const accepted = await decided(f, 'ops.one', open, { command: 'accept' });
    const id = accepted.valuationId!;
    await valuationCommand(f, 'ops.two', id, { command: 'prepare' });
    await valuationCommand(f, 'deal.one', id, { command: 'dealTeamApprove' });
    const barred = await send(f, 'all.roles', 'POST', `/api/v1/valuations/${id}/commands`, {
      command: 'lock',
    });
    expect(barred.status).toBe(422);
    expect((await valuationCommand(f, 'head.one', id, { command: 'lock' })).state).toBe('Locked');
  });

  it('keeps a source reviewer out of both approvals of the version a reopen starts', async () => {
    const { f, open } = await withStatement('all.roles');
    const accepted = await decided(f, 'ops.one', open, { command: 'accept' });
    const first = accepted.valuationId!;
    await valuationCommand(f, 'ops.two', first, { command: 'prepare' });
    await valuationCommand(f, 'deal.one', first, { command: 'dealTeamApprove' });
    await valuationCommand(f, 'head.one', first, { command: 'lock' });
    const reopened = await valuationCommand(f, 'ops.one', first, {
      command: 'reopen',
      reason: 'The sponsor reissued the statement',
    });
    expect(reopened.id).not.toBe(first);
    expect(reopened).toMatchObject({ state: 'Draft', version: 2, fairValue: '38140000.00' });
    // The new version carries the same mark and the suggestion's keys, while the Accepted
    // suggestion still names the version it was accepted onto: the rule follows the mark.
    const copy = valuationDetail.parse(
      await ok(f, 'ops.one', 'GET', `/api/v1/valuations/${reopened.id}`),
    );
    expect(copy.inputs['suggestion.id']).toBe(open.id);
    expect((await detail(f, 'ops.one', open.id)).valuationId).toBe(first);
    const commands = `/api/v1/valuations/${reopened.id}/commands`;
    await valuationCommand(f, 'ops.two', reopened.id, { command: 'prepare' });
    const barred = await send(f, 'all.roles', 'POST', commands, { command: 'dealTeamApprove' });
    expect(barred.status).toBe(422);
    expect(problemOf(barred).code).toBe('workflow-precondition');
    await valuationCommand(f, 'deal.one', reopened.id, { command: 'dealTeamApprove' });
    const lockBarred = await send(f, 'all.roles', 'POST', commands, { command: 'lock' });
    expect(lockBarred.status).toBe(422);
    expect(problemOf(lockBarred).code).toBe('workflow-precondition');
    expect((await valuationCommand(f, 'head.one', reopened.id, { command: 'lock' })).state).toBe(
      'Locked',
    );
  });

  it('puts the value and the method on a Draft already open, which keeps its date and its own inputs', async () => {
    const { f, open } = await withStatement();
    const early = addDays(quarter, -3);
    const byHand = valuationRow.parse(
      await ok(
        f,
        'ops.two',
        'POST',
        '/api/v1/valuations',
        {
          investmentId: staleId,
          periodEnd: early,
          method: 'valuation_method.market_multiple',
          fairValue: '40000000.00',
          // A person cannot make a Draft read as started from a suggestion.
          inputs: { multiple: '11.5', 'suggestion.id': 'forged' },
        },
        201,
      ),
    );
    const before = valuationDetail.parse(
      await ok(f, 'ops.one', 'GET', `/api/v1/valuations/${byHand.id}`),
    );
    expect(before.inputs).toEqual({ multiple: '11.5' });
    const seen = await detail(f, 'ops.one', open.id);
    expect(seen.inProgress).toMatchObject({
      valuationId: byHand.id,
      periodEnd: early,
      state: 'Draft',
    });
    // With a Draft open, a second chain cannot be started.
    const refused = await command(f, 'ops.one', seen, { command: 'accept' });
    expect(refused.status).toBe(422);
    expect(problemOf(refused).code).toBe('workflow-precondition');

    const applied = await decided(f, 'ops.one', seen, { command: 'applyToDraft' });
    expect(applied).toMatchObject({ state: 'Accepted', valuationId: byHand.id });
    const after = valuationDetail.parse(
      await ok(f, 'ops.one', 'GET', `/api/v1/valuations/${byHand.id}`),
    );
    expect(after).toMatchObject({
      periodEnd: early,
      state: 'Draft',
      method: SPONSOR_MARK,
      fairValue: '38140000.00',
      rowVersion: byHand.rowVersion + 1,
    });
    expect(after.inputs.multiple).toBe('11.5');
    expect(after.inputs['suggestion.id']).toBe(open.id);
    expect(after.inputs['suggestion.periodEnd']).toBe(quarter);
  });

  it('takes neither command while the version is being approved', async () => {
    const { f, open } = await withStatement();
    const byHand = valuationRow.parse(
      await ok(
        f,
        'ops.two',
        'POST',
        '/api/v1/valuations',
        {
          investmentId: staleId,
          periodEnd: quarter,
          method: SPONSOR_MARK,
          fairValue: '39000000.00',
        },
        201,
      ),
    );
    await valuationCommand(f, 'ops.two', byHand.id, { command: 'prepare' });
    const seen = await detail(f, 'ops.one', open.id);
    expect(seen.inProgress?.state).toBe('OpsPrepared');
    for (const body of [{ command: 'accept' }, { command: 'applyToDraft' }]) {
      const refused = await command(f, 'ops.one', seen, body);
      expect(refused.status, body.command).toBe(422);
    }
    // Locked by hand: the Open suggestion is closed, and nothing replaces it.
    await valuationCommand(f, 'deal.one', byHand.id, { command: 'dealTeamApprove' });
    await valuationCommand(f, 'head.one', byHand.id, { command: 'lock' });
    const closed = await detail(f, 'ops.one', open.id);
    expect(closed).toMatchObject({
      state: 'Superseded',
      supersededReason: 'mark_locked',
      supersededById: null,
      decidedBy: null,
    });
    expect((await list(f, 'ops.one')).openCount).toBe(0);
  });

  it('sets a suggestion aside with a reason, and does not raise the same value again', async () => {
    const { f, state, open, statement } = await withStatement();
    const short = await command(f, 'ops.one', open, { command: 'dismiss', reason: 'no' });
    expect(short.status).toBe(400);
    expect(
      (await command(f, 'deal.one', open, { command: 'dismiss', reason: 'not mine' })).status,
    ).toBe(403);
    const dismissed = await decided(f, 'ops.one', open, {
      command: 'dismiss',
      reason: 'The sponsor restates this account next week.',
    });
    expect(dismissed).toMatchObject({
      state: 'Dismissed',
      decisionReason: 'The sponsor restates this account next week.',
      decidedBy: { id: userId('ops') },
      valuationId: null,
    });
    expect(state.audit.at(-1)).toMatchObject({
      action: 'valuation_suggestion.dismiss',
      reason: 'The sponsor restates this account next week.',
      from: 'Open',
      to: 'Dismissed',
    });
    // The report arrives: the statement still gives the value, and it was dismissed.
    const { report } = await staleRuns(f);
    await approve(f, 'deal.one', report.id);
    expect((await list(f, 'ops.one', '&state=all')).items.map((s) => s.state)).toEqual([
      'Dismissed',
    ]);
    for (const run of [report, statement])
      expect(await outcomeOf(f, 'ops.one', run.id), run.fileName).toMatchObject(
        run === statement
          ? { outcome: 'opened' }
          : { outcome: 'none', reason: 'dismissed', suggestionId: null },
      );
  });

  it('accepts nothing while the switch is off; reading and dismissing still work', async () => {
    const { f, open } = await withStatement();
    await ok(f, 'admin.one', 'PATCH', '/api/v1/flags/valuation.suggestions', {
      enabled: false,
      reason: 'test',
    });
    for (const body of [{ command: 'accept' }, { command: 'applyToDraft' }]) {
      const refused = await command(f, 'ops.one', open, body);
      expect(refused.status, body.command).toBe(409);
      expect(problemOf(refused)).toEqual({ code: 'kill-switch', detail: SUGGESTIONS_OFF_REFUSAL });
    }
    expect((await detail(f, 'deal.one', open.id)).state).toBe('Open');
    const dismissed = await decided(f, 'ops.one', open, {
      command: 'dismiss',
      reason: 'switched off for now',
    });
    expect(dismissed.state).toBe('Dismissed');
  });
});

describe('preview: figures that moved under an Open suggestion', () => {
  /** A session with the report-based suggestion of the stale position Open. */
  async function withReport(): Promise<Session & { open: ValuationSuggestionRow }> {
    const session = await ready();
    const { report } = await staleRuns(session.f);
    await approve(session.f, 'deal.one', report.id);
    const [open] = (await list(session.f, 'ops.one')).items;
    if (open === undefined) throw new Error('no open suggestion');
    expect(open.basis).toBe('sponsor_equity_value');
    return { ...session, open };
  }

  /** A cash flow booked this session on the stale position, after the last Locked mark: what a reconciled notice writes. */
  function bookFlow(state: PreviewState): void {
    state.notices = new Map([
      [
        'n1',
        {
          row: { id: 'n1', investmentId: staleId } as never,
          changed: true,
          flags: null,
          cashFlows: [
            {
              date: addDays(previousQuarter, 30),
              flowType: 'flow_type.contribution',
              amount: '-250000.00',
              status: APPROVED,
            },
          ],
          fundedBy: null,
        },
      ],
    ]);
  }

  it('replaces a suggestion whose figures changed at accept, keeps that, and answers 409', async () => {
    const { f, state, open } = await withReport();
    bookFlow(state);
    const refused = await command(f, 'ops.one', open, { command: 'accept' });
    expect(refused.status).toBe(409);
    expect(problemOf(refused)).toEqual({ code: 'conflict', detail: SUGGESTION_CHANGED_REFUSAL });
    const all = (await list(f, 'ops.one', '&state=all')).items;
    expect(all.map((s) => [s.state, s.reasonCode, s.supersededReason])).toEqual([
      ['Open', 'flows_since_reference_mark', null],
      ['Superseded', null, 'figures_changed'],
    ]);
    expect(all[1]?.supersededById).toBe(all[0]?.id);
    expect(all[0]?.suggestedValue).toBeNull();
    // No draft valuation was opened.
    expect([...(state.valuations?.values() ?? [])].filter((v) => v.origin === 'created')).toEqual(
      [],
    );
    // One with no value can be neither accepted nor put on a draft, and can be dismissed.
    const noValue = await command(f, 'ops.one', all[0]!, { command: 'accept' });
    expect(noValue.status).toBe(422);
    expect(
      (await decided(f, 'ops.one', all[0]!, { command: 'dismiss', reason: 'no value to use' }))
        .state,
    ).toBe('Dismissed');
  });

  it('derives it again when an import is promoted for the position, whoever approves it', async () => {
    const { f, state, open } = await withReport();
    bookFlow(state);
    const staged = intakeImportResult.parse(
      await ok(
        f,
        'ops.one',
        'POST',
        '/api/v1/intake/accounting',
        { fileName: 'clean.csv', csv: cleanExport },
        201,
      ),
    );
    expect(staged.rows.some((row) => row.investmentNumber === STALE)).toBe(true);
    // The Open suggestion stands until something derives it again.
    expect((await detail(f, 'ops.one', open.id)).state).toBe('Open');
    await ok(f, 'ops.two', 'POST', `/api/v1/intake/files/${staged.id}/commands`, {
      command: 'approve',
    });
    const after = await detail(f, 'ops.one', open.id);
    expect(after).toMatchObject({ state: 'Superseded', supersededReason: 'figures_changed' });
    expect((await detail(f, 'ops.one', after.supersededById!)).reasonCode).toBe(
      'flows_since_reference_mark',
    );
  });

  it('derives it again when the earlier mark is reopened: no figures for the mark that now stands', async () => {
    const { f, open } = await withReport();
    const earlierMark = dataset.valuations.find(
      (v) => v.investmentId === staleId && v.periodEnd === previousQuarter && v.state === 'Locked',
    );
    await valuationCommand(f, 'head.one', earlierMark?.id ?? '', {
      command: 'reopen',
      reason: 'The sponsor restated the quarter.',
    });
    const after = await detail(f, 'ops.one', open.id);
    expect(after).toMatchObject({ state: 'Superseded', supersededReason: 'figures_changed' });
    const now = await detail(f, 'ops.one', after.supersededById!);
    // The mark that now stands is two quarters old, and the record holds no figures for its quarter.
    expect(now).toMatchObject({
      state: 'Open',
      basis: 'sponsor_equity_value',
      suggestedValue: null,
      reasonCode: 'no_reference_figures',
      currentMark: { previousQuarter: false, ageQuarters: 2 },
      flags: { variance: false },
    });
    expect(now.currentMark?.periodEnd).toBe(
      latestQuarterEndOnOrBefore(addDays(previousQuarter, -1)),
    );
  });
});

describe('preview: a draft valuation started by hand', () => {
  it('stores no suggestion key a person sends', async () => {
    const { f } = setup();
    const row = valuationRow.parse(
      await ok(
        f,
        'ops.one',
        'POST',
        '/api/v1/valuations',
        {
          investmentId: staleId,
          periodEnd: quarter,
          method: SPONSOR_MARK,
          fairValue: '1.00',
          inputs: { [`${SUGGESTION_KEY_PREFIX}id`]: 'forged', note: 'by hand' },
        },
        201,
      ),
    );
    const read = valuationDetail.parse(
      await ok(f, 'ops.one', 'GET', `/api/v1/valuations/${row.id}`),
    );
    expect(read.inputs).toEqual({ note: 'by hand' });
  });
});
