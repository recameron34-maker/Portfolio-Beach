import type {
  ClientList,
  Person,
  QaFindingRow,
  ReportPackageContent,
  ReportPackageDetail,
  ReportPackageList,
  ReportPackageRow,
} from '@pb/contracts';
import { runReportQa } from '@pb/report-engine';
import { ID } from './fixtures.js';
import { PERSON as VALUATION_PERSON } from './fixtures-valuations.js';

/*
 * Contract-shaped synthetic fixtures for the Reporting, Packages pages (docs/12 section 4:
 * synthetic data only). The content fixture carries the three lines the specification of the
 * pages works through: a position held and marked for the quarter, one with no Locked mark for
 * the quarter (carried at the prior mark, footnoted) and one entered in the quarter.
 */

export const PKG_ID = {
  /** Alpha, the latest quarter, gross, labelled final: QA failed on the label. */
  failed: '00000000-0000-4000-8000-000000000901',
  /** Alpha, the latest quarter, net: a Draft nobody has generated. */
  draft: '00000000-0000-4000-8000-000000000902',
  /** Beta, the latest quarter, net: in review. */
  inReview: '00000000-0000-4000-8000-000000000903',
  /** Alpha, the prior quarter, gross, version 2: approved after an override. */
  approved: '00000000-0000-4000-8000-000000000904',
  /** Alpha, the prior quarter, gross, version 1: released. */
  released: '00000000-0000-4000-8000-000000000905',
} as const;

export const CLIENT_ID = {
  alpha: '00000000-0000-4000-8000-000000000911',
  beta: '00000000-0000-4000-8000-000000000912',
} as const;

export const CLIENT = {
  alpha: { id: CLIENT_ID.alpha, name: 'Client Alpha Pension' },
  beta: { id: CLIENT_ID.beta, name: 'Client Beta Endowment' },
} as const;

/** The quarter the latest packages are for, the one before it, and the date the record is read as of. */
export const PKG_PERIOD = '2025-06-30';
export const PKG_PRIOR_PERIOD = '2025-03-31';
export const PKG_AS_OF = '2025-08-15';

/** Who prepares, approves and releases: an investor relations user, the approver and operations. */
export const PKG_PERSON: Readonly<Record<'preparer' | 'approver' | 'operations', Person>> = {
  preparer: { id: '00000000-0000-4000-8000-000000000321', name: 'Imogen Tavares' },
  approver: VALUATION_PERSON.approver,
  operations: VALUATION_PERSON.ops,
};

const NOT_RUN: ReportPackageRow['qa'] = { runNo: null, findings: 0, failed: 0, overridden: 0 };

export function packageRowFixture(overrides: Partial<ReportPackageRow> = {}): ReportPackageRow {
  return {
    id: PKG_ID.draft,
    client: CLIENT.alpha,
    periodEnd: PKG_PERIOD,
    asOf: PKG_AS_OF,
    basis: 'net',
    label: 'preliminary',
    version: 1,
    state: 'Draft',
    preparedBy: PKG_PERSON.preparer,
    reviewer: null,
    approvedAt: null,
    releasedAt: null,
    qa: NOT_RUN,
    rowVersion: 1,
    ...overrides,
  };
}

/** Five packages in the order the API lists them: newest period first, then client, basis and version. */
export function packageRows(): ReportPackageRow[] {
  return [
    packageRowFixture({
      id: PKG_ID.failed,
      basis: 'gross',
      label: 'final',
      state: 'QAFailed',
      qa: { runNo: 1, findings: 126, failed: 3, overridden: 0 },
      rowVersion: 3,
    }),
    packageRowFixture(),
    packageRowFixture({
      id: PKG_ID.inReview,
      client: CLIENT.beta,
      state: 'InReview',
      qa: { runNo: 1, findings: 98, failed: 0, overridden: 0 },
      rowVersion: 4,
    }),
    packageRowFixture({
      id: PKG_ID.approved,
      periodEnd: PKG_PRIOR_PERIOD,
      asOf: '2025-05-20',
      basis: 'gross',
      label: 'final',
      version: 2,
      state: 'Approved',
      reviewer: PKG_PERSON.approver,
      approvedAt: '2025-05-22T14:05:00.000Z',
      qa: { runNo: 2, findings: 120, failed: 2, overridden: 2 },
      rowVersion: 7,
    }),
    packageRowFixture({
      id: PKG_ID.released,
      periodEnd: PKG_PRIOR_PERIOD,
      asOf: '2025-05-10',
      basis: 'gross',
      label: 'final',
      state: 'Released',
      reviewer: PKG_PERSON.approver,
      approvedAt: '2025-05-12T09:30:00.000Z',
      releasedAt: '2025-05-12T16:00:00.000Z',
      qa: { runNo: 1, findings: 120, failed: 0, overridden: 0 },
      rowVersion: 6,
    }),
  ];
}

