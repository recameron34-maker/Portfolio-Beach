import { describe, expect, it } from 'vitest';
import { underwritingCaseBody } from '@pb/contracts';
import { bodyOf, draftOf, emptyDraft, formatDollars, formatRatePct } from './underwriting-form.js';
import type { CaseDraft } from './underwriting-form.js';
import { caseFixture, reunderwriteFixture } from './underwriting.fixtures.js';

/** A base case as a person types it: the plan in US$ millions, the IRR in percent. */
const typed = (overrides: Partial<CaseDraft> = {}): CaseDraft => ({
  ...emptyDraft(),
  caseDate: '2021-06-30',
  plannedExitDate: '2026-06-30',
  exitMultiple: '11',
  grossMoic: '2.5',
  grossIrrPct: '20',
  rows: [
    { periodEnd: '2021-06-30', revenue: '200', ebitda: '40', netDebt: '150' },
    { periodEnd: '', revenue: '400', ebitda: '80', netDebt: '100' },
  ],
  sourceNote: 'Sponsor model, held in the deal folder',
  ...overrides,
});

const errorsOf = (draft: CaseDraft, needsReason = false): Readonly<Record<string, string>> => {
  const checked = bodyOf(draft, { needsReason });
  if (checked.ok) throw new Error('expected the entry to be refused');
  return checked.errors;
};

