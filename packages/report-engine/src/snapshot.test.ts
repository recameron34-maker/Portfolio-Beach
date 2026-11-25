import { describe, expect, it } from 'vitest';
import { STALE_FOOTNOTE, qaPassed, runReportQa } from './qa.js';
import type { QaFinding } from './qa.js';
import { buildPackageSnapshot, snapshotRequestOf } from './snapshot.js';
import type {
  PositionRecord,
  PositionSource,
  SnapshotRequest,
  SnapshotSource,
} from './snapshot.js';

/*
 * The package snapshot (docs/08 section 7, fixture 26): lines built from Locked marks and
 * approved flows, each amount worked by hand in the comment beside it, then read by the QA rules.
 */

const PERIOD = '2025-06-30';
const START = '2025-03-31';
const SETTINGS = { toleranceUsd: '1', moversCount: 3 };
/** How far a mark may be dated from the quarter end it reports for (priorYearPeriodEndToleranceDays). */
const TOLERANCE_DAYS = 7;

const position = (ref: string, over: Partial<PositionRecord> = {}): PositionRecord => ({
  ref,
  vehicleRef: 'VEH-1',
  entryDate: '2022-01-15',
  exitDate: null,
  marks: [
    { periodEnd: '2024-12-31', nav: '80' },
    { periodEnd: START, nav: '100' },
    { periodEnd: PERIOD, nav: '120' },
  ],
  flows: [
    // Before the quarter: not in it.
    { date: '2025-02-01', kind: 'contribution', amount: '-7' },
    { date: START, kind: 'distribution', amount: '3' },
    // In the quarter: 10 in, 5 out (4 + 1 of interest). The fee is paid outside the position.
    { date: '2025-05-10', kind: 'contribution', amount: '-10' },
    { date: '2025-06-01', kind: 'distribution', amount: '4' },
    { date: PERIOD, kind: 'interest', amount: '1' },
    { date: '2025-06-15', kind: 'fee', amount: '-0.5' },
    // After the quarter: not in it.
    { date: '2025-07-02', kind: 'contribution', amount: '-9' },
  ],
  ...over,
});

const request = (
  positions: PositionRecord[],
  over: Partial<SnapshotRequest> = {},
): SnapshotRequest => ({
  periodEnd: PERIOD,
  asOf: '2025-08-09',
  label: 'final',
  basis: 'gross',
  positions,
  shares: [],
  priorRelease: null,
  commentary: [],
  moversCount: SETTINGS.moversCount,
  toleranceDays: TOLERANCE_DAYS,
  ...over,
});

const lineOf = (positions: PositionRecord[], ref: string, over: Partial<SnapshotRequest> = {}) => {
  const line = buildPackageSnapshot(request(positions, over)).lines.find((l) => l.ref === ref);
  if (line === undefined) throw new Error(`no line ${ref}`);
  return line;
};
const failed = (findings: readonly QaFinding[]): string[] =>
  findings.filter((f) => !f.passed).map((f) => `${f.rule} ${f.entityRef}`);