export function packageListFixture(items: ReportPackageRow[] = packageRows()): ReportPackageList {
  return { items };
}

/**
 * The snapshot of a generated package, with the three lines the pages must show as stored:
 * INV-0001 held and marked for the quarter; INV-0002 with no Locked mark for the quarter, carried
 * at the prior mark less the quarter's distribution and footnoted, with the client's 20% share;
 * INV-0003 entered in the quarter, with no begin NAV.
 */
export function packageContentFixture(
  overrides: Partial<ReportPackageContent> = {},
): ReportPackageContent {
  return {
    periodEnd: PKG_PERIOD,
    asOf: PKG_AS_OF,
    status: 'final',
    basis: 'gross',
    lines: [
      {
        ref: 'INV-0001',
        enteredInPeriod: false,
        beginNav: '11900000',
        contributions: '300000',
        distributions: '0',
        gainLoss: '250950.25',
        endNav: '12450950.25',
        endNavPeriodEnd: PKG_PERIOD,
        recordedQuarterStartNav: '11900000',
        latestFigureDate: PKG_PERIOD,
      },
      {
        ref: 'INV-0002',
        enteredInPeriod: false,
        beginNav: '4200000',
        contributions: '0',
        distributions: '125000.5',
        gainLoss: '0',
        endNav: '4074999.5',
        endNavPeriodEnd: PKG_PRIOR_PERIOD,
        recordedQuarterStartNav: '4200000',
        latestFigureDate: '2025-05-14',
      },
      {
        ref: 'INV-0003',
        enteredInPeriod: true,
        beginNav: null,
        contributions: '8000000',
        distributions: '0',
        gainLoss: '310000',
        endNav: '8310000',
        endNavPeriodEnd: PKG_PERIOD,
        recordedQuarterStartNav: null,
        latestFigureDate: PKG_PERIOD,
      },
    ],
    movers: ['INV-0001', 'INV-0002'],
    commentary: [],
    footnotes: [{ ref: 'INV-0002', code: 'stale_valuation' }],
    clientLines: [
      { clientRef: CLIENT_ID.alpha, ref: 'INV-0001', ownershipPct: '0.2', nav: '2490190.05' },
      { clientRef: CLIENT_ID.alpha, ref: 'INV-0002', ownershipPct: '0.2', nav: '814999.9' },
      { clientRef: CLIENT_ID.alpha, ref: 'INV-0003', ownershipPct: '0.2', nav: '1662000' },
    ],
    priorRelease: null,
    ...overrides,
  };
}

/**
 * The findings the report engine writes for a snapshot, as the API answers them: every finding of
 * run `runNo`, failed first, then by rule and by what it is about. They are the engine's own, so
 * a fixture never states an outcome the rules would not.
 */
export function packageFindingsFixture(
  content: ReportPackageContent = packageContentFixture(),
  runNo = 1,
): QaFindingRow[] {
  const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return runReportQa(content, { toleranceUsd: '1', moversCount: 5 })
    .sort(
      (a, b) =>
        Number(a.passed) - Number(b.passed) ||
        text(a.rule, b.rule) ||
        text(a.entityRef, b.entityRef),
    )
    .map((finding, i) => ({
      id: `00000000-0000-4000-8000-${String(950_000 + i).padStart(12, '0')}`,
      runNo,
      ...finding,
      override: null,
    }));
}

