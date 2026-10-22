import { describe, expect, it } from 'vitest';
import type { ExtractedValue, ExtractionRunDetail, ProblemDetails } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import {
  acceptBlocker,
  acceptCleanPhrase,
  approvalText,
  approveBlocker,
  approvedPhrase,
  BATCH_ROLES,
  batchFormProblem,
  batchStartedPhrase,
  canReview,
  canStartBatch,
  decisionPhrase,
  describeExtractionError,
  docTypeOptions,
  editBody,
  editProblems,
  estimateWidth,
  finalValue,
  findQuote,
  firstPage,
  flagsText,
  pageLines,
  promotedPeriod,
  REVIEW_ROLES,
  reviewOrder,
  runGates,
  runsByState,
  runStateWord,
  tokensText,
  undecidedClean,
  unitLabel,
  valueText,
} from './extraction.js';
import {
  batchFixture,
  cleanValues,
  detailFixture,
  failedRunFixture,
  pagesFixture,
  readyDetailFixture,
  reviewValues,
  runFixture,
} from './test-fixtures.js';

const problem = (code: string, status: number, detail: string): ApiError =>
  new ApiError({
    type: `https://portfolio-beach.example/problems/${code}`,
    title: 'Conflict',
    status,
    detail,
    instance: '/api/v1/extraction/batches',
    request_id: 'test',
  } satisfies ProblemDetails);

describe('roles from the route table', () => {
  it('reads who starts a batch and who reviews from the contract, never from the page', () => {
    expect(BATCH_ROLES).toEqual(['operations']);
    expect([...REVIEW_ROLES].sort()).toEqual(['deal_team', 'operations']);
    expect(canStartBatch(['operations'])).toBe(true);
    expect(canStartBatch(['deal_team'])).toBe(false);
    expect(canReview(['deal_team'])).toBe(true);
    expect(canReview(['viewer', 'auditor'])).toBe(false);
  });
});

describe('review order and words', () => {
  it('puts flagged and invalid values first and keeps the schema order within each group', () => {
    const order = reviewOrder(reviewValues()).map((v) => v.field);
    expect(order.slice(0, 3)).toEqual(['net_debt', 'cash', 'headcount']);
    expect(order[3]).toBe('period_end');
    expect(order).toHaveLength(15);
  });

  it('reads a value in its own unit and never converts it', () => {
    expect(valueText('125.40', 'USD_M', 'money')).toBe('$125.40M');
    expect(valueText('95500', 'USD_K', 'money')).toBe('$95500K');
    expect(valueText('1250000.00', 'USD', 'money')).toBe('$1250000.00');
    expect(valueText('0.6250', 'PCT', 'percent')).toBe('62.50%');
    expect(valueText('2025-06-30', 'DATE', 'date')).toBe('Jun 30, 2025');
    expect(valueText('120', 'COUNT', 'count')).toBe('120');
    expect(valueText(null, 'USD_M', 'money')).toBe('-');
    expect(valueText('12.00', null, 'money')).toBe('12.00');
    expect(unitLabel('USD_M')).toBe('$M');
    expect(unitLabel('USD')).toBe('$');
    expect(unitLabel('PCT')).toBe('%');
  });

  it('takes the edited value in its own unit over the model answer (WF-1)', () => {
    const revenue = (patch: Partial<ExtractedValue>): ExtractedValue =>
      cleanValues({ revenue_ltm: patch }).find((x) => x.field === 'revenue_ltm')!;
    // The edit's unit is the one the promotion converts with, never the model's.
    expect(
      finalValue(revenue({ decision: 'edited', editedValue: '130000', editedUnit: 'USD_K' })),
    ).toEqual({ value: '130000', unit: 'USD_K' });
    expect(finalValue(revenue({ decision: 'edited', editedValue: '130.00' }))).toEqual({
      value: '130.00',
      unit: 'USD_M',
    });
    // An edit accepted again stands as the model answered it.
    expect(
      finalValue(revenue({ decision: 'accepted', editedValue: null, editedUnit: null })),
    ).toEqual({ value: '125.40', unit: 'USD_M' });
    expect(finalValue(cleanValues()[1]!)).toEqual({ value: '125.40', unit: 'USD_M' });
  });

  it('words the states, flags, approval, tokens and runs by state', () => {
    expect(runStateWord('NeedsRetry')).toBe('Needs retry');
    expect(flagsText({ values: 15, clean: 12, flagged: 2, invalid: 1, decided: 0 })).toBe(
      '2 flagged, 1 invalid',
    );
    expect(flagsText({ values: 15, clean: 15, flagged: 0, invalid: 0, decided: 0 })).toBe('-');
    expect(approvalText(runFixture())).toBe('Awaiting approval');
    expect(approvalText(runFixture({ approvedBy: 'Blake Mbeki' }))).toBe('Approved by Blake Mbeki');
    expect(approvalText(failedRunFixture())).toBe('-');
    expect(tokensText(2048, 64)).toBe('2048 in, 64 out');
    expect(tokensText(null, null)).toBe('-');
    expect(runsByState(batchFixture())).toBe('12 succeeded');
    expect(
      runsByState(
        batchFixture({
          runs: { total: 3, queued: 1, running: 0, succeeded: 1, failed: 1, needsRetry: 0 },
        }),
      ),
    ).toBe('1 failed, 1 queued, 1 succeeded');
  });
});

