import { linkInvestment } from './linking.js';
import type { InvestmentDirectoryEntry, MatchGuardPair } from './linking.js';

/**
 * The rules of the document hub that decide what a capital account statement is (docs/04 M3,
 * docs/18 section 6, decision 0023), pure so the API (apps/api/src/documents) and the preview
 * simulation (apps/web/src/preview/routes/documents.ts) cannot drift. A statement is one of two
 * kinds, and the kind is the link, not a field: linked to a position it is our capital account
 * for that one co-investment or continuation vehicle; linked to no position it is our account in
 * a fund we committed to. Both carry the sponsor fund's id, so nothing that reads a statement
 * may take the fund's id alone as "a fund statement".
 */

/** The two document types the tracker expects: a report per investment, a statement per sponsor fund. */
export const EXPECTED_DOC_TYPES = {
  quarterlyFinancials: 'doc_type.quarterly_financials',
  capitalAccountStatement: 'doc_type.capital_account_statement',
} as const;

/** What matching reads of a classified document: its type and its links. */
export interface ExpectedAnswer {
  docType: string | null;
  investmentId: string | null;
  sponsorFundId: string | null;
}

/** The expected row a document answers: the parent it is expected from, and the type expected. */
export interface ExpectedParent {
  kind: 'investment' | 'sponsor_fund';
  id: string;
  docType: string;
}

/**
 * The expected row a classified document can answer: a quarterly report answers for its
 * investment, and a capital account statement for its sponsor fund only when it is linked to no
 * position. A position-level statement is never the statement a fund's row waits for. Null when
 * the document answers for nothing.
 */
export function expectedParentOf(doc: ExpectedAnswer): ExpectedParent | null {
  if (doc.docType === EXPECTED_DOC_TYPES.quarterlyFinancials)
    return doc.investmentId === null
      ? null
      : { kind: 'investment', id: doc.investmentId, docType: doc.docType };
  if (doc.docType === EXPECTED_DOC_TYPES.capitalAccountStatement)
    return doc.investmentId !== null || doc.sponsorFundId === null
      ? null
      : { kind: 'sponsor_fund', id: doc.sponsorFundId, docType: doc.docType };
  return null;
}

/**
 * Why a capital account statement that names a position is held for a person instead of being
 * classified by the model. The words are kept on the document as its evidence and say why only:
 * never a company, a number or a name, so the evidence reveals no position the reader may not
 * see (SEC-5.3).
 */
export const STATEMENT_HOLD_REASONS = {
  /** A company in the file name, or a reference on page one, that links to no single position. */
  notLinked: 'the statement names a position that did not link',
  /** A reference that links to one position and a company name that belongs to another. */
  disagree: 'the reference and the company named on the statement disagree',
} as const;
export type StatementHoldReason =
  (typeof STATEMENT_HOLD_REASONS)[keyof typeof STATEMENT_HOLD_REASONS];

/** True for the reason a held statement carries, so a page can say what the reviewer should do. */
export function isStatementHoldReason(reason: string): reason is StatementHoldReason {
  return (Object.values(STATEMENT_HOLD_REASONS) as string[]).includes(reason);
}

/** What a statement says about the position it is for: our reference on page one, the company in the file name. */
export interface StatementNames {
  investmentNumber: string | null;
  companyName: string | null;
}

/**
 * The review rule of a capital account statement (docs/18 section 6). A statement that names no
 * position is a fund statement and is never held. One that names a position goes to a person,
 * with the reason, when what it names does not come to exactly one position:
 * - a reference that is no investment number on record, whatever the name says;
 * - with no reference, a company name that links to no position or to several (never fuzzy);
 * - a reference that links to one position and a company name that is exactly another's.
 * A reference that links wins over a name that links to nothing (the name may be the sponsor's
 * own vehicle), and picks one of several positions the name fits. Classified is terminal, so a
 * statement the model would link wrongly, or read as a fund's, is stopped before it is.
 */
export function statementHold(
  names: StatementNames,
  directory: readonly InvestmentDirectoryEntry[],
  guards: readonly MatchGuardPair[],
): StatementHoldReason | null {
  const number = names.investmentNumber?.trim() ?? '';
  const name = names.companyName?.trim() ?? '';
  if (number === '' && name === '') return null;
  const byName =
    name === ''
      ? null
      : linkInvestment({ investmentNumber: null, companyName: name }, directory, guards);
  // With no reference the company name alone must link, to exactly one position.
  if (number === '') return byName?.investment ? null : STATEMENT_HOLD_REASONS.notLinked;
  const byNumber = linkInvestment(
    { investmentNumber: number, companyName: null },
    directory,
    guards,
  ).investment;
  if (byNumber === null) return STATEMENT_HOLD_REASONS.notLinked;
  if (byName === null) return null;
  // The positions whose name is exactly the one given: one when it matched, several when it is
  // ambiguous, none when it only nearly matches or a match guard blocks it.
  const named =
    byName.status === 'matched' && byName.investment !== null
      ? [byName.investment.investmentNumber]
      : byName.status === 'ambiguous'
        ? byName.candidates.map((candidate) => candidate.investmentNumber)
        : [];
  return named.length > 0 && !named.includes(byNumber.investmentNumber)
    ? STATEMENT_HOLD_REASONS.disagree
    : null;
}
