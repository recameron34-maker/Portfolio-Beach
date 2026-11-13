import { CALC_VERSION, underwritingComparison } from '@pb/calc';
import type { UnderwritingInputs } from '@pb/calc';
import { underwritingKindOf } from '@pb/contracts';
import type { UnderwritingCaseVersion, UnderwritingRead } from '@pb/contracts';
import { ID } from '../../test/fixtures.js';

/*
 * Contract-shaped synthetic fixtures for the base case card (synthetic data only). One company,
 * Saltmarsh Holdings, as of 2023-06-30. Its plan runs from 2021-06-30 to a planned exit on
 * 2026-06-30 at 11.0x; between the plan dates 2022-12-31 and 2023-12-31 the quarter of 2023-06-30
 * sits on day 181 of 365, where the plan reads 300.0 of revenue, 70.0 of EBITDA and 118.0 of net
 * debt (millions). The quarter's own 320.0, 65.0 and 120.0 are 6.7% ahead, 7.1% behind and 1.7%
 * over (on plan). The company's bridge has earned 250 + 65 + 30 of a planned 400 + 80 + 50. We put
 * in 10.0 on 2021-06-30 and took 1.0 out 730 days later with 12.0 still held: a MOIC of 1.30
 * against 1.44 on the 20% path. Every comparison is the calculation library's own answer over
 * these inputs, as the API answers it; the tests state the figures they expect by hand.
 */

export const UW_AS_OF = '2023-06-30';
export const UW_INVESTMENT = ID.inv1;

export const UW_ID = {
  entry: '00000000-0000-4000-8000-0000000005a1',
  second: '00000000-0000-4000-8000-0000000005a2',
  third: '00000000-0000-4000-8000-0000000005a3',
  document: '00000000-0000-4000-8000-00000000d101',
} as const;

export const UW_PERSON = {
  entered: { id: '00000000-0000-4000-8000-000000000302', name: 'Blake Okafor' },
  confirmed: { id: '00000000-0000-4000-8000-000000000305', name: 'Finley Castellano' },
  approver: { id: '00000000-0000-4000-8000-000000000303', name: 'Morgan Lindqvist' },
} as const;

export const UW_PATH = `/api/v1/investments/${UW_INVESTMENT}/underwriting`;
export const UW_THRESHOLDS = { onPlanTolerance: '0.05', irrTolerance: '0.02' } as const;

/** The entry case: Confirmed, version 1, with a note on where the model is held as its source. */
export function caseFixture(
  overrides: Partial<UnderwritingCaseVersion> = {},
): UnderwritingCaseVersion {
  return {
    id: UW_ID.entry,
    investmentId: UW_INVESTMENT,
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
      document: null,
      page: null,
      locator: null,
      note: 'Sponsor base case model at entry, held in the deal folder',
    },
    enteredBy: UW_PERSON.entered,
    enteredAt: '2021-07-06T10:00:00.000Z',
    confirmedBy: UW_PERSON.confirmed,
    confirmedAt: '2021-07-08T15:00:00.000Z',
    points: [
      {
        periodEnd: '2021-06-30',
        revenueLtm: '200000000.00',
        ebitdaLtm: '40000000.00',
        netDebt: '150000000.00',
      },
      {
        periodEnd: '2022-12-31',
        revenueLtm: '281900000.00',
        ebitdaLtm: '66380000.00',
        netDebt: '121620000.00',
      },
      {
        periodEnd: '2023-12-31',
        revenueLtm: '318400000.00',
        ebitdaLtm: '73680000.00',
        netDebt: '114320000.00',
      },
      {
        periodEnd: '2026-06-30',
        revenueLtm: '400000000.00',
        ebitdaLtm: '80000000.00',
        netDebt: '100000000.00',
      },
    ],
    rowVersion: 2,
    ...overrides,
  };
}