describe('review gates', () => {
  it('opens the review to deal team and operations on a Succeeded, unapproved run only', () => {
    expect(runGates(runFixture(), ['deal_team'])).toEqual({
      reviewable: true,
      retryable: false,
      blocked: null,
    });
    expect(runGates(runFixture(), ['viewer']).blocked).toBe('Needs deal team or operations');
    expect(runGates(runFixture({ approvedBy: 'Blake Mbeki' }), ['operations'])).toEqual({
      reviewable: false,
      retryable: false,
      blocked: 'This run is approved and its figures are promoted',
    });
    expect(runGates(failedRunFixture(), ['operations'])).toEqual({
      reviewable: false,
      retryable: true,
      blocked: 'Review needs a Succeeded run; this one is failed',
    });
    expect(runGates(runFixture({ state: 'Running' }), ['operations']).retryable).toBe(false);
  });

  it('names the first approval blocker in the API words, and none once every value is decided', () => {
    expect(approveBlocker(reviewValues())).toBe(
      'Period end is required and not accepted or edited',
    );
    const decidedRequired = reviewValues().map((v) =>
      v.required ? { ...v, decision: 'accepted' as const } : v,
    );
    expect(approveBlocker(decidedRequired)).toBe('Net debt is flagged and undecided');
    const flaggedDone = decidedRequired.map((v) =>
      v.field === 'net_debt' ? { ...v, decision: 'accepted' as const } : v,
    );
    expect(approveBlocker(flaggedDone)).toBe('Cash is invalid and not edited or rejected');
    expect(approveBlocker(readyDetailFixture().values)).toBeNull();
    // An invalid value that was accepted (the API refuses that too) still blocks.
    const invalidAccepted = readyDetailFixture().values.map((v) =>
      v.field === 'cash' ? { ...v, decision: 'accepted' as const } : v,
    );
    expect(approveBlocker(invalidAccepted)).toBe('Cash is invalid and not edited or rejected');
  });

  it('blocks accepting an invalid value and counts the undecided clean ones', () => {
    const cash = reviewValues().find((v) => v.field === 'cash')!;
    expect(acceptBlocker(cash)).toBe(
      'Cash is invalid and cannot be accepted: Cash: the quote was not found on page 2; edit or reject it',
    );
    expect(acceptBlocker(reviewValues()[0]!)).toBeNull();
    expect(undecidedClean(reviewValues())).toBe(12);
    expect(undecidedClean(readyDetailFixture().values)).toBe(0);
  });
});

