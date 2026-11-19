import { describe, expect, it } from 'vitest';
import {
  EXPECTED_DOC_TYPES,
  STATEMENT_HOLD_REASONS,
  expectedParentOf,
  isStatementHoldReason,
  statementHold,
} from './documents.js';
import type { InvestmentDirectoryEntry } from './linking.js';

const entry = (
  investmentNumber: string,
  companyName: string,
  aliases: string[] = [],
): InvestmentDirectoryEntry => ({
  id: `30000000-0000-4000-8000-${investmentNumber.replace(/\D/g, '').padStart(12, '0')}`,
  investmentNumber,
  companyName,
  canonicalName: companyName.toLowerCase(),
  aliases,
  dealType: 'deal_type.co_invest_equity',
  entryDate: '2020-01-01',
  exitDate: null,
  isActive: true,
});
const DIRECTORY = [
  entry('INV-0001', 'Meridian Data Partners', ['Meridian Data']),
  entry('INV-0002', 'Juniper Financial Group'),
  entry('INV-0003', 'Ridgeway Home Group'),
  // One company held through two vehicles: the name alone fits both positions.
  entry('INV-0004', 'Ridgeway Home Group'),
];
const FUND = '20000000-0000-4000-8000-000000000002';
const POSITION = DIRECTORY[0]!.id;
const { quarterlyFinancials: REPORT, capitalAccountStatement: STATEMENT } = EXPECTED_DOC_TYPES;

describe('expectedParentOf: the expected row a classified document answers (docs/04 M3)', () => {
  it('a quarterly report answers for its investment, and for nothing without one', () => {
    expect(
      expectedParentOf({ docType: REPORT, investmentId: POSITION, sponsorFundId: FUND }),
    ).toEqual({ kind: 'investment', id: POSITION, docType: REPORT });
    expect(
      expectedParentOf({ docType: REPORT, investmentId: null, sponsorFundId: FUND }),
    ).toBeNull();
  });

  it('a statement linked to no position answers for its sponsor fund', () => {
    expect(
      expectedParentOf({ docType: STATEMENT, investmentId: null, sponsorFundId: FUND }),
    ).toEqual({ kind: 'sponsor_fund', id: FUND, docType: STATEMENT });
  });

  it('a statement linked to a position answers for no fund, though it carries the fund id', () => {
    expect(
      expectedParentOf({ docType: STATEMENT, investmentId: POSITION, sponsorFundId: FUND }),
    ).toBeNull();
  });

  it('a statement with neither link, another type and an unclassified document answer for nothing', () => {
    expect(
      expectedParentOf({ docType: STATEMENT, investmentId: null, sponsorFundId: null }),
    ).toBeNull();
    expect(
      expectedParentOf({
        docType: 'doc_type.capital_call',
        investmentId: POSITION,
        sponsorFundId: FUND,
      }),
    ).toBeNull();
    expect(
      expectedParentOf({ docType: null, investmentId: POSITION, sponsorFundId: FUND }),
    ).toBeNull();
  });
});

describe('statementHold: when a statement that names a position goes to a person (docs/18 section 6)', () => {
  const hold = (investmentNumber: string | null, companyName: string | null) =>
    statementHold({ investmentNumber, companyName }, DIRECTORY, []);
  const { notLinked, disagree } = STATEMENT_HOLD_REASONS;

  it('never holds a statement that names no position: it is a fund statement', () => {
    expect(hold(null, null)).toBeNull();
    expect(hold('', '  ')).toBeNull();
  });

  it('lets a statement through when what it names comes to exactly one position', () => {
    // The company in the file name alone, exactly or by an alias.
    expect(hold(null, 'Meridian Data Partners')).toBeNull();
    expect(hold(null, 'MERIDIAN DATA')).toBeNull();
    // Our reference alone.
    expect(hold('INV-0002', null)).toBeNull();
    expect(hold('inv-0002', null)).toBeNull();
    // Both, agreeing.
    expect(hold('INV-0001', 'Meridian Data Partners')).toBeNull();
  });

  it('holds a company name that links to no position, a near miss included', () => {
    expect(hold(null, 'Northgate Holdco')).toBe(notLinked);
    expect(hold(null, 'Meridian Data Partner')).toBe(notLinked);
  });

  it('holds a company two positions hold when no reference says which', () => {
    expect(hold(null, 'Ridgeway Home Group')).toBe(notLinked);
  });

  it('lets a reference pick one of the positions its company name fits', () => {
    expect(hold('INV-0003', 'Ridgeway Home Group')).toBeNull();
    expect(hold('INV-0004', 'Ridgeway Home Group')).toBeNull();
  });

  it('holds a reference that is no investment number on record, whatever the name says', () => {
    expect(hold('INV-9999', null)).toBe(notLinked);
    expect(hold('INV-9999', 'Meridian Data Partners')).toBe(notLinked);
  });

  it('holds a reference and a company name that belong to different positions', () => {
    expect(hold('INV-0002', 'Meridian Data Partners')).toBe(disagree);
    expect(hold('INV-0001', 'Ridgeway Home Group')).toBe(disagree);
  });

  it('lets the reference win over a name that links to nothing', () => {
    // The name may be the sponsor's own vehicle: it names no other position on record.
    expect(hold('INV-0002', 'Harbor Co-Invest Vehicle III')).toBeNull();
    expect(hold('INV-0001', 'Meridian Data Partner')).toBeNull();
  });

  it('holds a name a match guard blocks, and lets a reference stand beside it', () => {
    const guards = [{ nameA: 'Juniper Financial Group', nameB: 'Juniper Finance Group' }];
    const names = { investmentNumber: null, companyName: 'Juniper Finance Group' };
    expect(statementHold(names, DIRECTORY, guards)).toBe(notLinked);
    expect(statementHold({ ...names, investmentNumber: 'INV-0002' }, DIRECTORY, guards)).toBeNull();
  });

  it('gives a reason that names nothing: no company, no number', () => {
    for (const reason of Object.values(STATEMENT_HOLD_REASONS)) {
      expect(reason).not.toMatch(/INV-|\d/);
      for (const row of DIRECTORY) expect(reason).not.toContain(row.companyName);
      expect(isStatementHoldReason(reason)).toBe(true);
    }
    expect(isStatementHoldReason('a near miss')).toBe(false);
  });
});