/** What the comparison is worked out from: the entry snapshot, three approved quarters, the bridge and our flows. */
export function inputsFixture(overrides: Partial<UnderwritingInputs> = {}): UnderwritingInputs {
  const current = {
    periodEnd: '2023-06-30',
    revenueLtm: '320000000.00',
    ebitdaLtm: '65000000.00',
    netDebt: '120000000.00',
  };
  return {
    asOf: UW_AS_OF,
    isActive: true,
    entry: {
      periodEnd: '2021-06-30',
      ebitdaLtm: '40000000.00',
      ev: '400000000.00',
      netDebt: '150000000.00',
    },
    current,
    quarters: [
      {
        periodEnd: '2022-12-31',
        revenueLtm: '290000000.00',
        ebitdaLtm: '60000000.00',
        netDebt: '125000000.00',
      },
      // No approved EBITDA in March: a gap in the line, never a zero.
      {
        periodEnd: '2023-03-31',
        revenueLtm: '310000000.00',
        ebitdaLtm: null,
        netDebt: '122000000.00',
      },
      current,
    ],
    bridge: {
      ebitdaGrowth: '250000000',
      multipleExpansion: '65000000',
      debtPaydown: '30000000',
      total: '345000000',
    },
    bridgeNotCalculable: null,
    flows: [
      { date: '2021-06-30', amount: '-10000000' },
      { date: '2023-06-30', amount: '1000000' },
    ],
    invested: '10000000',
    distributions: '1000000',
    grossMoic: '1.3',
    grossIrr: '0.1401754251',
    irrFlag: null,
    yieldToMaturity: null,
    ...overrides,
  };
}

/** The kind of every version, as the API derives it from the versions themselves. */
export function withKinds(versions: readonly UnderwritingCaseVersion[]): UnderwritingCaseVersion[] {
  return versions.map((v) => ({ ...v, kind: underwritingKindOf(v, versions) }));
}

/**
 * The read as the API answers it for the versions given, compared with the one named (the first
 * by default): the calculation library's own comparison of that version with the inputs.
 */
export function readFixture(
  options: {
    versions?: readonly UnderwritingCaseVersion[];
    compared?: number | null;
    inputs?: Partial<UnderwritingInputs>;
  } = {},
): UnderwritingRead {
  const versions = withKinds(options.versions ?? [caseFixture()]);
  const compared =
    options.compared === null
      ? undefined
      : versions.find((v) => v.version === (options.compared ?? versions[0]?.version));
  const base = {
    asOf: UW_AS_OF,
    form: 'equity' as const,
    versions,
    thresholds: { ...UW_THRESHOLDS },
    calcVersion: CALC_VERSION,
  };
  if (compared === undefined)
    return {
      ...base,
      comparedVersion: null,
      comparison: null,
      notCalculable: versions.some((v) => v.state === 'Draft') ? 'draft_only' : 'no_case',
    };
  return {
    ...base,
    comparedVersion: compared.version,
    comparison: underwritingComparison(compared, inputsFixture(options.inputs), UW_THRESHOLDS),
    notCalculable: null,
  };
}

/** A position that holds no base case (a primary fund): the API answers nothing else. */
export function noFormFixture(): UnderwritingRead {
  return {
    asOf: UW_AS_OF,
    form: null,
    versions: [],
    comparedVersion: null,
    comparison: null,
    notCalculable: null,
    thresholds: { ...UW_THRESHOLDS },
    calcVersion: CALC_VERSION,
  };
}

/** A Draft a second person has yet to confirm: nobody confirmed it, and it names its source. */
export function draftFixture(
  overrides: Partial<UnderwritingCaseVersion> = {},
): UnderwritingCaseVersion {
  return caseFixture({
    state: 'Draft',
    confirmedBy: null,
    confirmedAt: null,
    rowVersion: 1,
    ...overrides,
  });
}

/** A re-underwriting two years on, at a lower exit multiple and with a document as its source. */
export function reunderwriteFixture(
  overrides: Partial<UnderwritingCaseVersion> = {},
): UnderwritingCaseVersion {
  return caseFixture({
    id: UW_ID.second,
    version: 2,
    caseDate: '2023-03-31',
    exitMultiple: '10.000000',
    grossMoic: '2.200000',
    grossIrr: '0.17000000',
    revisionReason: 'Sponsor re-underwrote after the 2022 acquisition',
    source: {
      document: { id: UW_ID.document, name: 'Saltmarsh Holdings sponsor model 2023' },
      page: 12,
      locator: 'Base case!B14',
      note: null,
    },
    enteredAt: '2023-04-10T09:00:00.000Z',
    confirmedAt: '2023-04-12T09:00:00.000Z',
    points: [
      {
        periodEnd: '2023-03-31',
        revenueLtm: '300000000.00',
        ebitdaLtm: '62000000.00',
        netDebt: '124000000.00',
      },
      {
        periodEnd: '2026-06-30',
        revenueLtm: '380000000.00',
        ebitdaLtm: '76000000.00',
        netDebt: '104000000.00',
      },
    ],
    ...overrides,
  });
}
