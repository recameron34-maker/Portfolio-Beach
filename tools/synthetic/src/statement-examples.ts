import { positionStatementDocument } from './documents.js';
import type { PositionStatementInput, StatementLines, SyntheticDocument } from './documents.js';

/**
 * Capital account statements for tests only (decision 0023): the worked examples of docs/08
 * section 12 and the cases a seeded statement never shows, written with the builder the document
 * set uses (`positionStatementDocument`), so each is a real PDF with a truth sidecar that records
 * what a correct extraction answers. None is part of `generateDocuments`: a test names the
 * position, the fund, the vehicle and the quarter a statement is for and gets the document.
 *
 * The account of examples 1, 2 and 8, in US$ millions: beginning 18.42, contributions 2.00,
 * distributions 0.35, net gain 0.87, ending 20.94, with contributions to date of 12.40. Example
 * 3 is the same account as a quarter of a whole vehicle.
 */

const OWN_ACCOUNT: StatementLines = {
  contributionsToDate: '12.40',
  distributionsToDate: '0.35',
  beginningBalance: '18.42',
  contributionsInPeriod: '2.00',
  distributionsInPeriod: '0.35',
  netGainLoss: '0.87',
  endingBalance: '20.94',
};

/** The same account as 25% of a vehicle: every line four times ours. */
const WHOLE_VEHICLE: StatementLines = {
  contributionsToDate: '49.60',
  distributionsToDate: '1.40',
  beginningBalance: '73.68',
  contributionsInPeriod: '8.00',
  distributionsInPeriod: '1.40',
  netGainLoss: '3.48',
  endingBalance: '83.76',
};

/** What an example changes of a statement written for a position: its lines and how they are stated. */
type ExampleShape = Pick<
  PositionStatementInput,
  'lines' | 'commitment' | 'denomination' | 'wholeVehicle'
>;

export const STATEMENT_EXAMPLES = {
  /** Example 1: our own account, and its lines add up. S = 20,940,000.00. */
  ties: { lines: OWN_ACCOUNT },
  /** Example 2: a net gain of 0.89 leaves the lines 20,000.00 apart, inside the tolerance of a statement in millions. */
  tiesWithinTolerance: { lines: { ...OWN_ACCOUNT, netGainLoss: '0.89' } },
  /** Example 2: a net gain of 0.92 leaves them 50,000.00 apart: the statement does not tie. S is unchanged. */
  doesNotTie: { lines: { ...OWN_ACCOUNT, netGainLoss: '0.92' } },
  /** Example 8: contributions to date of 30.00 against a record of 12.40. */
  contributionsDiffer: { lines: { ...OWN_ACCOUNT, contributionsToDate: '30.00' } },
  /** Example 3: the whole vehicle with our share of 25.00%. S = 20,940,000.00. */
  wholeVehicle: { lines: WHOLE_VEHICLE, wholeVehicle: { share: '0.2500' } },
  /** The whole vehicle and no share of ours: the five balance truths are null, so there is no value. */
  wholeVehicleNoShare: { lines: WHOLE_VEHICLE, wholeVehicle: { share: null } },
  /** Stated in euros: every money truth is null, and nothing is converted. */
  euro: { lines: OWN_ACCOUNT, denomination: 'EUR millions' },
  /** The same account stated in thousands. */
  thousands: {
    lines: {
      contributionsToDate: '12400.00',
      distributionsToDate: '350.00',
      beginningBalance: '18420.00',
      contributionsInPeriod: '2000.00',
      distributionsInPeriod: '350.00',
      netGainLoss: '870.00',
      endingBalance: '20940.00',
    },
    denomination: 'US$ thousands',
  },
  /**
   * A fund-style statement on a position: the commitment lines and the totals to date, and no
   * balance of ours, so it gives no value and its contributions differ from the position's.
   */
  fundStyle: {
    lines: {
      contributionsToDate: '86.25',
      distributionsToDate: '14.10',
      beginningBalance: null,
      contributionsInPeriod: null,
      distributionsInPeriod: null,
      netGainLoss: null,
      endingBalance: null,
    },
    commitment: { total: '120.00', unfunded: '33.75' },
  },
} as const satisfies Record<string, ExampleShape>;
export type StatementExample = keyof typeof STATEMENT_EXAMPLES;

/** Who an example statement is from and what it names: everything but its lines. */
export type StatementExampleTarget = Omit<
  PositionStatementInput,
  'lines' | 'commitment' | 'denomination' | 'wholeVehicle'
>;

/** An example statement written for the position, fund, vehicle and quarter given. */
export function statementExample(
  example: StatementExample,
  target: StatementExampleTarget,
): SyntheticDocument {
  return positionStatementDocument({ ...target, ...STATEMENT_EXAMPLES[example] });
}
