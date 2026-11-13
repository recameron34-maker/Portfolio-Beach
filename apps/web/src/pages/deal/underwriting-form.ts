import { D } from '@pb/calc';
import { underwritingCaseBody } from '@pb/contracts';
import type { UnderwritingCaseBody, UnderwritingCaseVersion } from '@pb/contracts';
import { fieldLabel } from '../../app/mutations.js';
import { groupThousands } from '../../lib/format.js';

/*
 * The form a base case is recorded with, as pure rules: what the deal team types (plan figures in
 * US$ millions, the IRR in percent), the body the API takes (dollars, a rate as a decimal), and
 * what is wrong with an entry, field by field. Every conversion is exact decimal arithmetic on
 * the text typed: nothing is rounded and nothing is guessed, and the review step shows each
 * figure back in full before anything is sent.
 */

/** One plan date as typed: the twelve months ending on it, in US$ millions. */
export interface PlanRowDraft {
  periodEnd: string;
  revenue: string;
  ebitda: string;
  netDebt: string;
}

/**
 * A base case as typed. The last plan row is the planned exit: its date is the planned exit
 * date, never typed a second time, so the two cannot disagree.
 */
export interface CaseDraft {
  caseDate: string;
  plannedExitDate: string;
  exitMultiple: string;
  grossMoic: string;
  /** In percent: 20 is 20%. */
  grossIrrPct: string;
  rows: PlanRowDraft[];
  sourceDocumentId: string;
  sourcePage: string;
  sourceLocator: string;
  sourceNote: string;
  note: string;
  revisionReason: string;
}

const EMPTY_ROW: PlanRowDraft = { periodEnd: '', revenue: '', ebitda: '', netDebt: '' };

/** A new case: nothing typed, and the two plan rows every case needs. */
export function emptyDraft(): CaseDraft {
  return {
    caseDate: '',
    plannedExitDate: '',
    exitMultiple: '',
    grossMoic: '',
    grossIrrPct: '',
    rows: [{ ...EMPTY_ROW }, { ...EMPTY_ROW }],
    sourceDocumentId: '',
    sourcePage: '',
    sourceLocator: '',
    sourceNote: '',
    note: '',
    revisionReason: '',
  };
}

/** Dollars as the millions a person types: "200000000.00" is "200". Exact; null is an empty field. */
const millionsOf = (dollars: string | null): string =>
  dollars === null ? '' : D(dollars).div(1_000_000).toFixed();

/** A stored figure without the zeros its column pads it with: "11.000000" is "11". */
const plain = (value: string | null): string => (value === null ? '' : D(value).toFixed());

/**
 * The form filled from a version on record: a Draft being edited, or the case a revision starts
 * from. A revision keeps the figures and the source and asks for its own reason.
 */
export function draftOf(
  version: UnderwritingCaseVersion,
  options: { keepReason: boolean },
): CaseDraft {
  const rows = version.points.map((p) => ({
    periodEnd: p.periodEnd,
    revenue: millionsOf(p.revenueLtm),
    ebitda: millionsOf(p.ebitdaLtm),
    netDebt: millionsOf(p.netDebt),
  }));
  while (rows.length < 2) rows.push({ ...EMPTY_ROW });
  return {
    caseDate: version.caseDate,
    plannedExitDate: version.plannedExitDate,
    exitMultiple: plain(version.exitMultiple),
    grossMoic: plain(version.grossMoic),
    grossIrrPct: D(version.grossIrr).times(100).toFixed(),
    rows,
    sourceDocumentId: version.source.document?.id ?? '',
    sourcePage: version.source.page === null ? '' : String(version.source.page),
    sourceLocator: version.source.locator ?? '',
    sourceNote: version.source.note ?? '',
    note: version.note ?? '',
    revisionReason: options.keepReason ? (version.revisionReason ?? '') : '',
  };
}

/** What is wrong with an entry, by field: "caseDate", "rows.0.revenue", "rows" for the plan as a whole. */
export type DraftErrors = Readonly<Record<string, string>>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** US$ millions: up to eight decimals, so the amount in dollars has no more than two. */
const MILLIONS = /^-?\d{1,12}(\.\d{1,8})?$/;
/** A multiple as the API keeps it. */
const MULTIPLE = /^\d{1,6}(\.\d{1,6})?$/;
/** A percent with up to six decimals, so the rate has no more than eight. */
const PERCENT = /^-?\d{1,6}(\.\d{1,6})?$/;

const AMOUNT_WORDS = 'Use digits with an optional decimal point, in US$ millions.';
const NUMBER_WORDS = 'Use digits with an optional decimal point.';

/** The millions typed as dollars with two decimals, exactly; null for an empty field. */
function dollarsOf(text: string): string | null | undefined {
  const typed = text.trim();
  if (typed === '') return null;
  if (!MILLIONS.test(typed)) return undefined;
  return D(typed).times(1_000_000).toFixed(2);
}

/**
 * The body the API takes for what was typed, or what is wrong with it field by field. The checks
 * are the ones a person can act on before sending (a missing date, a figure that is no number,
 * plan dates out of order); the contract's own schema then reads the body, so nothing the API
 * would refuse at its boundary is sent. What needs the record (a second Draft, the case date
 * against the Confirmed cases, a document of another position) is the API's to refuse.
 */
