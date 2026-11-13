import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLAN_METRICS,
  PLAN_METRIC_REASONS,
  PLAN_PATH_REASONS,
  PLAN_PROGRESS_REASONS,
  PLAN_STATUSES,
  UNDERWRITING_FORMS,
  underwritingComparison as calcComparison,
} from '@pb/calc';
import type { UnderwritingCase, UnderwritingInputs, UnderwritingTolerances } from '@pb/calc';
import { buildOpenApi } from './openapi.js';
import { ROUTES } from './routes.js';
import { UNDERWRITING_ROUTES } from './routes-underwriting.js';
import {
  UNDERWRITING_CASE_KINDS,
  UNDERWRITING_CASE_STATES,
  UNDERWRITING_MAX_POINTS,
  UNDERWRITING_REFUSALS,
  entryCaseOf,
  isCaseDateAllowed,
  isComparableVersion,
  underwritingBodyIssues,
  underwritingCaseBody,
  underwritingCaseVersion,
  underwritingCommandBody,
  underwritingComparison,
  underwritingForm,
  underwritingKindOf,
  underwritingMetric,
  underwritingQuery,
  underwritingRead,
  underwritingStatus,
} from './underwriting.js';
import type {
  UnderwritingCaseState,
  UnderwritingComparison,
  UnderwritingVersionRef,
} from './underwriting.js';

/*
 * The base case of a position as it travels (docs/04 M9, docs/08 section 11, docs/18 section 13,
 * decision 0022): the versions, the comparison the calculation library answers, and the rules a
 * page and the static preview share with the API.
 */

const INV = '30000000-0000-4000-8000-000000000001';
const CASE = '30000000-0000-4000-8000-0000000000d1';
const USER_A = '30000000-0000-4000-8000-0000000000a1';
const USER_B = '30000000-0000-4000-8000-0000000000a2';
const DOCUMENT = '30000000-0000-4000-8000-0000000000e1';

/** Golden fixture 28 of the calculation library: twelve comparisons by hand, equity and credit. */
interface Fixture {
  input: {
    tolerances: UnderwritingTolerances;
    cases: { case: UnderwritingCase; inputs: UnderwritingInputs }[];
  };
  expected: { results: unknown[] };
}
const fixture = JSON.parse(
  readFileSync(
    new URL('../../calc/fixtures/28_underwriting_comparison.json', import.meta.url),
    'utf8',
  ),
) as Fixture;

const version = {
  id: CASE,
  investmentId: INV,
  version: 1,
  form: 'equity',
  state: 'Confirmed',
  kind: 'entry',
  caseDate: '2021-06-30',
  plannedExitDate: '2026-06-30',
  exitMultiple: '11.000000',
  grossMoic: '2.500000',
  grossIrr: '0.20000000',
  underwrittenYield: null,
  annualLossRate: null,
  currency: 'USD',
  note: null,
  revisionReason: null,
  withdrawnReason: null,
  source: {
    document: { id: DOCUMENT, name: 'Sponsor base case model' },
    page: 4,
    locator: 'Returns!C14',
    note: null,
  },
  enteredBy: { id: USER_A, name: 'Dana One' },
  enteredAt: '2021-07-02T09:00:00.000Z',
  confirmedBy: { id: USER_B, name: 'Dana Two' },
  confirmedAt: '2021-07-03T09:00:00.000Z',
  points: [
    {
      periodEnd: '2021-06-30',
      revenueLtm: '200000000.00',
      ebitdaLtm: '40000000.00',
      netDebt: '150000000.00',
    },
    { periodEnd: '2026-06-30', revenueLtm: null, ebitdaLtm: '80000000.00', netDebt: null },
  ],
  rowVersion: 3,
};

