import { valuationSuggestionPage, valuationSuggestionRow } from '@pb/contracts';
import type {
  SuggestionRunOutcome,
  ValuationSuggestionPage,
  ValuationSuggestionRow,
} from '@pb/contracts';
import { ID } from './fixtures.js';
import { PERSON, PRIOR_PERIOD, VAL_ID } from './fixtures-valuations.js';

/*
 * Contract-shaped synthetic fixtures for the valuation suggestions (docs/12 section 4: synthetic
 * data only). The figures are the worked examples of docs/08 section 12: example 1 for the
 * statement (our own account, US$ millions), examples 4 and 7 for the sponsor report beside it.
 */

export const SUGGESTION_ID = {
  statement: '00000000-0000-4000-8000-000000000801',
  report: '00000000-0000-4000-8000-000000000802',
  notCalculable: '00000000-0000-4000-8000-000000000803',
  replacement: '00000000-0000-4000-8000-000000000804',
} as const;

export const SOURCE = {
  statementDocument: '00000000-0000-4000-8000-000000000811',
  reportDocument: '00000000-0000-4000-8000-000000000812',
  /** The statement run of pages/extraction/test-fixtures.ts (STATEMENT_RUN_ID). */
  statementRun: '00000000-0000-4000-8000-000000000705',
  reportRun: '00000000-0000-4000-8000-000000000813',
  recordQuarter: '00000000-0000-4000-8000-000000000814',
} as const;

export const STATEMENT_FILE =
  '2025-06-30 Kelpwood Fund IV - Capital account statement - Meridian Data Partners.pdf';
export const REPORT_FILE = '2025-06-30 Meridian Data Partners - Quarterly report.pdf';

const QUARTER = '2025-06-30';

/**
 * Example 1 of docs/08 section 12: our own account ends at 20.94 against a previous quarter's
 * mark of 18.42, so the change is at the variance flag; the lines tie and the contributions to
 * date agree with the record. No other source is on hand.
 */
export function suggestionFixture(
  overrides: Partial<ValuationSuggestionRow> = {},
): ValuationSuggestionRow {
  const row: ValuationSuggestionRow = {
    id: SUGGESTION_ID.statement,
    investmentId: ID.inv1,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    vehicleName: 'Beach Co-Invest Fund I',
    dealType: 'deal_type.co_invest_equity',
    periodEnd: QUARTER,
    basis: 'capital_account_balance',
    method: 'valuation_method.sponsor_mark',
    suggestedValue: '20940000.00',
    reasonCode: null,
    workings: {
      inputs: [
        {
          key: 'ending_capital_balance',
          value: '20940000',
          periodEnd: QUARTER,
          source: {
            kind: 'document',
            id: SOURCE.statementDocument,
            page: 1,
            fileName: STATEMENT_FILE,
          },
          edited: false,
        },
      ],
    },
    source: {
      documentId: SOURCE.statementDocument,
      fileName: STATEMENT_FILE,
      extractionRunId: SOURCE.statementRun,
      page: 1,
      locator: null,
    },
    sourceReviewerIds: [PERSON.opsTwo.id],
    promptVersion: '1',
    modelId: 'mock',
    calcVersion: '1',
    state: 'Open',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    valuationId: null,
    supersededReason: null,
    supersededById: null,
    createdAt: '2025-08-01T10:00:00.000Z',
    rowVersion: 1,
    currentMark: {
      valuationId: VAL_ID.priorLocked,
      value: '18420000.00',
      periodEnd: PRIOR_PERIOD,
      reportsFor: PRIOR_PERIOD,
      previousQuarter: true,
      ageQuarters: 1,
    },
    comparison: {
      change: '2520000',
      changePct: '0.1368078176',
      variance: true,
      netOfFlows: '870000',
      netOfFlowsPct: '0.0472312704',
      beginningBalance: '18420000',
    },
    checks: {
      ties: true,
      tieDifference: '0',
      tieToleranceUsd: '25000',
      ownAccount: true,
      contributionsCheck: {
        statement: '12400000',
        record: '12400000',
        difference: '0',
        differencePct: '0',
        differs: false,
        notChecked: null,
      },
    },
    crossChecks: [],
    inProgress: null,
    flags: {
      variance: true,
      ties: true,
      contributionsDiffer: false,
      sourcesDiffer: false,
      editedByReviewer: false,
    },
    ...overrides,
  };
  // A fixture the contract would refuse proves nothing about a page that parses the answer.
  return valuationSuggestionRow.parse(row);
}

/**
 * Examples 4 and 7: the sponsor report scales the last Locked mark of 7,310,450.25 to
 * 7,831,632.54 (no variance), and a statement for the quarter gives 7,810,000.00 beside it.
 */