describe('package snapshot: lines from Locked marks and approved flows', () => {
  it('builds a held position from the quarter alone', () => {
    // 100 + 10 - 5 + 15 = 120
    expect(lineOf([position('INV-A')], 'INV-A')).toEqual({
      ref: 'INV-A',
      enteredInPeriod: false,
      beginNav: '100',
      contributions: '10',
      distributions: '5',
      gainLoss: '15',
      endNav: '120',
      endNavPeriodEnd: PERIOD,
      endNavMarkDate: PERIOD,
      recordedQuarterStartNav: '100',
      latestFigureDate: PERIOD,
    });
  });

  it('starts the quarter from the end of the prior quarter, never from the year (qtd_ytd_basis)', () => {
    const snapshot = buildPackageSnapshot(request([position('INV-A')]));
    expect(snapshot.lines[0]?.beginNav).toBe('100');
    expect(failed(runReportQa(snapshot, SETTINGS))).toEqual([]);
    // The same position on a table started from the year: 80 + 17 - 8 + 31 = 120 rolls forward,
    // and the basis rule is what refuses it.
    const fromYear = {
      ...snapshot,
      lines: [
        {
          ...snapshot.lines[0]!,
          beginNav: '80',
          contributions: '17',
          distributions: '8',
          gainLoss: '31',
        },
      ],
      movers: ['INV-A'],
    };
    expect(failed(runReportQa(fromYear, SETTINGS))).toEqual(['QA-QTD-01 INV-A']);
  });

  it('starts a position entered in the quarter from zero', () => {
    // 0 + 40 - 0 + 2 = 42
    const entered = position('INV-N', {
      entryDate: '2025-04-15',
      marks: [{ periodEnd: PERIOD, nav: '42' }],
      flows: [{ date: '2025-04-15', kind: 'contribution', amount: '-40' }],
    });
    expect(lineOf([entered], 'INV-N')).toMatchObject({
      enteredInPeriod: true,
      beginNav: null,
      contributions: '40',
      distributions: '0',
      gainLoss: '2',
      endNav: '42',
    });
    expect(failed(runReportQa(buildPackageSnapshot(request([entered])), SETTINGS))).toEqual([]);
  });

  it('ends a position exited in the quarter at zero, and leaves out one exited before it', () => {
    // 100 + 0 - 130 + 30 = 0
    const exited = position('INV-X', {
      exitDate: '2025-05-20',
      marks: [{ periodEnd: START, nav: '100' }],
      flows: [{ date: '2025-05-20', kind: 'distribution', amount: '130' }],
    });
    expect(lineOf([exited], 'INV-X')).toMatchObject({
      beginNav: '100',
      distributions: '130',
      gainLoss: '30',
      endNav: '0',
      endNavPeriodEnd: PERIOD,
      // No mark stands behind a zero: the position is gone.
      endNavMarkDate: null,
    });
    const gone = position('INV-G', { exitDate: START });
    const later = position('INV-L', { entryDate: '2025-07-01' });
    expect(buildPackageSnapshot(request([exited, gone, later])).lines.map((l) => l.ref)).toEqual([
      'INV-X',
    ]);
    expect(failed(runReportQa(buildPackageSnapshot(request([exited])), SETTINGS))).toEqual([]);
  });

  it('rolls a stale mark forward with the flows since it, and footnotes it (stale_valuation)', () => {
    // No mark for June. The March mark of 100, plus 10 in, less 5 out: 105, and no gain.
    const stale = position('INV-S', {
      marks: [
        { periodEnd: '2024-12-31', nav: '80' },
        { periodEnd: START, nav: '100' },
      ],
    });
    const snapshot = buildPackageSnapshot(request([stale], { label: 'preliminary' }));
    expect(snapshot.lines[0]).toMatchObject({
      beginNav: '100',
      contributions: '10',
      distributions: '5',
      gainLoss: '0',
      endNav: '105',
      endNavPeriodEnd: START,
      endNavMarkDate: START,
    });
    expect(snapshot.footnotes).toEqual([{ ref: 'INV-S', code: STALE_FOOTNOTE }]);
    expect(failed(runReportQa(snapshot, SETTINGS))).toEqual([]);
    // The same package cannot be called final.
    expect(failed(runReportQa(buildPackageSnapshot(request([stale])), SETTINGS))).toEqual([
      'QA-LBL-01 status',
    ]);
  });

  it('rolls a mark two quarters old forward from its own date, and has no begin NAV to show', () => {
    // The December mark of 80, plus 7 + 10 in, less 3 + 5 out since: 89. March has no mark.
    const older = position('INV-O', { marks: [{ periodEnd: '2024-12-31', nav: '80' }] });
    const snapshot = buildPackageSnapshot(request([older], { label: 'preliminary' }));
    expect(snapshot.lines[0]).toMatchObject({
      beginNav: null,
      recordedQuarterStartNav: null,
      endNav: '89',
      endNavPeriodEnd: '2024-12-31',
      gainLoss: null,
    });
    expect(failed(runReportQa(snapshot, SETTINGS))).toEqual([
      'QA-QTD-01 INV-O',
      'QA-RF-01 INV-O',
      'QA-SIGN-01 INV-O',
    ]);
  });

  it('shows no begin NAV when the prior quarter has no Locked mark (roll_forward_break)', () => {
    const broken = position('INV-B', {
      marks: [
        { periodEnd: '2024-12-31', nav: '80' },
        { periodEnd: PERIOD, nav: '120' },
      ],
    });
    const snapshot = buildPackageSnapshot(request([broken]));
    expect(snapshot.lines[0]).toMatchObject({
      beginNav: null,
      recordedQuarterStartNav: null,
      endNav: '120',
      gainLoss: null,
    });
    const findings = runReportQa(snapshot, SETTINGS);
    expect(qaPassed(findings)).toBe(false);
    expect(failed(findings)).toContain('QA-QTD-01 INV-B');
  });

  it('has no end NAV for a position with no Locked mark at all', () => {
    const unmarked = position('INV-U', { marks: [] });
    expect(lineOf([unmarked], 'INV-U')).toMatchObject({ endNav: null, endNavPeriodEnd: null });
    expect(failed(runReportQa(buildPackageSnapshot(request([unmarked])), SETTINGS))).toContain(
      'QA-RDY-01 INV-U',
    );
  });

  it('gives each client its share of the positions of the vehicles it is in (two_clients_one_fund)', () => {
    const other = position('INV-Z', { vehicleRef: 'VEH-2' });
    const snapshot = buildPackageSnapshot(
      request([position('INV-A'), other], {
        shares: [
          { clientRef: 'CLIENT-1', vehicleRef: 'VEH-1', ownershipPct: '0.25' },
          { clientRef: 'CLIENT-2', vehicleRef: 'VEH-1', ownershipPct: '0.4' },
        ],
      }),
    );
    // 25% and 40% of 120; nobody is in VEH-2.
    expect(snapshot.clientLines).toEqual([
      { clientRef: 'CLIENT-1', ref: 'INV-A', ownershipPct: '0.25', nav: '30' },
      { clientRef: 'CLIENT-2', ref: 'INV-A', ownershipPct: '0.4', nav: '48' },
    ]);
    expect(failed(runReportQa(snapshot, SETTINGS))).toEqual([]);
  });

  it('orders lines by position number, ranks the movers and carries the labels, commentary and prior release', () => {
    // A up 20%, C up 50% (200 to 300), no flows.
    const c = position('INV-C', {
      marks: [
        { periodEnd: START, nav: '200' },
        { periodEnd: PERIOD, nav: '300' },
      ],
      flows: [],
    });
    const prior = { endNav: { 'INV-A': '100', 'INV-C': '200' }, explanations: {} };
    const snapshot = buildPackageSnapshot(
      request([c, position('INV-A')], {
        label: 'preliminary',
        basis: 'net',
        priorRelease: prior,
        commentary: [{ ref: 'INV-C', moversKey: 'INV-C|INV-A' }],
      }),
    );
    expect(snapshot.lines.map((l) => l.ref)).toEqual(['INV-A', 'INV-C']);
    expect(snapshot.movers).toEqual(['INV-C', 'INV-A']);
    expect(snapshot).toMatchObject({
      periodEnd: PERIOD,
      asOf: '2025-08-09',
      status: 'preliminary',
      basis: 'net',
      priorRelease: prior,
    });
    expect(failed(runReportQa(snapshot, SETTINGS))).toEqual([]);
  });

  it('refuses a tolerance that is not a whole number of days, zero or more', () => {
    for (const toleranceDays of [-1, 1.5, Number.NaN])
      expect(() => buildPackageSnapshot(request([], { toleranceDays }))).toThrow(/tolerance/);
    expect(buildPackageSnapshot(request([], { toleranceDays: 0 })).lines).toEqual([]);
  });

  it('refuses a period that is not a quarter end, an as-of date before it, and two positions with one number', () => {
    expect(() => buildPackageSnapshot(request([], { periodEnd: '2025-06-29' }))).toThrow(
      /quarter end/,
    );
    expect(() => buildPackageSnapshot(request([], { asOf: '2025-06-29' }))).toThrow(/as-of/);
    expect(() => buildPackageSnapshot(request([position('INV-A'), position('INV-A')]))).toThrow(
      /INV-A/,
    );
  });
});