export function bodyOf(
  draft: CaseDraft,
  options: { needsReason: boolean },
): { ok: true; body: UnderwritingCaseBody } | { ok: false; errors: DraftErrors } {
  const errors: Record<string, string> = {};
  const caseDate = draft.caseDate.trim();
  const plannedExitDate = draft.plannedExitDate.trim();
  if (!ISO_DATE.test(caseDate)) errors.caseDate = 'Give the date of the base case.';
  if (!ISO_DATE.test(plannedExitDate)) errors.plannedExitDate = 'Give the planned exit date.';
  else if (ISO_DATE.test(caseDate) && plannedExitDate <= caseDate)
    errors.plannedExitDate = 'The planned exit is after the case date.';

  const exitMultiple = draft.exitMultiple.trim();
  if (!MULTIPLE.test(exitMultiple) || !/[1-9]/.test(exitMultiple))
    errors.exitMultiple = `Give the exit multiple, above zero. ${NUMBER_WORDS}`;
  const grossMoic = draft.grossMoic.trim();
  if (!MULTIPLE.test(grossMoic) || !/[1-9]/.test(grossMoic))
    errors.grossMoic = `Give the underwritten gross MOIC, above zero. ${NUMBER_WORDS}`;
  const irr = draft.grossIrrPct.trim();
  const irrOk = PERCENT.test(irr) && D(irr).gt(-100);
  if (!irrOk)
    errors.grossIrr = `Give the underwritten gross IRR in percent, above -100. ${NUMBER_WORDS}`;

  const last = draft.rows.length - 1;
  const points: NonNullable<UnderwritingCaseBody['points']> = [];
  let before: string | null = null;
  draft.rows.forEach((row, i) => {
    // The last row is the planned exit: its date is the one given above.
    const periodEnd = i === last ? plannedExitDate : row.periodEnd.trim();
    const dated = ISO_DATE.test(periodEnd);
    if (!dated && i !== last) errors[`rows.${i}.periodEnd`] = 'Give the plan date.';
    else if (dated && before !== null && periodEnd <= before)
      errors[`rows.${i}.periodEnd`] =
        i === last
          ? 'Every plan date is before the planned exit.'
          : 'Plan dates are in order, each later than the one before.';
    if (dated) before = periodEnd;
    const figures = {
      revenue: dollarsOf(row.revenue),
      ebitda: dollarsOf(row.ebitda),
      netDebt: dollarsOf(row.netDebt),
    };
    for (const key of ['revenue', 'ebitda', 'netDebt'] as const)
      if (figures[key] === undefined) errors[`rows.${i}.${key}`] = AMOUNT_WORDS;
    const { revenue, ebitda, netDebt } = figures;
    if (revenue === null && ebitda === null && netDebt === null)
      errors[`rows.${i}.figures`] = 'Give at least one of revenue, EBITDA and net debt.';
    if (revenue !== undefined && ebitda !== undefined && netDebt !== undefined)
      points.push({ periodEnd, revenueLtm: revenue, ebitdaLtm: ebitda, netDebt });
  });
  if (draft.rows.length < 2) errors.rows = 'A base case has two plan dates or more.';

  const sourceDocumentId = draft.sourceDocumentId.trim();
  const sourcePage = draft.sourcePage.trim();
  const sourceLocator = draft.sourceLocator.trim();
  const sourceNote = draft.sourceNote.trim();
  if (sourcePage !== '' && !/^[1-9]\d{0,4}$/.test(sourcePage))
    errors.sourcePage = 'Give the page as a whole number.';
  if (sourceDocumentId === '' && (sourcePage !== '' || sourceLocator !== ''))
    errors.sourceDocument = 'A page or a sheet and cell goes with a source document.';
  if (sourceNote !== '' && sourceNote.length < 3)
    errors.sourceNote = 'Say where the model is held in a few words.';
  const revisionReason = draft.revisionReason.trim();
  if (options.needsReason && revisionReason.length < 3)
    errors.revisionReason = 'Say why the base case is revised.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const note = draft.note.trim();
  const body: UnderwritingCaseBody = {
    caseDate,
    plannedExitDate,
    exitMultiple,
    grossMoic,
    grossIrr: D(irr).div(100).toFixed(),
    points,
    ...(note === '' ? {} : { note }),
    ...(options.needsReason ? { revisionReason } : {}),
    ...(sourceDocumentId === '' ? {} : { sourceDocumentId }),
    ...(sourceDocumentId === '' || sourcePage === '' ? {} : { sourcePage: Number(sourcePage) }),
    ...(sourceDocumentId === '' || sourceLocator === '' ? {} : { sourceLocator }),
    ...(sourceNote === '' ? {} : { sourceNote }),
  };
  // The contract reads what is about to be sent; whatever it still finds is named by its field.
  const parsed = underwritingCaseBody.safeParse(body);
  if (parsed.success) return { ok: true, body };
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String).join('.');
    errors.form ??= `${fieldLabel(path) ?? 'The base case'}: ${issue.message}`;
  }
  return { ok: false, errors };
}

/** An amount in dollars in full, with its cents: "200000000.00" is "$200,000,000.00". Exact, from the text. */
export function formatDollars(value: string | null): string | null {
  if (value === null) return null;
  const fixed = D(value).toFixed(2);
  const negative = fixed.startsWith('-');
  const [whole, cents] = (negative ? fixed.slice(1) : fixed).split('.');
  return `${negative ? '-' : ''}$${groupThousands(whole ?? '0')}.${cents ?? '00'}`;
}

/** A rate as the percent a person typed, exactly: "0.2025" is "20.25%". */
export const formatRatePct = (rate: string): string => `${D(rate).times(100).toFixed()}%`;