export function reportSuggestionFixture(
  overrides: Partial<ValuationSuggestionRow> = {},
): ValuationSuggestionRow {
  const record = { kind: 'record' as const, id: SOURCE.recordQuarter, page: null, fileName: null };
  const page = (n: number) => ({
    kind: 'document' as const,
    id: SOURCE.reportDocument,
    page: n,
    fileName: REPORT_FILE,
  });
  return suggestionFixture({
    id: SUGGESTION_ID.report,
    investmentId: ID.inv2,
    investmentNumber: 'INV-0002',
    companyName: 'Juniper Financial Group',
    basis: 'sponsor_equity_value',
    method: 'valuation_method.report_indication',
    suggestedValue: '7831632.54',
    workings: {
      inputs: [
        {
          key: 'reference_mark',
          value: '7310450.25',
          periodEnd: '2025-03-28',
          source: { kind: 'valuation', id: VAL_ID.priorOther, page: null, fileName: null },
          edited: false,
        },
        {
          key: 'reference_enterprise_value',
          value: '413000000',
          periodEnd: PRIOR_PERIOD,
          source: record,
          edited: false,
        },
        {
          key: 'reference_net_debt',
          value: '150000000',
          periodEnd: PRIOR_PERIOD,
          source: record,
          edited: false,
        },
        {
          key: 'enterprise_value',
          value: '428050000',
          periodEnd: QUARTER,
          source: page(3),
          edited: false,
        },
        {
          key: 'net_debt',
          value: '146300000',
          periodEnd: QUARTER,
          source: { kind: 'reviewer', id: PERSON.deal.id, page: null, fileName: null },
          edited: true,
        },
      ],
    },
    source: {
      documentId: SOURCE.reportDocument,
      fileName: REPORT_FILE,
      extractionRunId: SOURCE.reportRun,
      page: 3,
      locator: null,
    },
    currentMark: {
      valuationId: VAL_ID.priorOther,
      value: '7310450.25',
      periodEnd: '2025-03-28',
      reportsFor: PRIOR_PERIOD,
      previousQuarter: true,
      ageQuarters: 1,
    },
    comparison: {
      change: '521182.29',
      changePct: '0.0712927757',
      variance: false,
      netOfFlows: null,
      netOfFlowsPct: null,
      beginningBalance: null,
    },
    checks: null,
    crossChecks: [
      {
        basis: 'capital_account_balance',
        value: '7810000',
        reason: null,
        difference: '-21632.54',
        differencePct: '-0.0027621494',
        differs: false,
      },
    ],
    flags: {
      variance: false,
      ties: null,
      contributionsDiffer: false,
      sourcesDiffer: false,
      editedByReviewer: true,
    },
    ...overrides,
  });
}

/** A statement with no ending balance for our account, and nothing else on hand: not calculable. */
export function notCalculableFixture(
  overrides: Partial<ValuationSuggestionRow> = {},
): ValuationSuggestionRow {
  return suggestionFixture({
    id: SUGGESTION_ID.notCalculable,
    investmentId: ID.inv3,
    investmentNumber: 'INV-0003',
    companyName: 'Ashby Industrial Holdings',
    suggestedValue: null,
    reasonCode: 'no_ending_balance',
    workings: { inputs: [] },
    comparison: {
      change: null,
      changePct: null,
      variance: false,
      netOfFlows: null,
      netOfFlowsPct: null,
      beginningBalance: null,
    },
    checks: {
      ties: null,
      tieDifference: null,
      tieToleranceUsd: '25000',
      ownAccount: true,
      contributionsCheck: {
        statement: null,
        record: '9000000',
        difference: null,
        differencePct: null,
        differs: null,
        notChecked: 'contributions_not_stated',
      },
    },
    crossChecks: [
      {
        basis: 'sponsor_equity_value',
        value: null,
        reason: 'flows_since_reference_mark',
        difference: null,
        differencePct: null,
        differs: false,
      },
    ],
    flags: {
      variance: false,
      ties: null,
      contributionsDiffer: false,
      sourcesDiffer: false,
      editedByReviewer: false,
    },
    ...overrides,
  });
}

export function suggestionPageFixture(
  items: ValuationSuggestionRow[] = [suggestionFixture(), reportSuggestionFixture()],
  overrides: Partial<ValuationSuggestionPage> = {},
): ValuationSuggestionPage {
  return valuationSuggestionPage.parse({
    items,
    nextCursor: null,
    openCount: items.filter((row) => row.state === 'Open').length,
    runOutcome: null,
    ...overrides,
  });
}

/** The answer to a list asked by run: what the run did, and the suggestions it produced. */
export function runOutcomePageFixture(
  outcome: SuggestionRunOutcome,
  items: ValuationSuggestionRow[] = [],
): ValuationSuggestionPage {
  return suggestionPageFixture(items, { runOutcome: outcome });
}

/** The switch as GET /flags lists it. */
export function suggestionsFlagFixture(enabled: boolean): {
  flags: { key: string; enabled: boolean; description: string }[];
} {
  return {
    flags: [
      {
        key: 'valuation.suggestions',
        enabled,
        description: 'Valuation suggestions from approved statements and sponsor reports',
      },
    ],
  };
}