describe('the comparison as it travels', () => {
  it('is what the calculation library answers, for every golden case and with nothing left over', () => {
    expect(fixture.input.cases.length).toBeGreaterThanOrEqual(12);
    const forms = new Set<string>();
    fixture.input.cases.forEach(({ case: base, inputs }, i) => {
      forms.add(base.form);
      // The schema is strict at every level: a field the library adds and the contract does not
      // know is refused here, and the typed assignment refuses one the contract adds.
      const answered: UnderwritingComparison = calcComparison(
        base,
        inputs,
        fixture.input.tolerances,
      );
      expect(underwritingComparison.parse(answered), String(i)).toEqual(answered);
      expect(underwritingComparison.parse(fixture.expected.results[i]), String(i)).toEqual(
        answered,
      );
    });
    expect([...forms].sort()).toEqual(['credit', 'equity']);
  });

  it('names its statuses, metrics, forms and reasons as the calculation library lists them', () => {
    expect(underwritingStatus.options).toEqual([...PLAN_STATUSES]);
    expect(underwritingMetric.options).toEqual([...PLAN_METRICS]);
    expect(underwritingForm.options).toEqual([...UNDERWRITING_FORMS]);
    const row = underwritingComparison.shape.metrics.element.shape;
    expect(row.notCalculable.unwrap().options).toEqual([...PLAN_METRIC_REASONS]);
    const progress = underwritingComparison.shape.valueCreation.unwrap().shape;
    expect(progress.notCalculable.unwrap().options).toEqual([...PLAN_PROGRESS_REASONS]);
    expect(underwritingComparison.shape.returns.shape.pathNotCalculable.unwrap().options).toEqual([
      ...PLAN_PATH_REASONS,
    ]);
  });

  it('keeps figures as decimal strings and null for a figure that is not calculable', () => {
    const base = calcComparison(
      fixture.input.cases[0]!.case,
      fixture.input.cases[0]!.inputs,
      fixture.input.tolerances,
    );
    expect(
      underwritingComparison.safeParse({
        ...base,
        returns: { ...base.returns, grossMoic: 2.45 },
      }).success,
    ).toBe(false);
    expect(
      underwritingComparison.safeParse({ ...base, returns: { ...base.returns, grossIrr: null } })
        .success,
    ).toBe(true);
    expect(underwritingComparison.safeParse({ ...base, score: '0.8' }).success).toBe(false);
    expect(underwritingComparison.safeParse({ ...base, headline: 'good' }).success).toBe(false);
  });
});

describe('a version of a base case', () => {
  it('carries its terms, its plan, its source, who entered and confirmed it and its row version', () => {
    expect(underwritingCaseVersion.parse(version)).toEqual(version);
    // A Draft: nobody has confirmed it and it may still lack a source.
    expect(
      underwritingCaseVersion.safeParse({
        ...version,
        state: 'Draft',
        confirmedBy: null,
        confirmedAt: null,
        source: { document: null, page: null, locator: null, note: null },
      }).success,
    ).toBe(true);
    // A loan: a yield and a loss rate, no exit multiple and no plan points.
    expect(
      underwritingCaseVersion.safeParse({
        ...version,
        form: 'credit',
        exitMultiple: null,
        underwrittenYield: '0.11000000',
        annualLossRate: '0.01000000',
        points: [],
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...version, state: 'Approved' },
      { ...version, kind: 'revision' },
      { ...version, form: 'primary' },
      { ...version, grossMoic: 2.5 },
      { ...version, enteredBy: USER_A },
      { ...version, extra: true },
      { ...version, rowVersion: '3' },
      { ...version, points: [{ ...version.points[0], ev: '400000000.00' }] },
      { ...version, source: { ...version.source, documentId: DOCUMENT } },
    ])
      expect(underwritingCaseVersion.safeParse(bad).success, JSON.stringify(bad).slice(-80)).toBe(
        false,
      );
    expect(UNDERWRITING_CASE_STATES).toEqual(['Draft', 'Confirmed', 'Superseded', 'Withdrawn']);
    expect(UNDERWRITING_CASE_KINDS).toEqual(['entry', 'correction', 'reunderwrite']);
  });
});

