/*
 * The document type codes of the `doc_type.*` taxonomy (migration 0011, docs/04 M3). The labels
 * live with the taxonomy rows in the database; the classifier's signature table carries the
 * phrases it matches, label text included.
 */

export const DOC_TYPE_CODES = [
  'doc_type.quarterly_financials',
  'doc_type.quarterly_letter',
  'doc_type.capital_call',
  'doc_type.distribution_notice',
  'doc_type.capital_account_statement',
  'doc_type.k1',
  'doc_type.audited_financials',
  'doc_type.cim',
  'doc_type.management_presentation',
  'doc_type.lpa',
  'doc_type.side_letter',
  'doc_type.subscription_docs',
  'doc_type.closing_set',
  'doc_type.valuation_support',
  'doc_type.agm_materials',
  'doc_type.other',
] as const;
export type DocTypeCode = (typeof DOC_TYPE_CODES)[number];

export function isDocTypeCode(value: string): value is DocTypeCode {
  return (DOC_TYPE_CODES as readonly string[]).includes(value);
}