/*
 * A sponsor that closes its books a few days off the quarter end (period_end_shift, docs/14). A
 * Locked mark reports for the quarter end it is within the tolerance of, as it does on the
 * valuation board and in the weekly report (alignedQuarterEnd, lockedNear), and a line's flows
 * are those between the dates of its two marks, so each flow is in one quarter's line.
 */
describe('package snapshot: a mark dated a few days off the quarter end it reports for', () => {
  /** Closes three days early every quarter: December the 28th, March the 28th, June the 27th. */
  const early = (over: Partial<PositionRecord> = {}): PositionRecord =>
    position('INV-P', {
      marks: [
        { periodEnd: '2024-12-28', nav: '80' },
        { periodEnd: '2025-03-28', nav: '100' },
        { periodEnd: '2025-06-27', nav: '120' },
      ],
      flows: [
        // Before the March close: the March mark holds it.
        { date: '2025-03-27', kind: 'contribution', amount: '-7' },
        // After the March close and before the calendar quarter end: the June line's.
        { date: '2025-03-30', kind: 'contribution', amount: '-6' },
        { date: '2025-05-10', kind: 'contribution', amount: '-10' },
        { date: '2025-06-01', kind: 'distribution', amount: '4' },
        // After the June close and before the calendar quarter end: the September line's.
        { date: '2025-06-29', kind: 'distribution', amount: '2' },
      ],
      ...over,
    });

  it("reads the two marks as the quarter's own: a begin NAV, a gain, no footnote, and every check passes", () => {
    const snapshot = buildPackageSnapshot(request([early()]));
    // 100 + (6 + 10) - 4 + 8 = 120
    expect(snapshot.lines).toEqual([
      {
        ref: 'INV-P',
        enteredInPeriod: false,
        beginNav: '100',
        contributions: '16',
        distributions: '4',
        gainLoss: '8',
        endNav: '120',
        // The quarter the mark reports for, and the date the sponsor closed its books on.
        endNavPeriodEnd: PERIOD,
        endNavMarkDate: '2025-06-27',
        recordedQuarterStartNav: '100',
        latestFigureDate: '2025-06-27',
      },
    ]);
    expect(snapshot.footnotes).toEqual([]);
    // Labelled final: a mark for the quarter is not a stale one.
    expect(failed(runReportQa(snapshot, SETTINGS))).toEqual([]);
  });

  it('gives the gain two Locked marks give when nothing flowed between them', () => {
    // 28,234,431.95 - 24,572,464.49 = 3,661,967.46
    const line = lineOf(
      [
        position('INV-0002', {
          marks: [
            { periodEnd: '2025-03-28', nav: '24572464.49' },
            { periodEnd: '2025-06-27', nav: '28234431.95' },
          ],
          flows: [],
        }),
      ],
      'INV-0002',
    );
    expect(line).toMatchObject({
      beginNav: '24572464.49',
      endNav: '28234431.95',
      gainLoss: '3661967.46',
      endNavPeriodEnd: PERIOD,
      endNavMarkDate: '2025-06-27',
    });
  });

  it("gives a flow dated after the sponsor's close to the quarter after, so it is counted once", () => {
    const next = early({
      marks: [
        { periodEnd: '2025-03-28', nav: '100' },
        { periodEnd: '2025-06-27', nav: '120' },
        { periodEnd: '2025-09-26', nav: '130' },
      ],
    });
    const september = buildPackageSnapshot(
      request([next], { periodEnd: '2025-09-30', asOf: '2025-10-15' }),
    );
    // The June mark of the 27th does not hold the 2 paid out on the 29th: 120 + 0 - 2 + 12 = 130.
    expect(september.lines[0]).toMatchObject({
      beginNav: '120',
      contributions: '0',
      distributions: '2',
      gainLoss: '12',
      endNav: '130',
      endNavPeriodEnd: '2025-09-30',
      endNavMarkDate: '2025-09-26',
    });
    expect(failed(runReportQa(september, SETTINGS))).toEqual([]);
    // June's line and September's between them hold every flow after the March close, once:
    // 16 and 0 in, 4 and 2 out.
    const june = lineOf([next], 'INV-P');
    expect([june.contributions, june.distributions]).toEqual(['16', '4']);
  });

  it('rolls a stale mark forward from its own date, and says both the quarter it is for and its date', () => {
    const stale = early({
      marks: [
        { periodEnd: '2024-12-28', nav: '80' },
        { periodEnd: '2025-03-28', nav: '100' },
      ],
    });
    const snapshot = buildPackageSnapshot(request([stale], { label: 'preliminary' }));
    // No mark for June: the mark of March the 28th, plus 16 in and less 4 + 2 out since it, to the
    // quarter end: 110, and no gain.
    expect(snapshot.lines[0]).toMatchObject({
      beginNav: '100',
      contributions: '16',
      distributions: '6',
      gainLoss: '0',
      endNav: '110',
      endNavPeriodEnd: START,
      endNavMarkDate: '2025-03-28',
      latestFigureDate: '2025-06-29',
    });
    expect(snapshot.footnotes).toEqual([{ ref: 'INV-P', code: STALE_FOOTNOTE }]);
    expect(failed(runReportQa(snapshot, SETTINGS))).toEqual([]);
    expect(failed(runReportQa(buildPackageSnapshot(request([stale])), SETTINGS))).toEqual([
      'QA-LBL-01 status',
    ]);
  });

  it("reads a mark dated a few days after the quarter end as that quarter's", () => {
    const late = position('INV-L', {
      marks: [
        { periodEnd: START, nav: '100' },
        { periodEnd: '2025-07-03', nav: '120' },
      ],
      flows: [
        { date: '2025-05-10', kind: 'contribution', amount: '-10' },
        // Before the sponsor's close of July the 3rd: the mark holds it, so the line does.
        { date: '2025-07-02', kind: 'contribution', amount: '-9' },
        { date: '2025-07-04', kind: 'distribution', amount: '5' },
      ],
    });
    // 100 + (10 + 9) - 0 + 1 = 120
    expect(lineOf([late], 'INV-L')).toMatchObject({
      beginNav: '100',
      contributions: '19',
      distributions: '0',
      gainLoss: '1',
      endNav: '120',
      endNavPeriodEnd: PERIOD,
      endNavMarkDate: '2025-07-03',
      latestFigureDate: '2025-07-03',
    });
    // The quarter after starts from it, and from its date: 120 + 0 - 5 + 15 = 130.
    const after = position('INV-L', {
      marks: [...late.marks, { periodEnd: '2025-09-30', nav: '130' }],
      flows: late.flows,
    });
    expect(lineOf([after], 'INV-L', { periodEnd: '2025-09-30', asOf: '2025-10-15' })).toMatchObject(
      { beginNav: '120', contributions: '0', distributions: '5', gainLoss: '15' },
    );
  });

  it('folds a mark on the edge of the tolerance and not one a day beyond it', () => {
    const flows: PositionRecord['flows'] = [
      { date: '2025-05-10', kind: 'contribution', amount: '-10' },
      { date: '2025-06-25', kind: 'contribution', amount: '-3' },
    ];
    // Seven days before the quarter end: the quarter's mark. 100 + 10 - 0 + 8 = 118; the 3 paid
    // in on the 25th is after it.
    const onEdge = position('INV-E', {
      marks: [
        { periodEnd: START, nav: '100' },
        { periodEnd: '2025-06-23', nav: '118' },
      ],
      flows,
    });
    expect(lineOf([onEdge], 'INV-E')).toMatchObject({
      contributions: '10',
      gainLoss: '8',
      endNav: '118',
      endNavPeriodEnd: PERIOD,
      endNavMarkDate: '2025-06-23',
    });
    // Eight days before: a mark for no quarter end. It is carried and rolled forward like any
    // earlier mark, 118 + 3 = 121 with the whole quarter's flows, and footnoted: 100 + 13 - 0 + 8.
    const beyond = position('INV-E', {
      marks: [
        { periodEnd: START, nav: '100' },
        { periodEnd: '2025-06-22', nav: '118' },
      ],
      flows,
    });
    const snapshot = buildPackageSnapshot(request([beyond], { label: 'preliminary' }));
    expect(snapshot.lines[0]).toMatchObject({
      contributions: '13',
      gainLoss: '8',
      endNav: '121',
      endNavPeriodEnd: '2025-06-22',
      endNavMarkDate: '2025-06-22',
    });
    expect(snapshot.footnotes).toEqual([{ ref: 'INV-E', code: STALE_FOOTNOTE }]);
    // With no tolerance only the quarter end itself is the quarter's.
    expect(lineOf([early()], 'INV-P', { toleranceDays: 0, label: 'preliminary' })).toMatchObject({
      beginNav: null,
      endNavPeriodEnd: '2025-06-27',
      endNavMarkDate: '2025-06-27',
    });
  });

  it('takes the later of two Locked marks that report for one quarter end', () => {
    const two = position('INV-T', {
      marks: [
        { periodEnd: START, nav: '100' },
        { periodEnd: '2025-06-27', nav: '119' },
        { periodEnd: PERIOD, nav: '120' },
      ],
      flows: [],
    });
    expect(lineOf([two], 'INV-T')).toMatchObject({ endNav: '120', endNavMarkDate: PERIOD });
  });

  it('starts a position entered in the quarter from zero and from the quarter start, whatever mark reports for it', () => {
    // Entered April the 2nd; the sponsor's March close of April the 3rd reports for March.
    const entered = position('INV-N', {
      entryDate: '2025-04-02',
      marks: [
        { periodEnd: '2025-04-03', nav: '41' },
        { periodEnd: PERIOD, nav: '42' },
      ],
      flows: [{ date: '2025-04-02', kind: 'contribution', amount: '-40' }],
    });
    // 0 + 40 - 0 + 2 = 42
    expect(lineOf([entered], 'INV-N')).toMatchObject({
      enteredInPeriod: true,
      beginNav: null,
      contributions: '40',
      gainLoss: '2',
      endNav: '42',
    });
    expect(failed(runReportQa(buildPackageSnapshot(request([entered])), SETTINGS))).toEqual([]);
  });
});