describe('the rules over the versions of a position', () => {
  const ref = (
    v: number,
    state: UnderwritingCaseState,
    caseDate: string,
  ): UnderwritingVersionRef => ({ version: v, state, caseDate });
  const kinds = (all: UnderwritingVersionRef[]) => all.map((v) => underwritingKindOf(v, all));

  it('reads the first case as the entry case, a same-dated version as its correction and a later one as a re-underwriting', () => {
    expect(kinds([ref(1, 'Confirmed', '2021-06-30')])).toEqual(['entry']);
    expect(kinds([ref(1, 'Superseded', '2021-06-30'), ref(2, 'Confirmed', '2021-06-30')])).toEqual([
      'entry',
      'correction',
    ]);
    expect(kinds([ref(1, 'Confirmed', '2021-06-30'), ref(2, 'Confirmed', '2023-06-30')])).toEqual([
      'entry',
      'reunderwrite',
    ]);
    // A Draft is read by what it will be once confirmed.
    expect(kinds([ref(1, 'Confirmed', '2021-06-30'), ref(2, 'Draft', '2021-06-30')])).toEqual([
      'entry',
      'correction',
    ]);
    expect(
      kinds([
        ref(1, 'Superseded', '2021-06-30'),
        ref(2, 'Superseded', '2021-06-30'),
        ref(3, 'Confirmed', '2021-06-30'),
        ref(4, 'Draft', '2024-03-31'),
      ]),
    ).toEqual(['entry', 'correction', 'correction', 'reunderwrite']);
  });

  it('never counts a withdrawn case: what follows it starts again as the entry case', () => {
    // A Draft that was withdrawn, and a case retired after it was confirmed in error.
    expect(kinds([ref(1, 'Withdrawn', '2021-06-30'), ref(2, 'Confirmed', '2021-06-30')])).toEqual([
      'entry',
      'entry',
    ]);
    expect(kinds([ref(1, 'Withdrawn', '2021-06-30'), ref(2, 'Confirmed', '2022-12-31')])).toEqual([
      'entry',
      'entry',
    ]);
    // The withdrawn one keeps the kind it had.
    expect(
      kinds([
        ref(1, 'Confirmed', '2021-06-30'),
        ref(2, 'Withdrawn', '2023-06-30'),
        ref(3, 'Confirmed', '2024-06-30'),
      ]),
    ).toEqual(['entry', 'reunderwrite', 'reunderwrite']);
  });

  it('compares the Confirmed case with the earliest case date, whatever its version number', () => {
    expect(entryCaseOf([])).toBeNull();
    expect(entryCaseOf([ref(1, 'Draft', '2021-06-30')])).toBeNull();
    expect(
      entryCaseOf([ref(1, 'Withdrawn', '2021-06-30'), ref(2, 'Superseded', '2021-06-30')]),
    ).toBeNull();
    const all = [
      ref(1, 'Superseded', '2021-06-30'),
      ref(2, 'Confirmed', '2023-06-30'),
      ref(3, 'Confirmed', '2021-06-30'),
      ref(4, 'Draft', '2020-01-01'),
    ];
    expect(entryCaseOf(all)).toBe(all[2]);
    // A reader may pick any version that stands or stood as the plan, and no other.
    expect(all.map(isComparableVersion)).toEqual([true, true, true, false]);
    expect(isComparableVersion(ref(1, 'Withdrawn', '2021-06-30'))).toBe(false);
  });
});