describe('base case form: what is typed becomes what the API takes', () => {
  it('turns millions into dollars and percent into a rate, exactly, and dates the last row the planned exit', () => {
    const checked = bodyOf(typed(), { needsReason: false });
    expect(checked).toEqual({
      ok: true,
      body: {
        caseDate: '2021-06-30',
        plannedExitDate: '2026-06-30',
        exitMultiple: '11',
        grossMoic: '2.5',
        grossIrr: '0.2',
        points: [
          {
            periodEnd: '2021-06-30',
            revenueLtm: '200000000.00',
            ebitdaLtm: '40000000.00',
            netDebt: '150000000.00',
          },
          {
            periodEnd: '2026-06-30',
            revenueLtm: '400000000.00',
            ebitdaLtm: '80000000.00',
            netDebt: '100000000.00',
          },
        ],
        sourceNote: 'Sponsor model, held in the deal folder',
      },
    });
    // What is sent is what the contract takes.
    if (checked.ok) expect(underwritingCaseBody.safeParse(checked.body).success).toBe(true);
  });

  it('keeps every digit: a fraction of a million, a loss, net cash and an empty figure', () => {
    const checked = bodyOf(
      typed({
        grossIrrPct: '-12.345678',
        rows: [
          { periodEnd: '2021-06-30', revenue: '0.12345678', ebitda: '-3.5', netDebt: '' },
          { periodEnd: '2023-12-31', revenue: '', ebitda: '', netDebt: '-8' },
          { periodEnd: '', revenue: '123456789012.5', ebitda: '0', netDebt: '0.01' },
        ],
      }),
      { needsReason: false },
    );
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    expect(checked.body.grossIrr).toBe('-0.12345678');
    expect(checked.body.points).toEqual([
      {
        periodEnd: '2021-06-30',
        revenueLtm: '123456.78',
        ebitdaLtm: '-3500000.00',
        netDebt: null,
      },
      { periodEnd: '2023-12-31', revenueLtm: null, ebitdaLtm: null, netDebt: '-8000000.00' },
      {
        periodEnd: '2026-06-30',
        revenueLtm: '123456789012500000.00',
        ebitdaLtm: '0.00',
        netDebt: '10000.00',
      },
    ]);
  });

  it('carries the source document with its place, the note and the reason of a revision', () => {
    const checked = bodyOf(
      typed({
        sourceDocumentId: '00000000-0000-4000-8000-00000000d101',
        sourcePage: '12',
        sourceLocator: ' Base case!B14 ',
        sourceNote: '',
        note: ' From the 2023 model ',
        revisionReason: ' The exit multiple was mistyped ',
      }),
      { needsReason: true },
    );
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    expect(checked.body).toMatchObject({
      sourceDocumentId: '00000000-0000-4000-8000-00000000d101',
      sourcePage: 12,
      sourceLocator: 'Base case!B14',
      note: 'From the 2023 model',
      revisionReason: 'The exit multiple was mistyped',
    });
    expect(checked.body).not.toHaveProperty('sourceNote');
    // A first version has no reason to give, whatever was typed.
    const first = bodyOf(typed({ revisionReason: 'left over' }), { needsReason: false });
    if (!first.ok) throw new Error('refused');
    expect(first.body).not.toHaveProperty('revisionReason');
  });

  it('says what is wrong field by field, before anything is sent', () => {
    expect(errorsOf(emptyDraft())).toEqual({
      caseDate: 'Give the date of the base case.',
      plannedExitDate: 'Give the planned exit date.',
      exitMultiple:
        'Give the exit multiple, above zero. Use digits with an optional decimal point.',
      grossMoic:
        'Give the underwritten gross MOIC, above zero. Use digits with an optional decimal point.',
      grossIrr:
        'Give the underwritten gross IRR in percent, above -100. Use digits with an optional decimal point.',
      'rows.0.periodEnd': 'Give the plan date.',
      'rows.0.figures': 'Give at least one of revenue, EBITDA and net debt.',
      'rows.1.figures': 'Give at least one of revenue, EBITDA and net debt.',
    });
    expect(errorsOf(typed({ plannedExitDate: '2021-06-30' })).plannedExitDate).toBe(
      'The planned exit is after the case date.',
    );
    for (const exitMultiple of ['0', '0.0', '-1', '11x', '1,5', '1234567'])
      expect(errorsOf(typed({ exitMultiple })).exitMultiple, exitMultiple).toBeDefined();
    for (const grossIrrPct of ['-100', 'twenty', '20%', '1.1234567'])
      expect(errorsOf(typed({ grossIrrPct })).grossIrr, grossIrrPct).toBeDefined();
    // Plan dates in order, every one before the planned exit.
    const rows = (dates: string[]): CaseDraft =>
      typed({
        rows: [...dates, ''].map((periodEnd) => ({
          periodEnd,
          revenue: '1',
          ebitda: '',
          netDebt: '',
        })),
      });
    expect(errorsOf(rows(['2022-12-31', '2022-06-30']))).toEqual({
      'rows.1.periodEnd': 'Plan dates are in order, each later than the one before.',
    });
    expect(errorsOf(rows(['2022-12-31', '2026-06-30']))).toEqual({
      'rows.2.periodEnd': 'Every plan date is before the planned exit.',
    });
    // A figure that is no amount is named, never guessed: a thousands separator, a unit.
    const amounts = errorsOf(
      typed({
        rows: [
          { periodEnd: '2021-06-30', revenue: '200,5', ebitda: '$40', netDebt: '150M' },
          { periodEnd: '', revenue: '1.123456789', ebitda: '80', netDebt: '100' },
        ],
      }),
    );
    expect(Object.keys(amounts)).toEqual([
      'rows.0.revenue',
      'rows.0.ebitda',
      'rows.0.netDebt',
      'rows.1.revenue',
    ]);
    expect(amounts['rows.0.revenue']).toBe(
      'Use digits with an optional decimal point, in US$ millions.',
    );
    expect(errorsOf(typed({ rows: typed().rows.slice(0, 1) })).rows).toBe(
      'A base case has two plan dates or more.',
    );
    // The source, and the reason of a revision.
    expect(errorsOf(typed({ sourcePage: '12' })).sourceDocument).toBe(
      'A page or a sheet and cell goes with a source document.',
    );
    expect(
      errorsOf(typed({ sourceDocumentId: '00000000-0000-4000-8000-00000000d101', sourcePage: '0' }))
        .sourcePage,
    ).toBe('Give the page as a whole number.');
    expect(errorsOf(typed({ sourceNote: 'x' })).sourceNote).toBe(
      'Say where the model is held in a few words.',
    );
    expect(errorsOf(typed(), true)).toEqual({
      revisionReason: 'Say why the base case is revised.',
    });
    // What only the contract finds is named by its field, in one sentence.
    expect(errorsOf(typed({ sourceDocumentId: 'not-an-id' })).form).toMatch(/^Source document: /);
  });

  it('fills the form from a version on record, in the units a person types', () => {
    const draft = draftOf(reunderwriteFixture(), { keepReason: true });
    expect(draft).toEqual({
      caseDate: '2023-03-31',
      plannedExitDate: '2026-06-30',
      exitMultiple: '10',
      grossMoic: '2.2',
      grossIrrPct: '17',
      rows: [
        { periodEnd: '2023-03-31', revenue: '300', ebitda: '62', netDebt: '124' },
        { periodEnd: '2026-06-30', revenue: '380', ebitda: '76', netDebt: '104' },
      ],
      sourceDocumentId: '00000000-0000-4000-8000-00000000d101',
      sourcePage: '12',
      sourceLocator: 'Base case!B14',
      sourceNote: '',
      note: '',
      revisionReason: 'Sponsor re-underwrote after the 2022 acquisition',
    });
    // A revision starts from the figures and asks for its own reason.
    expect(draftOf(reunderwriteFixture(), { keepReason: false }).revisionReason).toBe('');
    // What the form was filled with goes back as the same figures.
    const entry = caseFixture();
    const back = bodyOf(draftOf(entry, { keepReason: false }), { needsReason: false });
    if (!back.ok) throw new Error(JSON.stringify(back.errors));
    expect(back.body.points).toEqual(entry.points);
    expect(back.body).toMatchObject({ exitMultiple: '11', grossMoic: '2.5', grossIrr: '0.2' });
    // A missing figure is an empty field, and a fraction of a million keeps its digits.
    const gap = draftOf(
      caseFixture({
        points: [
          { periodEnd: '2021-06-30', revenueLtm: null, ebitdaLtm: '66380000.00', netDebt: null },
          { periodEnd: '2026-06-30', revenueLtm: '1.00', ebitdaLtm: null, netDebt: '-8000000.00' },
        ],
      }),
      { keepReason: false },
    );
    expect(gap.rows).toEqual([
      { periodEnd: '2021-06-30', revenue: '', ebitda: '66.38', netDebt: '' },
      { periodEnd: '2026-06-30', revenue: '0.000001', ebitda: '', netDebt: '-8' },
    ]);
  });

  it('shows a figure back in full', () => {
    expect(formatDollars('200000000.00')).toBe('$200,000,000.00');
    expect(formatDollars('-8000000')).toBe('-$8,000,000.00');
    expect(formatDollars('123456.78')).toBe('$123,456.78');
    expect(formatDollars('0.5')).toBe('$0.50');
    expect(formatDollars(null)).toBeNull();
    expect(formatRatePct('0.2')).toBe('20%');
    expect(formatRatePct('0.2025')).toBe('20.25%');
    expect(formatRatePct('-0.12345678')).toBe('-12.345678%');
  });
});