/*
 * The snapshot request read from the record (snapshotRequestOf): what the API holds in its tables
 * and the static preview in its recordings becomes the same request, so both build one snapshot.
 */

const stored = (ref: string, over: Partial<PositionSource> = {}): PositionSource => ({
  ref,
  vehicleRef: 'VEH-1',
  entryDate: '2022-01-15',
  exitDate: null,
  valuations: [
    { periodEnd: START, state: 'Locked', fairValue: '100' },
    { periodEnd: PERIOD, state: 'Locked', fairValue: '120' },
  ],
  flows: [
    { date: '2025-05-10', flowType: 'flow_type.contribution', amount: '-10' },
    { date: '2025-06-01', flowType: 'flow_type.distribution', amount: '5' },
  ],
  ...over,
});

const source = (over: Partial<SnapshotSource> = {}): SnapshotSource => ({
  clientRef: 'CLIENT-1',
  periodEnd: PERIOD,
  asOf: '2025-08-09',
  label: 'final',
  basis: 'gross',
  commitments: [{ vehicleRef: 'VEH-1', ownershipPct: '0.25' }],
  positions: [stored('INV-A')],
  released: [],
  explanations: {},
  moversCount: SETTINGS.moversCount,
  toleranceDays: TOLERANCE_DAYS,
  ...over,
});

