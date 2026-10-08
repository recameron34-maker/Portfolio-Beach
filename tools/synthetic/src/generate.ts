import { D, addDays, addMonths, compareIso } from '@pb/calc';
import type { SyntheticDataset } from '@pb/db';
import { NameFactory, canonical } from './names.js';
import { Rng } from './prng.js';
import { PROFILES } from './profiles.js';
import type { Profile } from './profiles.js';

export interface GenerateOptions {
  profile?: string;
  seed?: number;
  /** The reporting date the dataset is built up to (quarter end). */
  asOf?: string;
}

type Users = SyntheticDataset['users'];
type Investment = SyntheticDataset['investments'][number];

const SECTORS = [
  'sector.software',
  'sector.healthcare',
  'sector.industrials',
  'sector.consumer',
  'sector.business_services',
  'sector.financials',
  'sector.energy_transition',
];
const GEOS = [
  { value: 'geography.north_america', weight: 6 },
  { value: 'geography.europe', weight: 3 },
  { value: 'geography.asia_pacific', weight: 1 },
];
const TIERS = [
  { value: 'sponsor_tier.core', weight: 2 },
  { value: 'sponsor_tier.active', weight: 4 },
  { value: 'sponsor_tier.watch', weight: 1 },
  { value: 'sponsor_tier.new', weight: 2 },
];

/** Last day of the calendar quarter containing the date. */
function quarterEnd(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number, number];
  const qEndMonth = Math.ceil(m / 3) * 3;
  const lastDay = new Map([
    [3, 31],
    [6, 30],
    [9, 30],
    [12, 31],
  ]).get(qEndMonth);
  return `${y}-${String(qEndMonth).padStart(2, '0')}-${String(lastDay)}`;
}

function nextQuarterEnd(iso: string): string {
  return quarterEnd(addMonths(iso, 3));
}