describe('the read of a position against its base case', () => {
  const thresholds = { onPlanTolerance: '0.05', irrTolerance: '0.02' };
  const comparison = calcComparison(
    fixture.input.cases[0]!.case,
    fixture.input.cases[0]!.inputs,
    fixture.input.tolerances,
  );
  const read = {
    asOf: '2024-06-30',
    form: 'equity',
    versions: [version],
    comparedVersion: 1,
    comparison,
    notCalculable: null,
    thresholds,
    calcVersion: '0.1.0',
  };

  it('answers the versions, the version compared and the comparison, or why there is none', () => {
    expect(underwritingRead.parse(read)).toEqual(read);
    for (const reason of ['no_case', 'draft_only'])
      expect(
        underwritingRead.safeParse({
          ...read,
          comparedVersion: null,
          comparison: null,
          notCalculable: reason,
        }).success,
        reason,
      ).toBe(true);
    // A position that holds no base case: no form and nothing else.
    expect(
      underwritingRead.safeParse({
        ...read,
        form: null,
        versions: [],
        comparedVersion: null,
        comparison: null,
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...read, notCalculable: 'not_confirmed' },
      { ...read, thresholds: { onPlanTolerance: 0.05, irrTolerance: 0.02 } },
      { ...read, thresholds: { onPlanTolerance: '0.05' } },
      { ...read, comparedVersion: '1' },
      { ...read, positions: [] },
    ])
      expect(underwritingRead.safeParse(bad).success, JSON.stringify(bad).slice(-60)).toBe(false);
  });

  it('takes an as-of date and a version number, and nothing else', () => {
    expect(underwritingQuery.parse({})).toEqual({});
    expect(underwritingQuery.parse({ asOf: '2024-06-30', version: '2' })).toEqual({
      asOf: '2024-06-30',
      version: 2,
    });
    for (const bad of [
      { asOf: '2024-02-30' },
      { version: '0' },
      { version: '1.5' },
      { version: 'latest' },
      { version: '-1' },
      { case: CASE },
    ])
      expect(underwritingQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('is in the route table for any signed-in reader, with its as-of date documented as a date', () => {
    const route = UNDERWRITING_ROUTES.find((r) => r.method === 'GET');
    expect(route?.path).toBe('/api/v1/investments/{id}/underwriting');
    expect(route?.roles).toEqual([]);
    expect(route?.auth).toBe(true);
    for (const r of UNDERWRITING_ROUTES) expect(ROUTES).toContain(r);
    const doc = buildOpenApi('0.1.0');
    const get = doc.paths['/api/v1/investments/{id}/underwriting']?.get as {
      parameters: { name: string; in: string; required: boolean; schema: { format?: string } }[];
    };
    expect(get.parameters.map((p) => `${p.in}:${p.name}:${String(p.required)}`)).toEqual([
      'path:id:true',
      'query:asOf:false',
      'query:version:false',
    ]);
    expect(get.parameters[1]?.schema.format).toBe('date');
  });
});

describe('recording a base case', () => {
  const point = (periodEnd: string, over: Record<string, unknown> = {}) => ({
    periodEnd,
    revenueLtm: '200000000.00',
    ebitdaLtm: '40000000.00',
    netDebt: '150000000.00',
    ...over,
  });
  const equity = {
    caseDate: '2021-06-30',
    plannedExitDate: '2026-06-30',
    exitMultiple: '11.0',
    grossMoic: '2.5',
    grossIrr: '0.2',
    points: [
      point('2021-06-30'),
      point('2023-06-30', { netDebt: null }),
      point('2026-06-30', { revenueLtm: null, netDebt: '-5000000.00' }),
    ],
  };
  const credit = {
    caseDate: '2021-06-30',
    plannedExitDate: '2026-06-30',
    grossMoic: '1.5',
    grossIrr: '0.1',
    underwrittenYield: '0.11',
    annualLossRate: '0.01',
  };
  const bounds = { revenueMin: '1000000', revenueMax: '50000000000' };
  const pathsOf = (body: unknown): string[] =>
    (underwritingCaseBody.safeParse(body).error?.issues ?? []).map((i) => i.path.join('.'));

  it('takes the terms, the plan points and the source in US dollars, as the columns store them', () => {
    expect(underwritingCaseBody.parse(equity)).toEqual(equity);
    expect(underwritingCaseBody.parse(credit)).toEqual(credit);
    const full = {
      ...equity,
      note: 'From the investment committee paper',
      revisionReason: 'The sponsor reissued the model',
      sourceDocumentId: DOCUMENT,
      sourcePage: 4,
      sourceLocator: 'Returns!C14',
      sourceNote: 'Also held in the deal folder',
    };
    expect(underwritingCaseBody.parse(full)).toEqual(full);
    // A currency code is read, so that the API can refuse another currency in words.
    for (const currency of ['USD', 'EUR'])
      expect(underwritingCaseBody.safeParse({ ...equity, currency }).success, currency).toBe(true);
    // A loss, net cash and an IRR below zero are figures a plan may hold.
    expect(
      underwritingCaseBody.safeParse({
        ...equity,
        grossIrr: '-0.05',
        points: [point('2021-06-30', { ebitdaLtm: '-1500000.00' }), point('2026-06-30')],
      }).success,
    ).toBe(true);
  });

  it('refuses a figure the columns would round, a date out of order and anything it does not know', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...equity, caseDate: '2021-02-30' }, 'caseDate'],
      [{ ...equity, plannedExitDate: '2021-06-30' }, 'plannedExitDate'],
      [{ ...equity, plannedExitDate: '2020-06-30' }, 'plannedExitDate'],
      [{ ...equity, exitMultiple: '0' }, 'exitMultiple'],
      [{ ...equity, exitMultiple: '11.0000001' }, 'exitMultiple'],
      [{ ...equity, exitMultiple: 11 }, 'exitMultiple'],
      [{ ...equity, grossMoic: '0.000000' }, 'grossMoic'],
      [{ ...equity, grossMoic: '-2.5' }, 'grossMoic'],
      [{ ...equity, grossMoic: undefined }, 'grossMoic'],
      [{ ...equity, grossIrr: '-1' }, 'grossIrr'],
      [{ ...equity, grossIrr: '20%' }, 'grossIrr'],
      [{ ...equity, grossIrr: '0.123456789' }, 'grossIrr'],
      [{ ...credit, underwrittenYield: '-1.5' }, 'underwrittenYield'],
      [{ ...credit, annualLossRate: '1.01' }, 'annualLossRate'],
      [{ ...credit, annualLossRate: '-0.01' }, 'annualLossRate'],
      [
        { ...equity, points: [point('2021-06-30', { revenueLtm: '200000000.005' })] },
        'points.0.revenueLtm',
      ],
      [{ ...equity, points: [point('2021-06-30', { ebitdaLtm: 40000000 })] }, 'points.0.ebitdaLtm'],
      [{ ...equity, points: [point('2021-06-30', { netDebt: '1e9' })] }, 'points.0.netDebt'],
      [{ ...equity, points: [point('2021-06-30', { ev: '400000000.00' })] }, 'points.0'],
      [
        {
          ...equity,
          points: [point('2021-06-30', { revenueLtm: null, ebitdaLtm: null, netDebt: null })],
        },
        'points.0',
      ],
      [{ ...equity, points: [point('2023-06-30'), point('2021-06-30')] }, 'points.1.periodEnd'],
      [{ ...equity, points: [point('2021-06-30'), point('2021-06-30')] }, 'points.1.periodEnd'],
      [{ ...equity, note: '' }, 'note'],
      [{ ...equity, revisionReason: 'no' }, 'revisionReason'],
      [{ ...equity, sourceDocumentId: 'the model' }, 'sourceDocumentId'],
      [{ ...equity, sourcePage: 4 }, 'sourcePage'],
      [{ ...equity, sourceLocator: 'Returns!C14' }, 'sourceLocator'],
      [{ ...equity, sourceDocumentId: DOCUMENT, sourcePage: 0 }, 'sourcePage'],
      [{ ...equity, sourceNote: 'x' }, 'sourceNote'],
      [{ ...equity, form: 'equity' }, ''],
      [{ ...equity, state: 'Confirmed' }, ''],
      [{ ...equity, confirmedBy: USER_B }, ''],
      [{ ...equity, currency: 'euro' }, 'currency'],
      [{ ...equity, currency: 'usd' }, 'currency'],
    ];
    for (const [body, path] of cases)
      expect(pathsOf(body), JSON.stringify(body).slice(-70)).toEqual([path]);
    expect(
      pathsOf({
        ...equity,
        points: Array.from({ length: UNDERWRITING_MAX_POINTS + 1 }, (_, i) =>
          point(`${String(2000 + i)}-06-30`),
        ),
      }),
    ).toEqual(['points']);
  });

  it('judges what a body needs by the form of its position', () => {
    expect(underwritingBodyIssues('equity', underwritingCaseBody.parse(equity), bounds)).toEqual(
      [],
    );
    expect(underwritingBodyIssues('credit', underwritingCaseBody.parse(credit), bounds)).toEqual(
      [],
    );
    const paths = (form: 'equity' | 'credit', body: Record<string, unknown>): string[] =>
      underwritingBodyIssues(form, underwritingCaseBody.parse(body), bounds).map((i) => i.path);
    // Equity: an exit multiple and a plan that ends on the planned exit; nothing of a loan's.
    expect(paths('equity', { ...equity, exitMultiple: undefined })).toEqual(['exitMultiple']);
    expect(paths('equity', { ...equity, points: undefined })).toEqual(['points']);
    expect(paths('equity', { ...equity, points: [point('2026-06-30')] })).toEqual(['points']);
    expect(
      paths('equity', { ...equity, points: [point('2021-06-30'), point('2025-06-30')] }),
    ).toEqual(['points.1.periodEnd']);
    expect(paths('equity', { ...equity, ...credit, exitMultiple: '11.0' })).toEqual([
      'underwrittenYield',
      'annualLossRate',
    ]);
    // A loan: a yield; no exit multiple and no plan points.
    expect(paths('credit', { ...credit, underwrittenYield: undefined })).toEqual([
      'underwrittenYield',
    ]);
    expect(paths('credit', equity)).toEqual(['underwrittenYield', 'exitMultiple', 'points']);
    expect(paths('credit', { ...credit, points: [] })).toEqual([]);
  });

  it('refuses revenue outside the bounds of config, so a figure typed in millions is never guessed', () => {
    const issues = (revenueLtm: string | null) =>
      underwritingBodyIssues(
        'equity',
        underwritingCaseBody.parse({
          ...equity,
          points: [point('2021-06-30', { revenueLtm }), point('2026-06-30')],
        }),
        bounds,
      );
    expect(issues('200')).toEqual([
      {
        path: 'points.0.revenueLtm',
        message: 'Revenue is in US dollars, between 1000000 and 50000000000',
      },
    ]);
    expect(issues('999999.99')).toHaveLength(1);
    expect(issues('50000000000.01')).toHaveLength(1);
    expect(issues('-200000000.00')).toHaveLength(1);
    // The edges are inside, and a point without revenue has nothing to judge.
    expect(issues('1000000')).toEqual([]);
    expect(issues('50000000000.00')).toEqual([]);
    expect(issues(null)).toEqual([]);
    // The bounds are read as they are configured: numbers that came through a decimal, or text.
    expect(
      underwritingBodyIssues('equity', underwritingCaseBody.parse(equity), {
        revenueMin: '250000000',
        revenueMax: '50000000000',
      }).map((i) => i.path),
    ).toEqual(['points.0.revenueLtm', 'points.1.revenueLtm']);
  });

  it('dates a new version as a Confirmed case, which it corrects, or later than every one of them', () => {
    const ref = (
      v: number,
      state: UnderwritingCaseState,
      caseDate: string,
    ): UnderwritingVersionRef => ({
      version: v,
      state,
      caseDate,
    });
    // Nothing Confirmed: any date stands, a Draft and a withdrawn case constrain nothing.
    expect(isCaseDateAllowed('2021-06-30', [])).toBe(true);
    expect(
      isCaseDateAllowed('2019-01-01', [
        ref(1, 'Withdrawn', '2021-06-30'),
        ref(2, 'Superseded', '2021-06-30'),
        ref(3, 'Draft', '2022-06-30'),
      ]),
    ).toBe(true);
    const confirmed = [ref(1, 'Confirmed', '2021-06-30'), ref(2, 'Confirmed', '2023-06-30')];
    expect(isCaseDateAllowed('2021-06-30', confirmed)).toBe(true);
    expect(isCaseDateAllowed('2023-06-30', confirmed)).toBe(true);
    expect(isCaseDateAllowed('2023-07-01', confirmed)).toBe(true);
    expect(isCaseDateAllowed('2022-06-30', confirmed)).toBe(false);
    expect(isCaseDateAllowed('2021-06-29', confirmed)).toBe(false);
  });

  it('takes confirm, withdraw and retire from a person, the last two with a reason, and never supersede', () => {
    expect(underwritingCommandBody.parse({ command: 'confirm' })).toEqual({ command: 'confirm' });
    for (const command of ['withdraw', 'retire']) {
      const body = { command, reason: 'Entered from the wrong sponsor model' };
      expect(underwritingCommandBody.parse(body)).toEqual(body);
      expect(underwritingCommandBody.safeParse({ command }).success, command).toBe(false);
      expect(underwritingCommandBody.safeParse({ command, reason: 'no' }).success, command).toBe(
        false,
      );
    }
    for (const bad of [
      { command: 'supersede' },
      { command: 'confirm', reason: 'Checked against the model' },
      { command: 'confirm', confirmedBy: USER_B },
      { command: 'edit' },
      {},
    ])
      expect(underwritingCommandBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('words the refusals of a create and an edit as the state machine words its own', () => {
    for (const [key, refusal] of Object.entries(UNDERWRITING_REFUSALS)) {
      const text = typeof refusal === 'function' ? refusal('Confirmed') : refusal;
      expect(text, key).toMatch(/^underwriting_case: \S/);
      expect(text, key).not.toContain(String.fromCharCode(0x2014));
    }
    expect(UNDERWRITING_REFUSALS.notDraft('Superseded')).toBe(
      'underwriting_case: edit is not allowed from Superseded; only a Draft can be edited',
    );
  });

  it('is in the route table: a create and an edit for the deal team, commands for the deal team and approvers', () => {
    const routes = UNDERWRITING_ROUTES.map((r) => ({
      route: `${r.method} ${r.path}`,
      roles: [...r.roles],
      idempotent: r.idempotent === true,
      ifMatch: r.ifMatch ?? null,
      status: r.responseStatus ?? 200,
    }));
    expect(routes).toEqual([
      {
        route: 'GET /api/v1/investments/{id}/underwriting',
        roles: [],
        idempotent: false,
        ifMatch: null,
        status: 200,
      },
      {
        route: 'POST /api/v1/investments/{id}/underwriting',
        roles: ['deal_team'],
        idempotent: true,
        ifMatch: null,
        status: 201,
      },
      {
        route: 'PATCH /api/v1/underwriting-cases/{id}',
        roles: ['deal_team'],
        idempotent: true,
        ifMatch: 'underwriting_case',
        status: 200,
      },
      {
        route: 'POST /api/v1/underwriting-cases/{id}/commands',
        roles: ['deal_team', 'approver'],
        idempotent: true,
        ifMatch: 'underwriting_case',
        status: 200,
      },
    ]);
    for (const r of UNDERWRITING_ROUTES) {
      expect(ROUTES, r.path).toContain(r);
      if (r.method !== 'GET') expect(r.response, r.path).toBe(underwritingCaseVersion);
    }
  });
});
