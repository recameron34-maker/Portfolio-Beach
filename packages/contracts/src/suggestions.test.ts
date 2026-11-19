import { describe, expect, it } from 'vitest';
import {
  SUGGESTION_BASES,
  SUGGESTION_REASONS,
  markComparison,
  sourceCrossCheck,
  statementMark,
} from '@pb/calc';
import { ROUTES } from './routes.js';
import {
  suggestionBasis,
  suggestionChecks,
  suggestionComparison,
  suggestionCrossCheck,
  suggestionReason,
  suggestionRunOutcome,
  valuationSuggestionCommandBody,
  valuationSuggestionListQuery,
  valuationSuggestionPage,
  valuationSuggestionRow,
} from './suggestions.js';

/*
 * The valuation suggestion contract (docs/04 M10, docs/08 section 12, docs/18 section 14,
 * decision 0023): what the calculation library answers travels as it is, the list is Open unless
 * asked otherwise, and the three commands a person sends are the only ones the body takes.
 */

const ID = '7f000000-0000-4000-8000-000000000001';
const OTHER = '7f000000-0000-4000-8000-000000000002';

/** A statement-based suggestion as the API answers it: example 1 of docs/08 section 12. */
function exampleRow(): Record<string, unknown> {
  const mark = statementMark(
    {
      beginningBalance: '18420000',
      contributionsInPeriod: '2000000',
      distributionsInPeriod: '350000',
      netGainLoss: '870000',
      endingBalance: '20940000',
      contributionsToDate: '12400000',
      share: null,
    },
    '12400000',
    { tieToleranceUsd: '25000', contributionsTolerancePct: '0.02' },
  );
  const comparison = markComparison({
    suggested: mark.value,
    current: '18420000.00',
    currentIsPreviousQuarter: true,
    varianceFlag: '0.1',
    statement: { ...mark.ours, tieToleranceUsd: '25000' },
  });
  return {
    id: ID,
    investmentId: OTHER,
    investmentNumber: 'INV-0931',
    companyName: 'Harrowgate Logistics',
    vehicleName: 'Co-Invest Fund II',
    dealType: 'deal_type.co_invest_equity',
    periodEnd: '2025-09-30',
    basis: mark.basis,
    method: mark.method,
    suggestedValue: '20940000.00',
    reasonCode: null,
    workings: {
      inputs: [
        {
          key: 'ending_capital_balance',
          value: '20940000',
          periodEnd: '2025-09-30',
          source: { kind: 'document', id: OTHER, page: 1, fileName: 'statement.pdf' },
          edited: false,
        },
      ],
    },
    source: {
      documentId: OTHER,
      fileName: 'statement.pdf',
      extractionRunId: OTHER,
      page: 1,
      locator: 'field:ending_capital_balance',
    },
    sourceReviewerIds: [OTHER],
    promptVersion: '1',
    modelId: 'mock',
    calcVersion: '0.1.0',
    state: 'Open',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    valuationId: null,
    supersededReason: null,
    supersededById: null,
    createdAt: '2025-10-20T09:00:00.000Z',
    rowVersion: 1,
    currentMark: {
      valuationId: OTHER,
      value: '18420000.00',
      periodEnd: '2025-06-30',
      reportsFor: '2025-06-30',
      previousQuarter: true,
      ageQuarters: 1,
    },
    comparison,
    checks: {
      ties: mark.ties,
      tieDifference: mark.tieDifference,
      tieToleranceUsd: '25000',
      ownAccount: mark.ownAccount,
      contributionsCheck: mark.contributionsCheck,
    },
    crossChecks: [
      {
        basis: 'sponsor_equity_value',
        value: '20100000.00',
        reason: null,
        ...sourceCrossCheck('20100000.00', mark.value, '0.1'),
      },
      {
        basis: 'held_multiple',
        value: null,
        reason: 'no_ebitda',
        ...sourceCrossCheck(null, mark.value, '0.1'),
      },
    ],
    inProgress: null,
    flags: {
      variance: comparison.variance,
      ties: mark.ties,
      contributionsDiffer: false,
      sourcesDiffer: false,
      editedByReviewer: false,
    },
  };
}