function fixed(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/**
 * Builds a complete, internally consistent synthetic dataset. Every number is derived from the
 * seed, so tests can rely on exact values, and every deliberate defect carries a scenario tag.
 */
/**
 * Three plain statements about a quarter, read from its own generated figures against the quarter
 * before (or the entry snapshot), so a highlight never contradicts the numbers beside it. No random
 * draws: adding or changing a sentence leaves every other seeded value as it was.
 */
function quarterHighlights(
  before: { revenue: number; margin: number; netDebt: number },
  now: { revenue: number; margin: number; netDebt: number },
): string[] {
  const money = (v: number): string => `$${(v / 1_000_000).toFixed(1)}M`;
  const revenueChange = before.revenue === 0 ? 0 : now.revenue / before.revenue - 1;
  const revenue =
    Math.abs(revenueChange) < 0.0005
      ? `LTM revenue was flat at ${money(now.revenue)}.`
      : `LTM revenue ${revenueChange > 0 ? 'rose' : 'fell'} ${(Math.abs(revenueChange) * 100).toFixed(1)}% from the prior quarter to ${money(now.revenue)}.`;
  const points = (now.margin - before.margin) * 100;
  const margin =
    Math.abs(points) < 0.05
      ? `EBITDA margin was unchanged at ${(now.margin * 100).toFixed(1)}%.`
      : `EBITDA margin was ${(now.margin * 100).toFixed(1)}%, ${points > 0 ? 'up' : 'down'} ${Math.abs(points).toFixed(1)} points.`;
  const debtChange = now.netDebt - before.netDebt;
  const debt =
    Math.abs(debtChange) < 50_000
      ? `Net debt was unchanged at ${money(now.netDebt)}.`
      : `Net debt ${debtChange < 0 ? 'fell' : 'rose'} to ${money(now.netDebt)}.`;
  return [revenue, margin, debt];
}

export function generateDataset(options: GenerateOptions = {}): SyntheticDataset {
  const profile: Profile = PROFILES[options.profile ?? 'default'] ?? PROFILES.default!;
  const seed = options.seed ?? 42;
  const asOf = options.asOf ?? '2025-06-30';
  const rng = new Rng(seed);
  const names = new NameFactory(rng);
  const scenarioLog: Record<string, string[]> = {};
  const tag = (scenario: string, id: string): void => {
    (scenarioLog[scenario] ??= []).push(id);
  };

  // ---- Users (one per role plus extras) ------------------------------------------------------
  const mkUser = (
    externalId: string,
    roles: Users[number]['roles'],
    clientIds: string[] = [],
  ): Users[number] => {
    const p = names.person();
    return {
      id: rng.uuid(),
      externalId,
      displayName: p.displayName,
      email: p.email,
      roles,
      clientIds,
    };
  };

  // ---- Clients and vehicles ------------------------------------------------------------------
  const clientNames = [
    'Client Alpha Pension',
    'Client Beta Endowment',
    'Client Gamma Insurance',
    'Client Delta Foundation',
    'Client Epsilon Family Office',
  ];
  const clients: SyntheticDataset['clients'] = Array.from({ length: profile.clients }, (_, i) => ({
    id: rng.uuid(),
    name: clientNames[i] ?? `Client ${i + 1}`,
    reportingBases:
      i === 0 ? ['gross', 'net'] : i === 1 ? ['net'] : ['gross', 'net', 'net_of_fees_and_carry'],
    reportingCadence: i === 2 ? 'monthly' : 'quarterly',
  }));
  const clientA = clients[0]!;
  const clientB = clients[1] ?? clientA;
  const clientC = clients[2] ?? clientB;

  const users: Users = [
    mkUser('viewer.one', ['viewer']),
    mkUser('deal.one', ['deal_team']),
    mkUser('deal.two', ['deal_team']),
    mkUser('deal.three', ['deal_team']),
    mkUser('ops.one', ['operations']),
    mkUser('ops.two', ['operations']),
    mkUser('head.one', ['approver']),
    mkUser('ir.one', ['investor_relations'], [clientA.id, clientB.id]),
    mkUser('ir.two', ['investor_relations'], [clientC.id]),
    mkUser('admin.one', ['platform_admin']),
    mkUser('audit.one', ['auditor']),
  ];
  const userBy = (externalId: string): string => {
    const u = users.find((x) => x.externalId === externalId);
    if (!u) throw new Error(`no user ${externalId}`);
    return u.id;
  };

  const vehicles: SyntheticDataset['vehicles'] = [
    {
      id: rng.uuid(),
      name: 'Beach Co-Invest Fund I',
      vehicleType: 'vehicle_type.co_invest',
      vintage: 2016,
      closingCount: 2,
      finalCloseDate: '2016-12-15',
    },
    {
      id: rng.uuid(),
      name: 'Beach Co-Invest Fund II',
      vehicleType: 'vehicle_type.co_invest',
      vintage: 2019,
      closingCount: 2,
      finalCloseDate: '2019-11-30',
    },
    {
      id: rng.uuid(),
      name: 'Beach Co-Invest Fund III',
      vehicleType: 'vehicle_type.co_invest',
      vintage: 2022,
      closingCount: 2,
      finalCloseDate: '2023-03-31',
    },
    {
      id: rng.uuid(),
      name: 'Beach CV Opportunities I',
      vehicleType: 'vehicle_type.cv',
      vintage: 2021,
      closingCount: 1,
      finalCloseDate: '2021-06-30',
    },
    {
      id: rng.uuid(),
      name: 'Beach Primary Program',
      vehicleType: 'vehicle_type.primary_program',
      vintage: 2014,
      closingCount: 1,
      finalCloseDate: '2014-09-30',
    },
    {
      id: rng.uuid(),
      name: 'Beach Credit Partners I',
      vehicleType: 'vehicle_type.private_credit',
      vintage: 2020,
      closingCount: 1,
      finalCloseDate: '2020-12-31',
    },
    {
      id: rng.uuid(),
      name: 'Client Gamma Separate Account',
      vehicleType: 'vehicle_type.client_sma',
      vintage: 2018,
      closingCount: 1,
      finalCloseDate: '2018-06-30',
    },
  ];
  const [coI, coII, coIII, cvFund, primary, credit, sma] = vehicles as [
    SyntheticDataset['vehicles'][number],
    SyntheticDataset['vehicles'][number],
    SyntheticDataset['vehicles'][number],
    SyntheticDataset['vehicles'][number],
    SyntheticDataset['vehicles'][number],
    SyntheticDataset['vehicles'][number],
    SyntheticDataset['vehicles'][number],
  ];

  // ---- LP commitments (clients into vehicles) ------------------------------------------------
  const lpCommitments: SyntheticDataset['lpCommitments'] = [];
  for (const v of vehicles) {
    if (v.id === sma.id) {
      lpCommitments.push({
        id: rng.uuid(),
        clientId: clientC.id,
        vehicleId: v.id,
        amount: '150000000.00',
        commitmentDate: '2018-06-30',
        closingNumber: 1,
        ownershipPct: '1.00000000',
      });
      continue;
    }
    const first = v.finalCloseDate ?? `${String(v.vintage)}-06-30`;
    if (v.id === coIII.id) {
      // Second closing: Gamma joins later; ownership is recomputed across all three.
      lpCommitments.push({
        id: rng.uuid(),
        clientId: clientA.id,
        vehicleId: v.id,
        amount: '90000000.00',
        commitmentDate: '2022-09-30',
        closingNumber: 1,
        ownershipPct: '0.45000000',
      });
      lpCommitments.push({
        id: rng.uuid(),
        clientId: clientB.id,
        vehicleId: v.id,
        amount: '60000000.00',
        commitmentDate: '2022-09-30',
        closingNumber: 1,
        ownershipPct: '0.30000000',
      });
      lpCommitments.push({
        id: rng.uuid(),
        clientId: clientC.id,
        vehicleId: v.id,
        amount: '50000000.00',
        commitmentDate: '2023-03-31',
        closingNumber: 2,
        ownershipPct: '0.25000000',
      });
      tag('lp_second_closing', v.id);
      continue;
    }
    lpCommitments.push({
      id: rng.uuid(),
      clientId: clientA.id,
      vehicleId: v.id,
      amount: '120000000.00',
      commitmentDate: first,
      closingNumber: 1,
      ownershipPct: '0.60000000',
    });
    lpCommitments.push({
      id: rng.uuid(),
      clientId: clientB.id,
      vehicleId: v.id,
      amount: '80000000.00',
      commitmentDate: first,
      closingNumber: 1,
      ownershipPct: '0.40000000',
    });
  }

  // ---- Sponsors, funds, aliases --------------------------------------------------------------
  const sponsors: SyntheticDataset['sponsors'] = [];
  const sponsorFunds: SyntheticDataset['sponsorFunds'] = [];
  const fundAliases: SyntheticDataset['fundAliases'] = [];
  const creditSponsorCount = Math.max(1, Math.round(profile.sponsors * 0.15));
  for (let i = 0; i < profile.sponsors; i++) {
    const isCredit = i < creditSponsorCount;
    const sponsor = {
      id: rng.uuid(),
      name: names.sponsor(isCredit),
      canonicalName: '',
      tier: rng.weighted(TIERS),
      hqGeography: rng.weighted(GEOS),
      description: isCredit
        ? 'Direct lending to sponsor-backed middle-market borrowers.'
        : 'Control buyouts and growth investments in the middle market.',
    };
    sponsor.canonicalName = canonical(sponsor.name);
    sponsors.push(sponsor);
    const fundCount = rng.int(1, profile.fundsPerSponsorMax);
    let vintage = rng.int(2010, 2018);
    for (let f = 0; f < fundCount; f++) {
      const strategy = isCredit
        ? 'strategy.credit'
        : rng.chance(0.25)
          ? 'strategy.growth'
          : 'strategy.buyout';
      const target = rng.int(4, 40) * 100_000_000;
      const fund = {
        id: rng.uuid(),
        sponsorId: sponsor.id,
        name: names.fund(sponsor.name, f + rng.int(0, 2), strategy),
        canonicalName: '',
        vintage,
        strategy,
        sizeTarget: fixed(target),
        sizeHardCap: fixed(target * 1.25),
        sizeFinal: rng.chance(0.8) ? fixed(target * (0.9 + rng.next() * 0.3)) : null,
      };
      fund.canonicalName = canonical(fund.name);
      sponsorFunds.push(fund);
      if (rng.chance(0.3))
        fundAliases.push({
          id: rng.uuid(),
          sponsorFundId: fund.id,
          alias: names.fundAlias(fund.name),
        });
      vintage += rng.int(3, 4);
      if (vintage > 2024) break;
    }
  }
  const equityFunds = sponsorFunds.filter((f) => f.strategy !== 'strategy.credit');
  const creditFunds = sponsorFunds.filter((f) => f.strategy === 'strategy.credit');
  const sponsorOf = (fundId: string): string =>
    sponsorFunds.find((f) => f.id === fundId)!.sponsorId;

  // ---- Vehicle-to-fund commitments -----------------------------------------------------------
  const commitments: SyntheticDataset['commitments'] = [];
  for (const fund of sponsorFunds) {
    const vintageYear = fund.vintage ?? 2018;
    if (vintageYear >= 2014) {
      commitments.push({
        id: rng.uuid(),
        vehicleId: primary.id,
        sponsorFundId: fund.id,
        clientId: null,
        amount: fixed(rng.int(10, 50) * 1_000_000),
        commitmentDate: `${String(vintageYear)}-${rng.chance(0.5) ? '03-31' : '09-30'}`,
      });
    }
    if (vintageYear >= 2018 && rng.chance(0.4)) {
      commitments.push({
        id: rng.uuid(),
        vehicleId: sma.id,
        sponsorFundId: fund.id,
        clientId: clientC.id,
        amount: fixed(rng.int(5, 25) * 1_000_000),
        commitmentDate: `${String(vintageYear)}-06-30`,
      });
    }
  }
  const shared = commitments.find(
    (c) =>
      c.clientId !== null &&
      commitments.some((o) => o.sponsorFundId === c.sponsorFundId && o.clientId === null),
  );
  if (shared) tag('two_clients_one_fund', shared.sponsorFundId);

  // ---- Investments ---------------------------------------------------------------------------
  const portfolioCompanies: SyntheticDataset['portfolioCompanies'] = [];
  const fundHoldings: SyntheticDataset['fundHoldings'] = [];
  const investments: Investment[] = [];
  const quarterlyPerformance: SyntheticDataset['quarterlyPerformance'] = [];
  const creditTerms: SyntheticDataset['creditTerms'] = [];
  const creditPerformance: SyntheticDataset['creditPerformance'] = [];
  const valuations: SyntheticDataset['valuations'] = [];
  const capitalNotices: SyntheticDataset['capitalNotices'] = [];
  const cashFlows: SyntheticDataset['cashFlows'] = [];
  const realizationOutlooks: SyntheticDataset['realizationOutlooks'] = [];
  // Outlooks were set at the last quarterly review before the as-of date, at noon UTC: a timestamp
  // derived from the dataset's own dates, never the wall clock, so every build is byte-identical.
  const outlookSetAt = `${quarterEnd(addMonths(asOf, -3))}T12:00:00Z`;
  const total = profile.activeInvestments + profile.realizedInvestments;

  const vehicleFor = (dealType: string, entryYear: number): string => {
    if (dealType === 'deal_type.private_credit') return credit.id;
    if (dealType.startsWith('deal_type.cv_')) return cvFund.id;
    if (rng.chance(0.15)) return sma.id;
    if (entryYear >= 2022) return coIII.id;
    if (entryYear >= 2019) return coII.id;
    return coI.id;
  };

  const addNotice = (
    n: Omit<SyntheticDataset['capitalNotices'][number], 'id' | 'split'> & {
      split?: Record<string, string>;
    },
  ): string => {
    const id = rng.uuid();
    capitalNotices.push({ id, split: n.split ?? {}, ...n });
    return id;
  };
  const addFlow = (f: Omit<SyntheticDataset['cashFlows'][number], 'id' | 'status'>): void => {
    cashFlows.push({ id: rng.uuid(), status: 'record_status.approved', ...f });
  };
  const lockValuation = (
    investmentId: string,
    periodEnd: string,
    fairValue: string,
    method: string,
    version = 1,
  ): string => {
    const id = rng.uuid();
    valuations.push({
      id,
      investmentId,
      periodEnd,
      version,
      method,
      fairValue,
      state: 'Locked',
      lockHash: `h-${id.slice(0, 8)}`,
      preparedBy: userBy('ops.one'),
      dealTeamApprovedBy: userBy('deal.one'),
      approvedBy: userBy('head.one'),
      approvedAt: `${addDays(periodEnd, 40)}T15:00:00Z`,
      scenarioTags: [],
    });
    return id;
  };

  for (let i = 0; i < total; i++) {
    const realized = i >= profile.activeInvestments;
    const dealType = rng.weighted([
      { value: 'deal_type.co_invest_equity', weight: 62 },
      { value: 'deal_type.cv_single_asset', weight: 15 },
      { value: 'deal_type.cv_multi_asset', weight: 5 },
      { value: 'deal_type.private_credit', weight: 18 },
    ]);
    const isCredit = dealType === 'deal_type.private_credit';
    const fund = rng.pick(
      isCredit ? (creditFunds.length > 0 ? creditFunds : equityFunds) : equityFunds,
    );
    const sector = rng.pick(SECTORS);
    const company = {
      id: rng.uuid(),
      name: names.company(sector),
      canonicalName: '',
      sector,
      geography: rng.weighted(GEOS),
      description: 'Synthetic portfolio company.',
    };
    company.canonicalName = canonical(company.name);
    portfolioCompanies.push(company);
    fundHoldings.push({ id: rng.uuid(), sponsorFundId: fund.id, portfolioCompanyId: company.id });

    const entryYear = realized ? rng.int(2016, 2020) : rng.int(2017, 2024);
    const entryDate = `${String(entryYear)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
    const vehicleId = vehicleFor(dealType, entryYear);
    const cost = Number(rng.money(5_000_000, 60_000_000));
    const inv: Investment = {
      id: rng.uuid(),
      investmentNumber: `INV-${String(i + 1).padStart(4, '0')}`,
      vehicleId,
      portfolioCompanyId: company.id,
      sponsorFundId: fund.id,
      sponsorId: sponsorOf(fund.id),
      dealType,
      entryDate,
      exitDate: realized ? addMonths(entryDate, rng.int(36, 72)) : null,
      isActive: !realized,
      scenarioTags: [],
    };
    if (inv.exitDate !== null && compareIso(inv.exitDate, asOf) > 0)
      inv.exitDate = addMonths(asOf, -3);
    investments.push(inv);

    // Entry contribution and its notice.
    const callId = addNotice({
      noticeType: 'notice_type.capital_call',
      vehicleId,
      investmentId: inv.id,
      commitmentId: null,
      issueDate: addDays(entryDate, -10),
      dueDate: entryDate,
      amount: fixed(cost),
      state: 'Reconciled',
      scenarioTag: null,
      split: { investment: fixed(cost) },
    });
    addFlow({
      investmentId: inv.id,
      commitmentId: null,
      flowDate: entryDate,
      flowType: 'flow_type.contribution',
      amount: fixed(-cost),
      sourceNoticeId: callId,
    });

    const lastPeriod = realized ? quarterEnd(inv.exitDate ?? asOf) : asOf;
    const firstPeriod = nextQuarterEnd(entryDate);
    const periods: string[] = [];
    for (let p = firstPeriod; compareIso(p, lastPeriod) <= 0; p = nextQuarterEnd(p))
      periods.push(p);
    const keep = periods.slice(-profile.quartersPerInvestment);

    if (isCredit) {
      const spread = rng.decimal(0.045, 0.075, 4);
      const pik = rng.chance(0.3) ? rng.decimal(0.01, 0.03, 4) : '0.0000';
      const base = 0.045;
      const allIn = base + Number(spread);
      const cashCoupon = (allIn - Number(pik)).toFixed(4);
      const maturity = addMonths(entryDate, rng.int(60, 84));
      creditTerms.push({
        id: rng.uuid(),
        investmentId: inv.id,
        facilityType: rng.pick([
          'facility_type.senior_secured',
          'facility_type.unitranche',
          'facility_type.unitranche',
          'facility_type.second_lien',
          'facility_type.mezzanine',
        ]),
        seniorityRank: 1,
        commitmentAmount: fixed(cost),
        baseRate: 'base_rate.sofr',
        floor: '0.0100',
        spread,
        cashCoupon,
        pikCoupon: pik,
        oid: '0.0200',
        upfrontFee: '0.0100',
        maturityDate: maturity,
        paymentFrequency: 'quarterly',
        amortization: [],
        callProtection: [],
        covenants: [
          { name: 'Minimum interest coverage', level: '2.00', test: 'quarterly' },
          { name: 'Maximum net leverage', level: '6.00', test: 'quarterly' },
        ],
        effectiveDate: entryDate,
        status: 'record_status.approved',
      });
      let par = cost;
      const borrowerEbitda = cost / Number(rng.decimal(2.5, 4.5, 2));
      let ebitda = borrowerEbitda;
      for (const [k, periodEnd] of keep.entries()) {
        const cashInterest = (par * Number(cashCoupon)) / 4;
        const pikAmount = (par * Number(pik)) / 4;
        par += pikAmount;
        ebitda *= 1 + (rng.next() - 0.4) * 0.06;
        const coverage = ebitda / (par * allIn);
        const creditRow = {
          id: rng.uuid(),
          investmentId: inv.id,
          periodEnd,
          parValue: fixed(par),
          costBasis: fixed(cost * 0.98),
          fairValue: fixed(par * Number(rng.decimal(0.96, 1.01, 4))),
          accruedInterest: fixed(cashInterest / 3),
          cashInterestLtm: fixed(cashInterest * 4),
          pikCapitalizedLtm: fixed(pikAmount * 4),
          principalRepaidLtm: '0.00',
          fundedAmount: fixed(cost),
          ebitdaLtm: fixed(ebitda),
          cashInterestExpenseLtm: fixed(par * allIn),
          netDebtThroughTranche: fixed(par * 1.4),
          ev: fixed(ebitda * 9),
          covenantStatus: coverage < 2 ? 'covenant_status.breach' : 'covenant_status.compliant',
          paymentStatus: 'payment_status.current',
          isEntrySnapshot: false,
          status: 'record_status.approved',
          scenarioTags: [] as string[],
        };
        creditPerformance.push(creditRow);
        const interestNotice = addNotice({
          noticeType: 'notice_type.interest_payment',
          vehicleId,
          investmentId: inv.id,
          commitmentId: null,
          issueDate: addDays(periodEnd, -5),
          dueDate: periodEnd,
          amount: fixed(cashInterest),
          state: 'Reconciled',
          scenarioTag: null,
        });
        addFlow({
          investmentId: inv.id,
          commitmentId: null,
          flowDate: periodEnd,
          flowType: 'flow_type.interest',
          amount: fixed(cashInterest),
          sourceNoticeId: interestNotice,
        });
        if (!(realized && k === keep.length - 1))
          lockValuation(
            inv.id,
            periodEnd,
            creditRow.fairValue,
            'valuation_method.par_plus_accrued',
          );
      }
      if (realized && inv.exitDate !== null) {
        const repay = addNotice({
          noticeType: 'notice_type.principal_repayment',
          vehicleId,
          investmentId: inv.id,
          commitmentId: null,
          issueDate: addDays(inv.exitDate, -15),
          dueDate: inv.exitDate,
          amount: fixed(par),
          state: 'Reconciled',
          scenarioTag: null,
        });
        addFlow({
          investmentId: inv.id,
          commitmentId: null,
          flowDate: inv.exitDate,
          flowType: 'flow_type.principal',
          amount: fixed(par * 1.01),
          sourceNoticeId: repay,
        });
      }
      continue;
    }

    // Equity and CV positions: entry snapshot plus quarterly operating data and locked valuations.
    const entryRevenue = cost * Number(rng.decimal(1.5, 4, 2));
    const entryMargin = Number(rng.decimal(0.12, 0.32, 3));
    const entryMultiple = Number(rng.decimal(8, 14, 2));
    const entryEbitda = entryRevenue * entryMargin;
    const entryEv = entryEbitda * entryMultiple;
    const entryNetDebt = entryEv * Number(rng.decimal(0.3, 0.55, 2));
    const ownershipShare = cost / (entryEv - entryNetDebt);
    quarterlyPerformance.push({
      id: rng.uuid(),
      investmentId: inv.id,
      periodEnd: quarterEnd(addMonths(entryDate, -3)),
      revenueLtm: fixed(entryRevenue),
      ebitdaLtm: fixed(entryEbitda),
      ev: fixed(entryEv),
      netDebt: fixed(entryNetDebt),
      cash: fixed(entryEv * 0.03),
      totalEquity: fixed(entryEv - entryNetDebt),
      highlights: [],
      commentary: null,
      isEntrySnapshot: true,
      status: 'record_status.approved',
      scenarioTags: [],
    });
    let revenue = entryRevenue;
    let margin = entryMargin;
    let netDebt = entryNetDebt;
    const drift = Number(rng.decimal(-0.03, 0.09, 3));
    for (const [k, periodEnd] of keep.entries()) {
      const before = { revenue, margin, netDebt };
      revenue *= 1 + drift / 4 + (rng.next() - 0.5) * 0.04;
      margin = Math.min(0.45, Math.max(-0.1, margin + (rng.next() - 0.5) * 0.01));
      netDebt = Math.max(0, netDebt * (0.985 + (rng.next() - 0.5) * 0.02));
      const ebitda = revenue * margin;
      const multiple = entryMultiple + (rng.next() - 0.5) * 1.5;
      const ev = Math.max(ebitda, 0) * multiple + (ebitda <= 0 ? revenue * 1.2 : 0);
      const equity = Math.max(ev - netDebt, cost * 0.1);
      quarterlyPerformance.push({
        id: rng.uuid(),
        investmentId: inv.id,
        periodEnd,
        revenueLtm: fixed(revenue),
        ebitdaLtm: fixed(ebitda),
        ev: fixed(ev),
        netDebt: fixed(netDebt),
        cash: fixed(ev * 0.03),
        totalEquity: fixed(ev - netDebt),
        highlights: quarterHighlights(before, { revenue, margin, netDebt }),
        commentary: null,
        isEntrySnapshot: false,
        status: 'record_status.approved',
        scenarioTags: [],
      });
      if (!(realized && k === keep.length - 1))
        lockValuation(
          inv.id,
          periodEnd,
          fixed(equity * ownershipShare),
          'valuation_method.sponsor_mark',
        );
      if (!realized && k === 3 && rng.chance(0.35)) {
        const dist = cost * Number(rng.decimal(0.1, 0.4, 2));
        const nid = addNotice({
          noticeType: 'notice_type.distribution',
          vehicleId,
          investmentId: inv.id,
          commitmentId: null,
          issueDate: addDays(periodEnd, 20),
          dueDate: addDays(periodEnd, 30),
          amount: fixed(dist),
          state: 'Reconciled',
          scenarioTag: null,
        });
        addFlow({
          investmentId: inv.id,
          commitmentId: null,
          flowDate: addDays(periodEnd, 30),
          flowType: 'flow_type.distribution',
          amount: fixed(dist),
          sourceNoticeId: nid,
        });
      }
    }
    if (realized && inv.exitDate !== null) {
      const proceeds = cost * Number(rng.decimal(0.6, 3.2, 2));
      const nid = addNotice({
        noticeType: 'notice_type.distribution',
        vehicleId,
        investmentId: inv.id,
        commitmentId: null,
        issueDate: addDays(inv.exitDate, -10),
        dueDate: inv.exitDate,
        amount: fixed(proceeds),
        state: 'Reconciled',
        scenarioTag: null,
      });
      addFlow({
        investmentId: inv.id,
        commitmentId: null,
        flowDate: inv.exitDate,
        flowType: 'flow_type.distribution',
        amount: fixed(proceeds),
        sourceNoticeId: nid,
      });
    } else if (rng.chance(0.3)) {
      realizationOutlooks.push({
        id: rng.uuid(),
        investmentId: inv.id,
        horizonMonths: 18,
        outlook: rng.pick(['realization_outlook.partial', 'realization_outlook.full']),
        note: 'Sponsor has engaged advisors.',
        setAt: outlookSetAt,
      });
    }
  }

  // ---- Primary program cash flows (fund-level, keyed by commitment) --------------------------
  for (const c of commitments) {
    if (c.vehicleId !== primary.id) continue;
    const amount = Number(c.amount);
    let called = 0;
    for (
      let q = nextQuarterEnd(c.commitmentDate), n = 0;
      compareIso(q, asOf) <= 0 && n < 16 && called < amount * 0.9;
      q = nextQuarterEnd(q), n++
    ) {
      const call = Math.min(amount * Number(rng.decimal(0.04, 0.12, 3)), amount - called);
      called += call;
      const nid = addNotice({
        noticeType: 'notice_type.capital_call',
        vehicleId: primary.id,
        investmentId: null,
        commitmentId: c.id,
        issueDate: addDays(q, -12),
        dueDate: q,
        amount: fixed(call),
        state: 'Reconciled',
        scenarioTag: null,
      });
      addFlow({
        investmentId: null,
        commitmentId: c.id,
        flowDate: q,
        flowType: 'flow_type.contribution',
        amount: fixed(-call),
        sourceNoticeId: nid,
      });
      if (n > 8 && rng.chance(0.5)) {
        const dist = call * Number(rng.decimal(0.3, 1.5, 2));
        const did = addNotice({
          noticeType: 'notice_type.distribution',
          vehicleId: primary.id,
          investmentId: null,
          commitmentId: c.id,
          issueDate: addDays(q, 15),
          dueDate: addDays(q, 25),
          amount: fixed(dist),
          state: 'Reconciled',
          scenarioTag: null,
        });
        addFlow({
          investmentId: null,
          commitmentId: c.id,
          flowDate: addDays(q, 25),
          flowType: 'flow_type.distribution',
          amount: fixed(dist),
          sourceNoticeId: did,
        });
      }
    }
  }

  // ---- Scenarios (docs/14 section 3) --------------------------------------------------------
  const activeEquity = investments.filter(
    (i) => i.isActive && i.dealType !== 'deal_type.private_credit',
  );
  const activeCredit = investments.filter(
    (i) => i.isActive && i.dealType === 'deal_type.private_credit',
  );
  const realizedEquity = investments.filter(
    (i) => !i.isActive && i.dealType !== 'deal_type.private_credit',
  );
  const pickFresh = (pool: Investment[], scenario: string): Investment => {
    const candidate = pool.find((i) => i.scenarioTags.length === 0) ?? pool[0];
    if (!candidate) throw new Error(`no investment available for scenario ${scenario}`);
    candidate.scenarioTags.push(scenario);
    tag(scenario, candidate.id);
    return candidate;
  };
  const rowsOf = (inv: Investment) =>
    quarterlyPerformance
      .filter((q) => q.investmentId === inv.id && !q.isEntrySnapshot)
      .sort((a, b) => compareIso(a.periodEnd, b.periodEnd));

  // missing_prior_year: remove the quarter exactly one year before the latest; a nearer quarter stays.
  {
    const inv = pickFresh(activeEquity, 'missing_prior_year');
    const rows = rowsOf(inv);
    const latest = rows[rows.length - 1];
    if (latest) {
      const wanted = addMonths(latest.periodEnd, -12);
      const idx = quarterlyPerformance.findIndex(
        (q) => q.investmentId === inv.id && q.periodEnd === wanted,
      );
      if (idx >= 0) quarterlyPerformance.splice(idx, 1);
      latest.scenarioTags.push('missing_prior_year');
    }
  }
  // period_end_shift: sponsor reports on a non-calendar quarter end within tolerance.
  {
    const inv = pickFresh(activeEquity, 'period_end_shift');
    for (const row of rowsOf(inv)) {
      row.periodEnd = addDays(row.periodEnd, -3);
      row.scenarioTags.push('period_end_shift');
    }
    for (const v of valuations.filter((x) => x.investmentId === inv.id))
      v.periodEnd = addDays(v.periodEnd, -3);
  }
  // forward_entry_snapshot: entry snapshot dated after the reporting date.
  {
    const inv = pickFresh(activeEquity, 'forward_entry_snapshot');
    const snap = quarterlyPerformance.find((q) => q.investmentId === inv.id && q.isEntrySnapshot);
    if (snap) {
      snap.periodEnd = nextQuarterEnd(addMonths(asOf, 3));
      snap.scenarioTags.push('forward_entry_snapshot');
    }
  }
  // negative_ebitda: latest two quarters below zero; ratios must be null.
  {
    const inv = pickFresh(activeEquity, 'negative_ebitda');
    for (const row of rowsOf(inv).slice(-2)) {
      row.ebitdaLtm = fixed(-Math.abs(Number(row.ebitdaLtm ?? '1000000')) * 0.2);
      row.scenarioTags.push('negative_ebitda');
    }
  }
  // near_miss_names: a second company whose name differs by a suffix, plus a match guard.
  const matchGuards: SyntheticDataset['matchGuards'] = [];
  {
    const inv = pickFresh(activeEquity, 'near_miss_names');
    const company = portfolioCompanies.find((c) => c.id === inv.portfolioCompanyId)!;
    const twin = {
      id: rng.uuid(),
      name: names.nearMiss(company.name),
      canonicalName: '',
      sector: company.sector,
      geography: company.geography,
      description: 'Unrelated company with a similar name.',
    };
    twin.canonicalName = canonical(twin.name);
    portfolioCompanies.push(twin);
    matchGuards.push({
      id: rng.uuid(),
      nameA: company.name,
      nameB: twin.name,
      reason: 'Different companies with similar names; never auto-match.',
    });
  }
  // restatement: a prior quarter restated; valuation v1 Reopened with a reason, v2 Locked.
  {
    const inv = pickFresh(activeEquity, 'restatement');
    const rows = rowsOf(inv);
    const target = rows[rows.length - 2];
    if (target) {
      target.scenarioTags.push('restatement');
      target.revenueLtm = fixed(Number(target.revenueLtm ?? '0') * 0.97);
      const v1 = valuations.find(
        (v) => v.investmentId === inv.id && v.periodEnd === target.periodEnd,
      );
      if (v1) {
        v1.state = 'Reopened';
        v1.scenarioTags.push('restatement');
        lockValuation(inv.id, target.periodEnd, fixed(Number(v1.fairValue) * 0.97), v1.method, 2);
      }
    }
  }
  // stale_valuation: no mark for the latest quarter; the prior one rolls forward with a footnote.
  {
    const inv = pickFresh(activeEquity, 'stale_valuation');
    const idx = valuations.findIndex((v) => v.investmentId === inv.id && v.periodEnd === asOf);
    if (idx >= 0) valuations.splice(idx, 1);
  }
  // roll_forward_break: the quarter before the latest has no valuation at all (missing starting NAV).
  {
    const inv = pickFresh(activeEquity, 'roll_forward_break');
    const prior = quarterEnd(addMonths(asOf, -3));
    const idx = valuations.findIndex((v) => v.investmentId === inv.id && v.periodEnd === prior);
    if (idx >= 0) valuations.splice(idx, 1);
  }
  // walled_deal: visible only to the named wall.
  const walls: SyntheticDataset['walls'] = [];
  {
    const inv = pickFresh(activeEquity, 'walled_deal');
    walls.push({
      id: rng.uuid(),
      name: names.project(),
      description: 'Restricted: named members only (SEC-5.3).',
      memberUserIds: [userBy('deal.three'), userBy('head.one')],
      records: [{ entity: 'investment', entityId: inv.id }],
    });
  }
  // multiple_irr: a realized deal whose flows change sign twice with two NPV roots.
  {
    const inv = pickFresh(realizedEquity, 'multiple_irr');
    for (let i = cashFlows.length - 1; i >= 0; i--)
      if (cashFlows[i]?.investmentId === inv.id) cashFlows.splice(i, 1);
    for (let i = capitalNotices.length - 1; i >= 0; i--)
      if (capitalNotices[i]?.investmentId === inv.id) capitalNotices.splice(i, 1);
    const base = 10_000_000;
    const d0 = inv.entryDate;
    const d1 = addMonths(d0, 12);
    const d2 = addMonths(d0, 24);
    inv.exitDate = d2;
    const n0 = addNotice({
      noticeType: 'notice_type.capital_call',
      vehicleId: inv.vehicleId,
      investmentId: inv.id,
      commitmentId: null,
      issueDate: addDays(d0, -10),
      dueDate: d0,
      amount: fixed(base),
      state: 'Reconciled',
      scenarioTag: 'multiple_irr',
    });
    addFlow({
      investmentId: inv.id,
      commitmentId: null,
      flowDate: d0,
      flowType: 'flow_type.contribution',
      amount: fixed(-base),
      sourceNoticeId: n0,
    });
    const n1 = addNotice({
      noticeType: 'notice_type.distribution',
      vehicleId: inv.vehicleId,
      investmentId: inv.id,
      commitmentId: null,
      issueDate: addDays(d1, -10),
      dueDate: d1,
      amount: fixed(base * 2.3),
      state: 'Reconciled',
      scenarioTag: 'multiple_irr',
    });
    addFlow({
      investmentId: inv.id,
      commitmentId: null,
      flowDate: d1,
      flowType: 'flow_type.recallable',
      amount: fixed(base * 2.3),
      sourceNoticeId: n1,
    });
    const n2 = addNotice({
      noticeType: 'notice_type.capital_call',
      vehicleId: inv.vehicleId,
      investmentId: inv.id,
      commitmentId: null,
      issueDate: addDays(d2, -10),
      dueDate: d2,
      amount: fixed(base * 1.32),
      state: 'Reconciled',
      scenarioTag: 'multiple_irr',
    });
    addFlow({
      investmentId: inv.id,
      commitmentId: null,
      flowDate: d2,
      flowType: 'flow_type.contribution',
      amount: fixed(-base * 1.32),
      sourceNoticeId: n2,
    });
  }
  // wire_change: a pending call whose notice carries changed bank details and urgency language.
  {
    const inv = pickFresh(activeEquity, 'wire_change');
    addNotice({
      noticeType: 'notice_type.capital_call',
      vehicleId: inv.vehicleId,
      investmentId: inv.id,
      commitmentId: null,
      issueDate: addDays(asOf, 10),
      dueDate: addDays(asOf, 12),
      amount: '2500000.00',
      state: 'Extracted',
      scenarioTag: 'wire_change',
      split: { investment: '2500000.00' },
    });
  }
  // equalization: on the vehicle with a second closing, a call to the new LP then an equalization distribution to the others.
  {
    const c = commitments.find((x) => x.vehicleId === primary.id) ?? commitments[0];
    if (c) {
      const d = quarterEnd(addMonths(asOf, -6));
      const eq1 = addNotice({
        noticeType: 'notice_type.capital_call',
        vehicleId: coIII.id,
        investmentId: null,
        commitmentId: c.id,
        issueDate: addDays(d, -10),
        dueDate: d,
        amount: '4000000.00',
        state: 'Reconciled',
        scenarioTag: 'equalization',
      });
      addFlow({
        investmentId: null,
        commitmentId: c.id,
        flowDate: d,
        flowType: 'flow_type.contribution',
        amount: '-4000000.00',
        sourceNoticeId: eq1,
      });
      const eq2 = addNotice({
        noticeType: 'notice_type.equalization',
        vehicleId: coIII.id,
        investmentId: null,
        commitmentId: c.id,
        issueDate: addDays(d, 5),
        dueDate: addDays(d, 15),
        amount: '1000000.00',
        state: 'Reconciled',
        scenarioTag: 'equalization',
        split: { equalization: '950000.00', interest: '50000.00' },
      });
      addFlow({
        investmentId: null,
        commitmentId: c.id,
        flowDate: addDays(d, 15),
        flowType: 'flow_type.recallable',
        amount: '1000000.00',
        sourceNoticeId: eq2,
      });
      tag('equalization', eq2);
    }
  }
  // Credit scenarios.
  if (activeCredit.length > 0) {
    const pikInv = pickFresh(activeCredit, 'pik_toggle');
    const terms = creditTerms.find((t) => t.investmentId === pikInv.id);
    if (terms) {
      terms.pikCoupon = '0.0300';
      terms.cashCoupon = (Number(terms.cashCoupon) + Number(terms.pikCoupon) - 0.03).toFixed(4);
      for (const row of creditPerformance.filter((r) => r.investmentId === pikInv.id).slice(-2)) {
        row.pikCapitalizedLtm = fixed(Number(row.parValue ?? '0') * 0.03);
        row.scenarioTags.push('pik_toggle');
      }
    }
    const breachInv = pickFresh(activeCredit, 'covenant_breach');
    const breachRows = creditPerformance
      .filter((r) => r.investmentId === breachInv.id)
      .sort((a, b) => compareIso(a.periodEnd, b.periodEnd));
    const b1 = breachRows[breachRows.length - 2];
    const b2 = breachRows[breachRows.length - 1];
    if (b1 && b2) {
      b1.ebitdaLtm = fixed(Number(b1.cashInterestExpenseLtm ?? '1') * 1.5);
      b1.covenantStatus = 'covenant_status.breach';
      b1.scenarioTags.push('covenant_breach');
      b2.covenantStatus = 'covenant_status.waiver';
      b2.scenarioTags.push('covenant_breach');
    }
    const amortInv = pickFresh(activeCredit, 'credit_amortization');
    const amortTerms = creditTerms.find((t) => t.investmentId === amortInv.id);
    if (amortTerms) {
      const par = Number(amortTerms.commitmentAmount);
      amortTerms.amortization = [1, 2, 3].map((n) => ({
        date: addMonths(amortTerms.effectiveDate, 12 * n),
        amount: fixed(par * 0.05),
      }));
      for (const row of creditPerformance.filter((r) => r.investmentId === amortInv.id).slice(-4)) {
        row.principalRepaidLtm = fixed(par * 0.05);
        row.parValue = fixed(Number(row.parValue ?? '0') - par * 0.05);
        row.scenarioTags.push('credit_amortization');
      }
      const pay = addNotice({
        noticeType: 'notice_type.principal_repayment',
        vehicleId: credit.id,
        investmentId: amortInv.id,
        commitmentId: null,
        issueDate: addDays(asOf, -40),
        dueDate: addDays(asOf, -30),
        amount: fixed(par * 0.05),
        state: 'Reconciled',
        scenarioTag: 'credit_amortization',
      });
      addFlow({
        investmentId: amortInv.id,
        commitmentId: null,
        flowDate: addDays(asOf, -30),
        flowType: 'flow_type.principal',
        amount: fixed(par * 0.05),
        sourceNoticeId: pay,
      });
    }
    const prepayInv = pickFresh(activeCredit, 'credit_prepayment');
    const prepayTerms = creditTerms.find((t) => t.investmentId === prepayInv.id);
    if (prepayTerms) {
      prepayTerms.callProtection = [
        { until: addMonths(prepayTerms.effectiveDate, 24), premium: '0.0200' },
      ];
      const par = Number(prepayTerms.commitmentAmount);
      const pay = addNotice({
        noticeType: 'notice_type.principal_repayment',
        vehicleId: credit.id,
        investmentId: prepayInv.id,
        commitmentId: null,
        issueDate: addDays(asOf, -20),
        dueDate: addDays(asOf, -10),
        amount: fixed(par * 1.02),
        state: 'Reviewed',
        scenarioTag: 'credit_prepayment',
        split: { principal: fixed(par), premium: fixed(par * 0.02) },
      });
      void pay;
    }
  }

  const dataset: SyntheticDataset = {
    version: 1,
    profile: profile.name,
    seed,
    asOf,
    users,
    sponsors,
    sponsorFunds,
    fundAliases,
    portfolioCompanies,
    fundHoldings,
    vehicles,
    investments,
    clients,
    commitments,
    lpCommitments,
    matchGuards,
    walls,
    quarterlyPerformance,
    creditTerms,
    creditPerformance,
    valuations,
    capitalNotices,
    cashFlows,
    realizationOutlooks,
    scenarios: scenarioLog,
  };
  void D;
  return dataset;
}