describe('status phrases', () => {
  it('follows the fixed wording of the brief', () => {
    expect(batchStartedPhrase(batchFixture())).toBe('Batch started: 12 runs');
    expect(
      batchStartedPhrase(
        batchFixture({
          runs: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, needsRetry: 0 },
        }),
      ),
    ).toBe('Batch started: 1 run');
    expect(decisionPhrase('Revenue LTM', 'accept')).toBe('Revenue LTM accepted');
    expect(decisionPhrase('Headcount', 'edit')).toBe('Headcount edited');
    expect(decisionPhrase('Cash', 'reject')).toBe('Cash rejected');
    const before = runFixture();
    const after = runFixture({ counts: { ...before.counts, decided: 12 } });
    expect(acceptCleanPhrase(before, after)).toBe('12 clean values accepted');
    expect(acceptCleanPhrase(after, after)).toBe('0 clean values accepted');
    expect(approvedPhrase(readyDetailFixture())).toBe(
      'Approved: figures promoted for Jun 30, 2025',
    );
    expect(
      approvedPhrase(detailFixture({ run: runFixture({ periodEnd: null }), values: [] })),
    ).toBe('Approved: figures promoted for -');
  });

  it('names the period the approval promotes, as the API chooses it, never the classified one alone', () => {
    const withPeriodEnd = (patch: Partial<ExtractedValue>): ExtractionRunDetail =>
      detailFixture({
        values: readyDetailFixture().values.map((v) =>
          v.field === 'period_end' ? { ...v, ...patch } : v,
        ),
      });
    // The reviewer edited the period end on a run classified as Jun 30, 2025: the edit is promoted.
    const edited = withPeriodEnd({ decision: 'edited', editedValue: '2025-03-31' });
    expect(edited.run.periodEnd).toBe('2025-06-30');
    expect(promotedPeriod(edited)).toBe('2025-03-31');
    expect(approvedPhrase(edited)).toBe('Approved: figures promoted for Mar 31, 2025');
    // Accepted as the model answered it: the model's date, which the classification may differ from.
    const accepted = withPeriodEnd({ decision: 'accepted', value: '2025-03-31' });
    expect(promotedPeriod(accepted)).toBe('2025-03-31');
    // Undecided or rejected, nothing is promoted (the API refuses the approval): no date is claimed.
    expect(promotedPeriod(withPeriodEnd({ decision: null }))).toBeNull();
    expect(promotedPeriod(withPeriodEnd({ decision: 'rejected' }))).toBeNull();
    expect(approvedPhrase(withPeriodEnd({ decision: null }))).toBe(
      'Approved: figures promoted for -',
    );
    // Only a run that staged no period_end row at all falls back to its classified period.
    const absent = detailFixture({
      values: readyDetailFixture().values.filter((v) => v.field !== 'period_end'),
    });
    expect(promotedPeriod(absent)).toBe('2025-06-30');
  });
});

describe('errors', () => {
  it('shows the kill switch and a review refusal as their own sentence, the rest through the shared mapping', () => {
    expect(
      describeExtractionError(
        problem('kill-switch', 409, 'AI extraction is switched off (ai.extraction)'),
      ),
    ).toBe('AI extraction is switched off (ai.extraction)');
    expect(
      describeExtractionError(
        problem('review-blocked', 409, 'extraction: Headcount is flagged and undecided'),
      ),
    ).toBe('Headcount is flagged and undecided');
    expect(describeExtractionError(problem('forbidden', 403, 'Operations only'))).toBe(
      'Your role cannot do this. Operations only',
    );
    expect(describeExtractionError(new Error('offline'))).toBe('offline');
  });
});

describe('the batch form', () => {
  it('needs a quarter end and a type', () => {
    expect(batchFormProblem({ periodEnd: '', docType: 'doc_type.quarterly_financials' })).toBe(
      'Enter a quarter end as YYYY-MM-DD, for example 2025-06-30.',
    );
    expect(
      batchFormProblem({ periodEnd: '2025-06-15', docType: 'doc_type.quarterly_financials' }),
    ).toContain('quarter end');
    expect(batchFormProblem({ periodEnd: '2025-06-30', docType: '' })).toBe(
      'Choose a document type.',
    );
    expect(
      batchFormProblem({ periodEnd: ' 2025-06-30 ', docType: 'doc_type.quarterly_financials' }),
    ).toBeNull();
  });

  it('lists the active document types of the taxonomy in order, with a fallback before it loads', () => {
    expect(docTypeOptions(undefined)).toEqual([
      { code: 'doc_type.quarterly_financials', label: 'Quarterly financials' },
    ]);
    expect(
      docTypeOptions({
        domains: [
          {
            domain: 'doc_type',
            terms: [
              { code: 'doc_type.k1', label: 'K-1', parentCode: null, active: true, sortOrder: 6 },
              {
                code: 'doc_type.quarterly_financials',
                label: 'Quarterly financials',
                parentCode: null,
                active: true,
                sortOrder: 1,
              },
              { code: 'doc_type.old', label: 'Old', parentCode: null, active: false, sortOrder: 2 },
            ],
          },
        ],
      }),
    ).toEqual([
      { code: 'doc_type.quarterly_financials', label: 'Quarterly financials' },
      { code: 'doc_type.k1', label: 'K-1' },
    ]);
  });
});