describe('the valuation suggestion contract', () => {
  it('names the bases and the reasons of the calculation library, in its order', () => {
    expect(suggestionBasis.options).toEqual([...SUGGESTION_BASES]);
    expect(suggestionReason.options).toEqual([...SUGGESTION_REASONS]);
  });

  it('takes a suggestion as the calculation library answers it, figure by figure', () => {
    const row = exampleRow();
    const parsed = valuationSuggestionRow.parse(row);
    expect(parsed).toEqual(row);
    expect(parsed.comparison).toMatchObject({
      change: '2520000',
      changePct: '0.1368078176',
      variance: true,
      netOfFlows: '870000',
      netOfFlowsPct: '0.0472312704',
    });
    expect(suggestionComparison.parse(parsed.comparison)).toEqual(parsed.comparison);
    expect(suggestionChecks.parse(parsed.checks)).toEqual(parsed.checks);
    for (const check of parsed.crossChecks)
      expect(suggestionCrossCheck.parse(check)).toEqual(check);
  });

  it('takes a suggestion with no value: the reason in its place, and nothing compared', () => {
    const comparison = markComparison({
      suggested: null,
      current: '18420000.00',
      currentIsPreviousQuarter: true,
      varianceFlag: '0.1',
      statement: null,
    });
    const row = {
      ...exampleRow(),
      suggestedValue: null,
      reasonCode: 'no_ending_balance',
      comparison,
    };
    expect(valuationSuggestionRow.parse(row).comparison.change).toBeNull();
    expect(valuationSuggestionRow.safeParse({ ...row, reasonCode: 'not_a_reason' }).success).toBe(
      false,
    );
    expect(valuationSuggestionRow.safeParse({ ...row, basis: 'blend' }).success).toBe(false);
    expect(valuationSuggestionRow.safeParse({ ...row, state: 'Reopened' }).success).toBe(false);
    // A number is never a figure: money and percents travel as decimal strings.
    expect(valuationSuggestionRow.safeParse({ ...row, suggestedValue: 20940000 }).success).toBe(
      false,
    );
  });

  it('lists Open suggestions unless a state is given, and every state on request', () => {
    expect(valuationSuggestionListQuery.parse({})).toEqual({ limit: 50, state: 'Open' });
    expect(valuationSuggestionListQuery.parse({ state: 'all', limit: '5' })).toMatchObject({
      state: 'all',
      limit: 5,
    });
    for (const state of ['Open', 'Accepted', 'Dismissed', 'Superseded'])
      expect(valuationSuggestionListQuery.safeParse({ state }).success, state).toBe(true);
    for (const bad of [
      { state: 'open' },
      { periodEnd: '2025-02-30' },
      { investmentId: 'INV-0007' },
      { extractionRunId: 'run' },
      { basis: 'capital_account_balance' },
    ])
      expect(valuationSuggestionListQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    const page = { items: [exampleRow()], nextCursor: null, openCount: 1, runOutcome: null };
    expect(valuationSuggestionPage.parse(page)).toEqual(page);
  });

  it('says what an approved run did, with the rule that kept a mark from being suggested', () => {
    for (const outcome of [
      { outcome: 'opened', reason: null, suggestionId: ID },
      { outcome: 'replaced', reason: null, suggestionId: ID },
      { outcome: 'unchanged', reason: null, suggestionId: ID },
      { outcome: 'none', reason: 'fund_commitment', suggestionId: null },
      { outcome: 'none', reason: 'nothing_on_hand', suggestionId: null },
      { outcome: 'none', reason: null, suggestionId: null },
    ])
      expect(suggestionRunOutcome.parse(outcome)).toEqual(outcome);
    expect(suggestionRunOutcome.safeParse({ outcome: 'closed', reason: null }).success).toBe(false);
    expect(
      suggestionRunOutcome.safeParse({ outcome: 'none', reason: 'unchanged', suggestionId: null })
        .success,
    ).toBe(false);
  });

  it('takes the three commands a person sends, a reason on a dismissal, and nothing else', () => {
    expect(valuationSuggestionCommandBody.parse({ command: 'accept' })).toEqual({
      command: 'accept',
    });
    expect(valuationSuggestionCommandBody.safeParse({ command: 'applyToDraft' }).success).toBe(
      true,
    );
    expect(
      valuationSuggestionCommandBody.safeParse({
        command: 'dismiss',
        reason: 'The statement is for another vehicle',
      }).success,
    ).toBe(true);
    for (const bad of [
      { command: 'supersede' },
      { command: 'dismiss' },
      { command: 'dismiss', reason: 'no' },
      { command: 'dismiss', reason: 'x'.repeat(501) },
      { command: 'dismiss', reason: 'a\u0000b' },
      { command: 'accept', reason: 'not taken here' },
      { command: 'accept', fairValue: '1.00' },
      { command: 'applyToDraft', valuationId: ID },
      {},
    ])
      expect(valuationSuggestionCommandBody.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
  });

  it('serves the reads to the four roles that work on valuations, and to no other', () => {
    const reads = ROUTES.filter(
      (r) => r.method === 'GET' && r.path.startsWith('/api/v1/valuation-suggestions'),
    );
    expect(reads.map((r) => r.path)).toEqual([
      '/api/v1/valuation-suggestions',
      '/api/v1/valuation-suggestions/{id}',
    ]);
    for (const route of reads)
      expect([...route.roles].sort()).toEqual(['approver', 'auditor', 'deal_team', 'operations']);
  });

  it('lets operations alone decide, on a route that is idempotent and guarded by the row version', () => {
    const command = ROUTES.find(
      (r) => r.method === 'POST' && r.path === '/api/v1/valuation-suggestions/{id}/commands',
    );
    expect(command).toMatchObject({
      roles: ['operations'],
      idempotent: true,
      ifMatch: 'valuation_suggestion',
      body: valuationSuggestionCommandBody,
      response: valuationSuggestionRow,
    });
    // Nothing else writes a suggestion: no create, no edit, no delete.
    expect(
      ROUTES.filter(
        (r) => r.method !== 'GET' && r.path.startsWith('/api/v1/valuation-suggestions'),
      ),
    ).toHaveLength(1);
  });
});