describe('snapshot request: read from the record', () => {
  it('carries the package, its positions and the client share, with no commentary and no prior release', () => {
    expect(snapshotRequestOf(source())).toEqual({
      periodEnd: PERIOD,
      asOf: '2025-08-09',
      label: 'final',
      basis: 'gross',
      positions: [
        {
          ref: 'INV-A',
          vehicleRef: 'VEH-1',
          entryDate: '2022-01-15',
          exitDate: null,
          marks: [
            { periodEnd: START, nav: '100' },
            { periodEnd: PERIOD, nav: '120' },
          ],
          flows: [
            { date: '2025-05-10', kind: 'contribution', amount: '-10' },
            { date: '2025-06-01', kind: 'distribution', amount: '5' },
          ],
        },
      ],
      shares: [{ clientRef: 'CLIENT-1', vehicleRef: 'VEH-1', ownershipPct: '0.25' }],
      priorRelease: null,
      commentary: [],
      moversCount: SETTINGS.moversCount,
      toleranceDays: TOLERANCE_DAYS,
    });
    // 100 + 10 - 5 + 15 = 120, and a quarter of 120 is the client's.
    const snapshot = buildPackageSnapshot(snapshotRequestOf(source()));
    expect(snapshot.lines[0]).toMatchObject({ beginNav: '100', gainLoss: '15', endNav: '120' });
    expect(snapshot.clientLines).toEqual([
      { clientRef: 'CLIENT-1', ref: 'INV-A', ownershipPct: '0.25', nav: '30' },
    ]);
  });

  it('reads Locked marks only: a draft, a mark in review or a superseded one is not a mark', () => {
    const request = snapshotRequestOf(
      source({
        positions: [
          stored('INV-A', {
            valuations: [
              { periodEnd: START, state: 'Superseded', fairValue: '90' },
              { periodEnd: START, state: 'Locked', fairValue: '100' },
              { periodEnd: PERIOD, state: 'Draft', fairValue: '130' },
              { periodEnd: PERIOD, state: 'ApproverReview', fairValue: '131' },
            ],
          }),
        ],
      }),
    );
    expect(request.positions[0]?.marks).toEqual([{ periodEnd: START, nav: '100' }]);
    // With no Locked mark for the quarter the line is the last one rolled forward: 100 + 10 - 5.
    const line = buildPackageSnapshot(request).lines[0];
    expect(line).toMatchObject({ endNav: '105', endNavPeriodEnd: START, gainLoss: '0' });
  });

  it('reads a mark dated on or before the as-of date and none after it, whatever quarter it reports for', () => {
    // The sponsor closes June on July the 3rd. Read as of July the 1st that mark is not known.
    const valuations = [
      { periodEnd: START, state: 'Locked', fairValue: '100' },
      { periodEnd: '2025-07-03', state: 'Locked', fairValue: '120' },
    ];
    const positions = [stored('INV-A', { valuations })];
    const early = snapshotRequestOf(source({ positions, asOf: '2025-07-01' }));
    expect(early.positions[0]?.marks).toEqual([{ periodEnd: START, nav: '100' }]);
    // The March mark is carried: 100 + 10 - 5.
    expect(buildPackageSnapshot(early).lines[0]).toMatchObject({
      endNav: '105',
      endNavPeriodEnd: START,
      endNavMarkDate: START,
    });
    // Read on the day of the mark it is the quarter's: 120 - 100 - 10 + 5 = 15.
    const known = snapshotRequestOf(source({ positions, asOf: '2025-07-03' }));
    expect(known.positions[0]?.marks).toHaveLength(2);
    expect(buildPackageSnapshot(known).lines[0]).toMatchObject({
      endNav: '120',
      gainLoss: '15',
      endNavPeriodEnd: PERIOD,
      endNavMarkDate: '2025-07-03',
    });
  });

  it("carries the tolerance to the request, so a sponsor's early close is the quarter's mark", () => {
    const valuations = [
      { periodEnd: '2025-03-28', state: 'Locked', fairValue: '24572464.49' },
      { periodEnd: '2025-06-27', state: 'Locked', fairValue: '28234431.95' },
    ];
    const request = snapshotRequestOf(
      source({ positions: [stored('INV-0002', { valuations, flows: [] })] }),
    );
    expect(request.toleranceDays).toBe(TOLERANCE_DAYS);
    // The marks keep their own dates: which quarter each reports for is the snapshot's to say.
    expect(request.positions[0]?.marks.map((m) => m.periodEnd)).toEqual([
      '2025-03-28',
      '2025-06-27',
    ]);
    const snapshot = buildPackageSnapshot(request);
    expect(snapshot.lines[0]).toMatchObject({
      beginNav: '24572464.49',
      gainLoss: '3661967.46',
      endNav: '28234431.95',
      endNavPeriodEnd: PERIOD,
      endNavMarkDate: '2025-06-27',
    });
    expect(snapshot.footnotes).toEqual([]);
    expect(failed(runReportQa(snapshot, SETTINGS))).toEqual([]);
  });

  it('reads flows up to the as-of date and none after it', () => {
    const flows = [
      { date: '2025-06-30', flowType: 'flow_type.interest', amount: '1' },
      { date: '2025-08-09', flowType: 'flow_type.principal', amount: '2' },
      { date: '2025-08-10', flowType: 'flow_type.contribution', amount: '-3' },
    ];
    const request = snapshotRequestOf(source({ positions: [stored('INV-A', { flows })] }));
    expect(request.positions[0]?.flows).toEqual([
      { date: '2025-06-30', kind: 'interest', amount: '1' },
      { date: '2025-08-09', kind: 'principal', amount: '2' },
    ]);
  });

  it('skips a commitment with no share on record, and still shows the positions of its vehicle', () => {
    const request = snapshotRequestOf(
      source({
        commitments: [
          { vehicleRef: 'VEH-2', ownershipPct: null },
          { vehicleRef: 'VEH-1', ownershipPct: '0.25' },
        ],
        positions: [stored('INV-A'), stored('INV-B', { vehicleRef: 'VEH-2' })],
      }),
    );
    expect(request.shares).toEqual([
      { clientRef: 'CLIENT-1', vehicleRef: 'VEH-1', ownershipPct: '0.25' },
    ]);
    expect(request.positions.map((p) => p.ref)).toEqual(['INV-A', 'INV-B']);
    const snapshot = buildPackageSnapshot(request);
    expect(snapshot.lines.map((l) => l.ref)).toEqual(['INV-A', 'INV-B']);
    // No share of VEH-2 is on record, so INV-B has no client line: never a zero share.
    expect(snapshot.clientLines.map((c) => c.ref)).toEqual(['INV-A']);
  });

  it('orders the shares by vehicle, whatever order the commitments were read in', () => {
    const commitments = [
      { vehicleRef: 'VEH-2', ownershipPct: '0.5' },
      { vehicleRef: 'VEH-1', ownershipPct: '0.25' },
      { vehicleRef: 'VEH-2', ownershipPct: '0.1' },
    ];
    const shares = snapshotRequestOf(source({ commitments })).shares;
    // Two commitments to one vehicle keep the order they were read in.
    expect(shares.map((s) => `${s.vehicleRef} ${s.ownershipPct}`)).toEqual([
      'VEH-1 0.25',
      'VEH-2 0.5',
      'VEH-2 0.1',
    ]);
  });

  it('leaves out a position of a vehicle the client is not committed to', () => {
    const request = snapshotRequestOf(
      source({ positions: [stored('INV-A'), stored('INV-X', { vehicleRef: 'VEH-9' })] }),
    );
    expect(request.positions.map((p) => p.ref)).toEqual(['INV-A']);
  });

  it('picks the prior release: the latest earlier quarter, and its highest version', () => {
    const lines = (endNav: string | null) => [{ ref: 'INV-A', endNav }];
    const request = snapshotRequestOf(
      source({
        released: [
          { periodEnd: '2024-12-31', version: 1, lines: lines('80') },
          { periodEnd: START, version: 1, lines: lines('99') },
          { periodEnd: START, version: 2, lines: lines('100') },
          // The same quarter, released before and now being corrected: not a prior release.
          { periodEnd: PERIOD, version: 1, lines: lines('120') },
          // A later quarter is never what this one ties to.
          { periodEnd: '2025-09-30', version: 1, lines: lines('140') },
        ],
        explanations: { 'INV-A': 'Restated by the sponsor' },
      }),
    );
    expect(request.priorRelease).toEqual({
      endNav: { 'INV-A': '100' },
      explanations: { 'INV-A': 'Restated by the sponsor' },
    });
    // The pick does not depend on the order the releases were read in.
    const reversed = snapshotRequestOf(
      source({
        released: [
          { periodEnd: START, version: 2, lines: lines('100') },
          { periodEnd: START, version: 1, lines: lines('99') },
          { periodEnd: '2024-12-31', version: 3, lines: lines('80') },
        ],
      }),
    );
    expect(reversed.priorRelease?.endNav).toEqual({ 'INV-A': '100' });
  });

  it('has no prior release without an earlier one, or when the stored one cannot be read', () => {
    expect(snapshotRequestOf(source()).priorRelease).toBeNull();
    expect(
      snapshotRequestOf(source({ released: [{ periodEnd: PERIOD, version: 1, lines: [] }] }))
        .priorRelease,
    ).toBeNull();
    // The latest earlier release is the prior one even when it cannot be read: an older one
    // is never read in its place.
    expect(
      snapshotRequestOf(
        source({
          released: [
            { periodEnd: '2024-12-31', version: 1, lines: [{ ref: 'INV-A', endNav: '80' }] },
            { periodEnd: START, version: 1, lines: null },
          ],
        }),
      ).priorRelease,
    ).toBeNull();
  });

  it('ties to the prior release only where it showed an end NAV', () => {
    const request = snapshotRequestOf(
      source({
        released: [
          {
            periodEnd: START,
            version: 1,
            lines: [
              { ref: 'INV-A', endNav: '100' },
              { ref: 'INV-U', endNav: null },
            ],
          },
        ],
      }),
    );
    expect(request.priorRelease).toEqual({ endNav: { 'INV-A': '100' }, explanations: {} });
    expect(failed(runReportQa(buildPackageSnapshot(request), SETTINGS))).toEqual([]);
  });
});