const qaOf = (findings: readonly QaFindingRow[]): ReportPackageRow['qa'] => ({
  runNo: findings[0]?.runNo ?? null,
  findings: findings.length,
  failed: findings.filter((f) => !f.passed).length,
  overridden: findings.filter((f) => f.override !== null).length,
});

/** A Draft as its page opens on it: nothing generated, no findings, no run. */
export function packageDetailFixture(
  overrides: Partial<ReportPackageDetail> = {},
): ReportPackageDetail {
  return {
    ...packageRowFixture(),
    correctionReason: null,
    contentHash: null,
    releasedBy: null,
    content: null,
    findings: [],
    tieOutExplanations: {},
    changeLog: [],
    ...overrides,
  };
}

/**
 * The final gross package of the latest quarter after its first generation: the three lines, the
 * engine's findings over them (the label check fails: final over a stale mark) and one run in
 * the change log. Row version 3: created, then the two writes of a generation. Given another
 * snapshot, the findings, the counts and the run are the engine's over that one.
 */
export function generatedDetailFixture(
  overrides: Partial<ReportPackageDetail> = {},
  content: ReportPackageContent = packageContentFixture(),
): ReportPackageDetail {
  const findings = packageFindingsFixture(content);
  const qa = qaOf(findings);
  return packageDetailFixture({
    id: PKG_ID.failed,
    basis: 'gross',
    label: 'final',
    state: qa.failed === 0 ? 'QAPassed' : 'QAFailed',
    qa,
    rowVersion: 3,
    content,
    findings,
    changeLog: [
      {
        at: '2025-08-15T10:12:00.000Z',
        by: PKG_PERSON.preparer,
        runNo: 1,
        lines: content.lines.length,
        findings: qa.findings,
        failed: qa.failed,
      },
    ],
    ...overrides,
  });
}

/**
 * A package as it stands once an approver overrode the failed checks of its run: every failed
 * finding carries the one reason, the approver and the time, and the package is QA passed. Row
 * version one on from the run it overrides.
 */
export function overriddenDetailFixture(
  overrides: Partial<ReportPackageDetail> = {},
): ReportPackageDetail {
  const generated = generatedDetailFixture();
  const findings = generated.findings.map((finding) =>
    finding.passed
      ? finding
      : {
          ...finding,
          override: {
            reason: 'The stale mark is disclosed in the cover letter.',
            approver: PKG_PERSON.approver,
            at: '2025-08-16T09:00:00.000Z',
          },
        },
  );
  return {
    ...generated,
    state: 'QAPassed',
    findings,
    qa: qaOf(findings),
    rowVersion: generated.rowVersion + 1,
    ...overrides,
  };
}

/**
 * The clients an investor relations user is entitled to, as GET /clients answers them: Alpha
 * reports gross and net, Beta net only. The as-of date gives the start form its quarters.
 */
export function packageClientsFixture(): ClientList {
  const client = (
    id: string,
    name: string,
    reportingBases: string[],
  ): ClientList['items'][number] => ({
    id,
    name,
    reportingBases,
    reportingCadence: 'quarterly',
    vehicles: [
      {
        vehicleId: ID.vehicle1,
        vehicleName: 'Beach Co-Invest Fund I',
        vehicleType: 'vehicle_type.co_invest_fund',
        commitment: '50000000.00',
        closingNumber: 1,
        ownershipPct: '0.2',
        commitmentDate: '2020-03-31',
        invested: null,
        distributions: null,
        nav: null,
        grossMoic: null,
      },
    ],
    totals: {
      commitment: '50000000.00',
      invested: null,
      distributions: null,
      nav: null,
      grossMoic: null,
    },
  });
  return {
    asOf: PKG_AS_OF,
    items: [
      client(CLIENT_ID.alpha, CLIENT.alpha.name, ['gross', 'net']),
      client(CLIENT_ID.beta, CLIENT.beta.name, ['net']),
    ],
    calcVersion: 'test',
  };
}
