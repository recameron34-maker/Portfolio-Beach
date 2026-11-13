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
  entryCaseOf,
  isComparableVersion,
  underwritingCaseVersion,
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
