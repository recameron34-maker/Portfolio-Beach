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