describe('the edit form', () => {
  const money = reviewValues().find((v) => v.field === 'net_debt')!;
  const count = reviewValues().find((v) => v.field === 'headcount')!;
  const pct = reviewValues().find((v) => v.field === 'sponsor_ownership_pct')!;
  const date = reviewValues().find((v) => v.field === 'period_end')!;

  it('checks the value against the unit with the contract rules and asks for a reason', () => {
    expect(editProblems(money, { value: '', unit: 'USD_M', reason: 'typo' })).toEqual({
      value: 'A value is required',
    });
    expect(editProblems(money, { value: '95.5', unit: '', reason: 'typo' })).toEqual({
      unit: 'A money edit needs a money unit',
    });
    expect(editProblems(money, { value: '95.5', unit: 'PCT', reason: 'typo' })).toEqual({
      unit: 'A money edit needs a money unit',
    });
    expect(editProblems(count, { value: '12.5', unit: '', reason: 'typo' })).toEqual({
      value: 'The value does not fit the unit',
    });
    expect(editProblems(pct, { value: 'half', unit: '', reason: 'typo' })).toEqual({
      value: 'The value does not fit the unit',
    });
    expect(editProblems(date, { value: '2025-13-01', unit: '', reason: 'typo' })).toEqual({
      value: 'The value does not fit the unit',
    });
    expect(editProblems(count, { value: '118', unit: '', reason: '' })).toEqual({
      reason: 'Give a reason of at least 3 characters',
    });
    expect(editProblems(count, { value: '118', unit: '', reason: 'footnote' })).toEqual({});
    expect(editProblems(money, { value: '95500', unit: 'USD_K', reason: 'footnote' })).toEqual({});
  });

  it('builds the command with the money unit chosen or the kind own unit', () => {
    expect(editBody(money, { value: ' 95500 ', unit: 'USD_K', reason: ' footnote ' })).toEqual({
      command: 'edit',
      field: 'net_debt',
      value: '95500',
      unit: 'USD_K',
      reason: 'footnote',
    });
    expect(editBody(count, { value: '118', unit: '', reason: 'footnote' })).toEqual({
      command: 'edit',
      field: 'headcount',
      value: '118',
      unit: 'COUNT',
      reason: 'footnote',
    });
  });
});

describe('click-to-source', () => {
  const pages = pagesFixture();
  const table = pages[1]!;

  it('groups runs by baseline, top first, left to right', () => {
    const lines = pageLines(table);
    expect(lines[0]).toEqual([0]);
    expect(lines[1]).toEqual([1, 2]);
    expect(lines.map((l) => l.length)).toEqual([1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it('finds a quote that spans the label and figure runs of a table row', () => {
    expect(findQuote(table, 'LTM revenue 125.40')).toEqual([1, 2]);
    expect(findQuote(table, '125.40')).toEqual([2]);
    expect(findQuote(table, 'LTM   revenue 125.40')).toEqual([1, 2]);
    expect(findQuote(table, 'Net debt 95.50')).toEqual([11, 12]);
  });

  it('finds nothing for a quote that is not on the page, case kept, or a null quote', () => {
    expect(findQuote(table, 'Cash 99.30')).toEqual([]);
    expect(findQuote(table, 'ltm revenue 125.40')).toEqual([]);
    expect(findQuote(table, null)).toEqual([]);
    expect(findQuote(table, '   ')).toEqual([]);
  });

  it('finds a quote inside one run and across a single-run line', () => {
    expect(findQuote(pages[2]!, 'Headcount 120')).toEqual([7]);
    expect(findQuote(pages[2]!, 'ownership 62.50%')).toEqual([2]);
  });

  it('estimates a run width at about half an em per character and opens on the first cited page', () => {
    expect(estimateWidth('125.40', 10)).toBeCloseTo(31.2);
    expect(estimateWidth('', 10)).toBe(0);
    expect(firstPage(detailFixture())).toBe(2);
    expect(firstPage(detailFixture({ values: cleanValues() }))).toBe(3);
    expect(firstPage(detailFixture({ values: [], pages: [] }))).toBe(1);
  });
});
