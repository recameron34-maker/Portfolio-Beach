import { existsSync, readFileSync } from 'node:fs';
import { D, addDays, addMonths, compareIso, containingQuarterEnd } from '@pb/calc';
import type { SyntheticDataset } from '@pb/db';
import type { NameFactory } from './names.js';
import type { Rng } from './prng.js';
import { pipelineStageAgingDays } from './settings.js';
import type { PipelineStageKey } from './settings.js';

/**
 * The Phase 3 controls (decision 0013, docs/14 section 10): the pipeline's opportunity record with
 * its stage history, diligence tasks, IC decisions and allocations (M5 skeleton), the closing
 * record with its checklist and legal terms (M8, M22), the wire instruction register and trade
 * tickets (M16, SEC-12) and deal change requests (M11).
 *
 * Every row is derived from the dataset built before it and from the controls' own seeded stream,
 * so adding them moved no other value, and every instant is derived from the as-of date or a
 * record's own date, never the wall clock. The arrays follow the seed loader's contract
 * (packages/db seed.ts) field for field: ids are uuids, money is the generator's two-decimal
 * string, dates are ISO dates and instants ISO timestamps; the bank details are plain in the
 * dataset and the loader encrypts them (SEC-12.2). The row types here stand until that schema
 * carries the arrays, when GeneratedDataset narrows onto it.
 */

/* ---- Row types (the loader's field names) ---- */

export const PIPELINE_STAGES = [
  'Sourced',
  'Screening',
  'Prescreen',
  'Diligence',
  'IC',
  'Approved',
  'Closing',
] as const satisfies readonly PipelineStageKey[];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type DealStage = PipelineStage | 'Closed' | 'Passed';
export type DiligenceTaskStatus = 'open' | 'done' | 'waived';
export type IcDecisionOutcome = 'approved' | 'declined' | 'deferred';
export type ClosingState = 'Open' | 'OpsConfirmed';
export type ClosingItemStatus = 'open' | 'received' | 'waived';
export type LegalTermStatus = 'draft' | 'confirmed';
export type WireInstructionState = 'Proposed' | 'Verified' | 'Rejected' | 'Superseded';
export type CallbackNumberSource =
  'prior_instruction' | 'sponsor_website' | 'known_contact' | 'fund_administrator';
export type CallbackResult = 'confirmed' | 'not_confirmed';
export type TradeTicketState = 'Drafted' | 'Approved' | 'Funded' | 'Withdrawn';
export type ChangeRequestState = 'Submitted' | 'Routed' | 'InProgress' | 'Applied' | 'Rejected';

export interface Opportunity {
  id: string;
  name: string;
  companyName: string;
  portfolioCompanyId: string | null;
  sponsorId: string;
  sponsorFundId: string | null;
  dealType: string;
  sector: string | null;
  geography: string | null;
  stage: DealStage;
  ownerId: string | null;
  receivedDate: string;
  targetCommitment: string | null;
  source: string | null;
  passReasonCode: string | null;
  passNote: string | null;
  investmentId: string | null;
  scenarioTag: string | null;
}

export interface OpportunityStageHistory {
  id: string;
  opportunityId: string;
  fromStage: DealStage | null;
  toStage: DealStage;
  command: string;
  reason: string | null;
  changedBy: string;
  changedAt: string;
}

export interface DiligenceTask {
  id: string;
  opportunityId: string;
  workstream: string;
  title: string;
  ownerId: string | null;
  dueDate: string | null;
  status: DiligenceTaskStatus;
  requiredForIc: boolean;
  evidenceDocumentId: string | null;
  waivedReason: string | null;
}

export interface IcDecision {
  id: string;
  opportunityId: string;
  decisionDate: string;
  decision: IcDecisionOutcome;
  amount: string | null;
  conditions: string[];
  recordedBy: string;
}

export interface Allocation {
  id: string;
  opportunityId: string | null;
  investmentId: string | null;
  vehicleId: string;
  clientId: string | null;
  requested: string;
  received: string | null;
}

export interface Closing {
  id: string;
  opportunityId: string;
  investmentId: string | null;
  closeDate: string;
  commitmentAmount: string;
  state: ClosingState;
  opsConfirmedBy: string | null;
  opsConfirmedAt: string | null;
}

export interface ClosingItem {
  id: string;
  closingId: string;
  itemCode: string;
  label: string;
  required: boolean;
  documentId: string | null;
  status: ClosingItemStatus;
  waivedReason: string | null;
}

export interface LegalTerm {
  id: string;
  closingId: string;
  investmentId: string | null;
  termType: string;
  value: Record<string, string | number | boolean>;
  status: LegalTermStatus;
  confirmedBy: string | null;
  confirmedAt: string | null;
}

/** Plain in the synthetic dataset; the loader encrypts them with the prototype key (SEC-12.2). */
export interface BankDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
  routingCode: string;
  reference?: string;
}

export interface WireInstruction {
  id: string;
  sponsorFundId: string | null;
  investmentId: string | null;
  counterpartyName: string;
  version: number;
  bankDetails: BankDetails;
  state: WireInstructionState;
  proposedBy: string;
  proposedAt: string;
  sourceNote: string | null;
  callbackBy: string | null;
  callbackAt: string | null;
  callbackNumberSource: CallbackNumberSource | null;
  callbackResult: CallbackResult | null;
  verifiedAt: string | null;
  rejectionReason: string | null;
  active: boolean;
}

export interface TradeTicket {
  id: string;
  capitalNoticeId: string;
  wireInstructionId: string | null;
  amount: string;
  currency: string;
  fundingDate: string;
  preparedBy: string;
  preparedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  state: TradeTicketState;
}

export interface ChangeRequest {
  id: string;
  investmentId: string;
  changeType: string;
  effectiveDate: string;
  details: Record<string, string>;
  summary: string;
  ownerId: string | null;
  submittedBy: string;
  state: ChangeRequestState;
  appliedPeriod: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
  rejectionReason: string | null;
}

/** The SEC-12.4 alert flags every capital notice carries (mon.capital_notice). */
export interface CapitalNoticeFlags {
  urgencyFlag: boolean;
  wireChangeFlag: boolean;
}
export type ControlledCapitalNotice = SyntheticDataset['capitalNotices'][number] &
  CapitalNoticeFlags;

/** The control arrays, in the loader's order. */
export interface ControlsDataset {
  opportunities: Opportunity[];
  opportunityStageHistory: OpportunityStageHistory[];
  diligenceTasks: DiligenceTask[];
  icDecisions: IcDecision[];
  allocations: Allocation[];
  closings: Closing[];
  closingItems: ClosingItem[];
  legalTerms: LegalTerm[];
  wireInstructions: WireInstruction[];
  tradeTickets: TradeTicket[];
  changeRequests: ChangeRequest[];
}

/* ---- Configuration (CLAUDE.md rule 9) ---- */

/** One required-document checklist item (config/closing_checklist.json). */
export interface ClosingChecklistItem {
  code: string;
  label: string;
  required: boolean;
}

/** One task of a diligence template (config/diligence_templates.json). */
export interface DiligenceTemplateTask {
  workstream: string;
  title: string;
  requiredForIc: boolean;
}

export interface DiligenceTemplates {
  /** By deal type code; a deal type without a template takes `default`. */
  templates: Record<string, DiligenceTemplateTask[]>;
  default: DiligenceTemplateTask[];
}

export interface ControlsConfig {
  closingChecklist: ClosingChecklistItem[];
  diligenceTemplates: DiligenceTemplates;
  /** Days a deal may sit in a stage before the board flags it (config pipeline.stageAgingDays). */
  stageAgingDays: Record<PipelineStage, number>;
}

const task = (
  workstream: string,
  title: string,
  requiredForIc: boolean,
): DiligenceTemplateTask => ({
  workstream: `diligence_workstream.${workstream}`,
  title,
  requiredForIc,
});

/**
 * The lists the generator reads when the config files are not there yet (the Phase 3 brief,
 * docs/04 M7 and M8). A committed file replaces them entirely; `controlsConfig` decides.
 */
export const CONTROLS_DEFAULTS: ControlsConfig = {
  closingChecklist: [
    {
      code: 'signed_documents',
      label: 'Signed subscription and transaction documents',
      required: true,
    },
    { code: 'cap_table', label: 'Closing capitalization table', required: true },
    { code: 'funds_flow', label: 'Funds flow memorandum', required: true },
    { code: 'wire_confirmation', label: 'Wire confirmation', required: true },
    { code: 'consents', label: 'Required consents recorded', required: true },
    { code: 'side_letter', label: 'Side letter', required: false },
    { code: 'closing_memo', label: 'Closing memo', required: false },
  ],
  diligenceTemplates: {
    templates: {
      'deal_type.co_invest_equity': [
        task('commercial', 'Market and competitive review', true),
        task('financial', 'Quality of earnings review', true),
        task('legal', 'Legal due diligence summary', true),
        task('tax', 'Tax structuring memo', false),
        task('esg', 'ESG screen', false),
        task('sponsor', 'Sponsor track record and references', true),
      ],
      'deal_type.cv_single_asset': [
        task('commercial', 'Asset performance and exit review', true),
        task('financial', 'Valuation and pricing analysis', true),
        task('legal', 'Continuation vehicle terms review', true),
        task('sponsor', 'Sponsor alignment and rollover', false),
      ],
      'deal_type.cv_multi_asset': [
        task('commercial', 'Portfolio composition and concentration review', true),
        task('financial', 'Asset by asset valuation review', true),
        task('legal', 'Continuation vehicle terms review', true),
        task('sponsor', 'Sponsor alignment and rollover', false),
      ],
      'deal_type.primary_fund': [
        task('sponsor', 'Track record and attribution analysis', true),
        task('legal', 'LPA and side letter review', true),
        task('operational', 'Operational due diligence', true),
        task('references', 'Reference calls with existing LPs', false),
        task('esg', 'ESG policy review', false),
      ],
      'deal_type.private_credit': [
        task('financial', 'Borrower credit analysis', true),
        task('legal', 'Credit documentation and covenant review', true),
        task('commercial', 'Market and sponsor backing review', true),
        task('operational', 'Collateral and reporting review', false),
      ],
    },
    default: [
      task('commercial', 'Commercial review', true),
      task('financial', 'Financial review', true),
      task('legal', 'Legal review', true),
    ],
  },
  stageAgingDays: pipelineStageAgingDays({}),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The checklist of a parsed config/closing_checklist.json, or an error naming what is wrong. */
export function closingChecklistFrom(
  raw: unknown,
  name = 'config/closing_checklist.json',
): ClosingChecklistItem[] {
  const items = isRecord(raw) ? raw.items : undefined;
  if (!Array.isArray(items) || items.length === 0)
    throw new Error(`${name}: items must be a non-empty array`);
  const out = items.map((item: unknown, i): ClosingChecklistItem => {
    if (
      !isRecord(item) ||
      typeof item.code !== 'string' ||
      item.code.length === 0 ||
      typeof item.label !== 'string' ||
      item.label.length === 0 ||
      typeof item.required !== 'boolean'
    )
      throw new Error(`${name}: items[${i}] needs a code, a label and a required flag`);
    return { code: item.code, label: item.label, required: item.required };
  });
  if (new Set(out.map((i) => i.code)).size !== out.length)
    throw new Error(`${name}: item codes must be unique`);
  return out;
}

function templateTasksFrom(raw: unknown, where: string, name: string): DiligenceTemplateTask[] {
  if (!Array.isArray(raw)) throw new Error(`${name}: ${where} must be an array of tasks`);
  return raw.map((t: unknown, i): DiligenceTemplateTask => {
    if (
      !isRecord(t) ||
      typeof t.workstream !== 'string' ||
      !t.workstream.startsWith('diligence_workstream.') ||
      typeof t.title !== 'string' ||
      t.title.length === 0 ||
      typeof t.requiredForIc !== 'boolean'
    )
      throw new Error(
        `${name}: ${where}[${i}] needs a diligence_workstream code, a title and a requiredForIc flag`,
      );
    return { workstream: t.workstream, title: t.title, requiredForIc: t.requiredForIc };
  });
}

/** The templates of a parsed config/diligence_templates.json, or an error naming what is wrong. */
export function diligenceTemplatesFrom(
  raw: unknown,
  name = 'config/diligence_templates.json',
): DiligenceTemplates {
  if (!isRecord(raw) || !isRecord(raw.templates))
    throw new Error(`${name}: templates must be an object keyed by deal_type code`);
  const templates: Record<string, DiligenceTemplateTask[]> = {};
  for (const [code, tasks] of Object.entries(raw.templates)) {
    if (!code.startsWith('deal_type.'))
      throw new Error(`${name}: templates are keyed by deal_type code, not ${code}`);
    templates[code] = templateTasksFrom(tasks, `templates.${code}`, name);
  }
  return { templates, default: templateTasksFrom(raw.default, 'default', name) };
}

/** The template a deal type takes: its own, or the default. */
export function diligenceTemplateFor(
  dealType: string,
  templates: DiligenceTemplates,
): DiligenceTemplateTask[] {
  return templates.templates[dealType] ?? templates.default;
}

/** The repo's config folder, from this module's location (src or dist, three levels down). */
const CONFIG_DIR = new URL('../../../config/', import.meta.url);

function readConfigFile(fileName: string): unknown {
  const url = new URL(fileName, CONFIG_DIR);
  if (!existsSync(url)) return undefined;
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

/**
 * What the generator builds the controls from: the committed config files when they exist
 * (`closing_checklist.json`, `diligence_templates.json`, `definitions.json` pipeline aging), the
 * documented defaults otherwise, and whatever the caller overrides.
 */
export function controlsConfig(overrides: Partial<ControlsConfig> = {}): ControlsConfig {
  const checklist = readConfigFile('closing_checklist.json');
  const templates = readConfigFile('diligence_templates.json');
  return {
    closingChecklist:
      overrides.closingChecklist ??
      (checklist === undefined
        ? CONTROLS_DEFAULTS.closingChecklist
        : closingChecklistFrom(checklist)),
    diligenceTemplates:
      overrides.diligenceTemplates ??
      (templates === undefined
        ? CONTROLS_DEFAULTS.diligenceTemplates
        : diligenceTemplatesFrom(templates)),
    stageAgingDays: overrides.stageAgingDays ?? pipelineStageAgingDays(),
  };
}

/* ---- Constants the tests and docs/14 cite ---- */

/** The pipeline of every profile (docs/14 section 10): deals per stage, besides one Closed per investment. */
export const PIPELINE_STAGE_COUNTS: Record<Exclude<DealStage, 'Closed'>, number> = {
  Sourced: 2,
  Screening: 2,
  Prescreen: 1,
  Diligence: 2,
  IC: 1,
  Approved: 1,
  Closing: 1,
  Passed: 2,
};

/** The data-level scenario tags the controls add (docs/14 section 3). */
export const CONTROL_SCENARIOS = [
  'sourced_deal',
  'closing_open',
  'passed_deal',
  'walled_opportunity',
  'ic_pending',
  'change_request_open',
] as const;
export type ControlScenario = (typeof CONTROL_SCENARIOS)[number];

/** How many sponsor funds get a Verified instruction (the ones with capital calls, first seen first). */
export const WIRE_COUNTERPARTY_CAP = 8;

/** Fictional banks for the synthetic register; never a real institution. */
export const BANK_NAMES = [
  'Harbor Street Bank',
  'Northline Trust',
  'Meridian Clearing',
  'Seaboard National Bank',
  'Lanternhill Savings',
  'Coastal Union Bank',
] as const;

/* ---- Small helpers ---- */

/** A string of `length` decimal digits drawn from the seeded generator (a synthetic account number). */
export function digitString(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(rng.int(0, 9));
  return out;
}

/**
 * An amount split by ownership so the lines sum exactly: each line is rounded to cents and the
 * last one takes the remainder (the allocation tie-out of M22 is exact, never within a tolerance).
 */
export function splitByOwnership<K>(
  amount: string,
  shares: readonly { key: K; pct: string }[],
): { key: K; amount: string }[] {
  const total = D(amount);
  let allocated = D('0');
  return shares.map((share, i) => {
    const slice =
      i === shares.length - 1
        ? total.minus(allocated)
        : total.times(D(share.pct)).toDecimalPlaces(2);
    allocated = allocated.plus(slice);
    return { key: share.key, amount: slice.toFixed(2) };
  });
}

/**
 * The control arrays a dataset carries, each empty when absent (a dataset from before the
 * controls). The loader's schema (packages/db seed.ts) is the shape authority; verify.ts checks the
 * references and the control rules over these rows.
 */
export function controlsOf(raw: unknown): ControlsDataset {
  const source: Record<string, unknown> = isRecord(raw) ? raw : {};
  const rows = (key: keyof ControlsDataset): unknown[] => {
    const value = source[key];
    return Array.isArray(value) ? value.filter(isRecord) : [];
  };
  return {
    opportunities: rows('opportunities') as Opportunity[],
    opportunityStageHistory: rows('opportunityStageHistory') as OpportunityStageHistory[],
    diligenceTasks: rows('diligenceTasks') as DiligenceTask[],
    icDecisions: rows('icDecisions') as IcDecision[],
    allocations: rows('allocations') as Allocation[],
    closings: rows('closings') as Closing[],
    closingItems: rows('closingItems') as ClosingItem[],
    legalTerms: rows('legalTerms') as LegalTerm[],
    wireInstructions: rows('wireInstructions') as WireInstruction[],
    tradeTickets: rows('tradeTickets') as TradeTicket[],
    changeRequests: rows('changeRequests') as ChangeRequest[],
  };
}

/* ---- Generation ---- */

/** What the controls are built from: the dataset as generated before them. */
export interface ControlsBase {
  asOf: string;
  users: SyntheticDataset['users'];
  sponsors: SyntheticDataset['sponsors'];
  sponsorFunds: SyntheticDataset['sponsorFunds'];
  portfolioCompanies: SyntheticDataset['portfolioCompanies'];
  vehicles: SyntheticDataset['vehicles'];
  lpCommitments: SyntheticDataset['lpCommitments'];
  commitments: SyntheticDataset['commitments'];
  investments: SyntheticDataset['investments'];
  cashFlows: SyntheticDataset['cashFlows'];
  /** Changed in place: the wire_change notice gets its two alert flags. */
  capitalNotices: ControlledCapitalNotice[];
  /** Changed in place: the walled opportunities join the first wall's records. */
  walls: SyntheticDataset['walls'];
  /** Read for the vehicle with a second closing and the walled deal. */
  scenarios: Record<string, string[]>;
}

export interface ControlsDeps {
  /** The controls' own stream, so adding them moved no other value. */
  rng: Rng;
  /** A name factory on that stream with every existing name reserved. */
  names: NameFactory;
  config: ControlsConfig;
  sectors: readonly string[];
  geographies: readonly string[];
  tag: (scenario: string, id: string) => void;
}

interface PipelineSpec {
  stage: Exclude<DealStage, 'Closed'>;
  /** For a Passed deal: the stage it was passed from. */
  passedFrom?: PipelineStage;
  dealType: string;
  /** The deal lead's mock user. */
  owner: string;
  source: string | null;
  scenario?: ControlScenario;
  passReason?: string;
  passNote?: string;
  /** False when the target commitment or the fund is not known yet. */
  targetKnown?: boolean;
  fundKnown?: boolean;
  /** True for a deal that has sat in its stage past the aging limit, so the board has one to flag. */
  aged?: boolean;
}

const PIPELINE: readonly PipelineSpec[] = [
  {
    stage: 'Sourced',
    dealType: 'deal_type.co_invest_equity',
    owner: 'deal.one',
    source: 'Sponsor introduction',
    scenario: 'sourced_deal',
  },
  {
    stage: 'Sourced',
    dealType: 'deal_type.cv_single_asset',
    owner: 'deal.two',
    source: 'Secondary adviser',
    targetKnown: false,
    fundKnown: false,
  },
  {
    stage: 'Screening',
    dealType: 'deal_type.co_invest_equity',
    owner: 'deal.two',
    source: 'Existing relationship',
    aged: true,
  },
  {
    stage: 'Screening',
    dealType: 'deal_type.private_credit',
    owner: 'deal.one',
    source: 'Placement agent',
  },
  {
    stage: 'Prescreen',
    dealType: 'deal_type.co_invest_equity',
    owner: 'deal.three',
    source: 'Conference meeting',
  },
  {
    stage: 'Diligence',
    dealType: 'deal_type.co_invest_equity',
    owner: 'deal.three',
    source: 'Sponsor introduction',
    scenario: 'walled_opportunity',
  },
  {
    stage: 'Diligence',
    dealType: 'deal_type.cv_multi_asset',
    owner: 'deal.two',
    source: 'Secondary adviser',
  },
  {
    stage: 'IC',
    dealType: 'deal_type.co_invest_equity',
    owner: 'deal.one',
    source: 'Existing relationship',
    scenario: 'ic_pending',
  },
  {
    stage: 'Approved',
    dealType: 'deal_type.primary_fund',
    owner: 'deal.two',
    source: 'Existing relationship',
  },
  {
    stage: 'Closing',
    dealType: 'deal_type.co_invest_equity',
    owner: 'deal.one',
    source: 'Sponsor introduction',
    scenario: 'closing_open',
  },
  {
    stage: 'Passed',
    passedFrom: 'Screening',
    dealType: 'deal_type.co_invest_equity',
    owner: 'deal.one',
    source: 'Placement agent',
    scenario: 'passed_deal',
    passReason: 'pass_reason.valuation',
    passNote: 'Entry valuation above the range the team would underwrite',
  },
  {
    stage: 'Passed',
    passedFrom: 'Diligence',
    dealType: 'deal_type.private_credit',
    owner: 'deal.two',
    source: 'Sponsor introduction',
    scenario: 'passed_deal',
    passReason: 'pass_reason.diligence_findings',
    passNote: 'Customer concentration found in diligence',
  },
];

const SOURCES = [
  'Sponsor introduction',
  'Placement agent',
  'Existing relationship',
  'Conference meeting',
  'Secondary adviser',
] as const;

const IC_CONDITION = 'Confirmatory legal review complete before signing';
const WAIVED_TASK_REASON = 'Covered by the sponsor review shared in diligence';

/** Why a required closing item is complete without a document in the hub (the seed holds no document rows). */
const WAIVED_ITEM_REASONS: Record<string, string> = {
  signed_documents: 'Executed set held by outside counsel; copy to follow the funding',
  cap_table: 'Closing cap table received in the sponsor data room',
  funds_flow: 'Funds flow agreed with the sponsor and held by operations',
  consents: 'Consents recorded in the closing memo',
};
const WAIVED_ITEM_FALLBACK = 'Held outside the document hub and recorded in the closing memo';

/** Structured values per legal term type (rates as decimal strings, never floats). */
const LEGAL_TERM_VALUES: Record<string, Record<string, string | number | boolean>> = {
  'legal_term_type.management_fee': {
    rate: '0.0150',
    basis: 'invested capital',
    stepDownAfterInvestmentPeriod: true,
  },
  'legal_term_type.carried_interest': { rate: '0.2000', catchUp: true, hurdle: '0.0800' },
  'legal_term_type.preferred_return': { rate: '0.0800', compounding: 'annual' },
  'legal_term_type.key_person': { namedPersons: 2, suspensionOnTrigger: true },
  'legal_term_type.transfer_restriction': {
    consentRequired: true,
    rightOfFirstRefusal: true,
    lockUpMonths: 24,
  },
  'legal_term_type.information_rights': {
    frequency: 'quarterly',
    financialsWithinDays: 45,
    boardObserver: false,
  },
  'legal_term_type.mfn': { elected: true, scope: 'fee and information terms' },
  'legal_term_type.co_invest_right': { proRata: true, feeFree: true, carryFree: true },
  'legal_term_type.consent_requirement': {
    matters: 'change of control, new debt above the agreed threshold',
    threshold: '0.5000',
  },
  'legal_term_type.notice_requirement': { prepaymentNoticeDays: 30, defaultNoticeDays: 5 },
};

interface ChangeRequestSpec {
  state: ChangeRequestState;
  changeType: string;
  summary: string;
  details: Record<string, string>;
  /** Days before the as-of date (or before the previous quarter end for an Applied one). */
  daysBefore: number;
}

const CHANGE_REQUESTS: readonly ChangeRequestSpec[] = [
  {
    state: 'Submitted',
    changeType: 'change_type.distribution_treatment',
    summary: 'Recallable distribution to be treated as a return of capital',
    details: {
      treatment: 'Return of capital, recallable within the recycling period',
      noticeReference: 'The distribution notice of the quarter',
    },
    daysBefore: 15,
  },
  {
    state: 'Routed',
    changeType: 'change_type.new_security',
    summary: 'Preferred equity issued in the sponsor follow-on round',
    details: { security: 'Series B preferred', participation: 'Pro rata to the existing holding' },
    daysBefore: 40,
  },
  {
    state: 'InProgress',
    changeType: 'change_type.recapitalization',
    summary: 'Dividend recapitalization with a new term loan',
    details: {
      newDebt: 'Term loan at the operating company',
      useOfProceeds: 'Dividend to shareholders',
    },
    daysBefore: 65,
  },
  {
    state: 'Applied',
    changeType: 'change_type.add_on_acquisition',
    summary: 'Add-on acquisition of a regional competitor closed',
    details: {
      target: 'A regional competitor',
      consideration: 'Cash and rolled equity',
      funding: 'Sponsor fund and the existing credit facility',
    },
    daysBefore: 10,
  },
  {
    state: 'Applied',
    changeType: 'change_type.partial_exit',
    summary: 'Partial sale of the position to a secondary buyer',
    details: { stakeSold: 'A minority of the holding', buyer: 'A secondary fund' },
    daysBefore: 35,
  },
  {
    state: 'Rejected',
    changeType: 'change_type.name_change',
    summary: 'Trading name change already reflected in the record',
    details: { newName: 'As shown on the latest quarterly report' },
    daysBefore: 100,
  },
];

/**
 * Builds the control rows for a generated dataset (docs/14 section 10). Pure given its inputs:
 * the same base, stream and config give the same rows.
 */
export function generateControls(base: ControlsBase, deps: ControlsDeps): ControlsDataset {
  const { rng, names, config, tag } = deps;
  const { asOf } = base;
  const out: ControlsDataset = {
    opportunities: [],
    opportunityStageHistory: [],
    diligenceTasks: [],
    icDecisions: [],
    allocations: [],
    closings: [],
    closingItems: [],
    legalTerms: [],
    wireInstructions: [],
    tradeTickets: [],
    changeRequests: [],
  };

  const userBy = (externalId: string): string => {
    const u = base.users.find((x) => x.externalId === externalId);
    if (!u) throw new Error(`no user ${externalId}`);
    return u.id;
  };
  const dealOne = userBy('deal.one');
  const dealTwo = userBy('deal.two');
  const opsOne = userBy('ops.one');
  const opsTwo = userBy('ops.two');
  const headOne = userBy('head.one');
  const fundById = new Map(base.sponsorFunds.map((f) => [f.id, f]));
  const companyById = new Map(base.portfolioCompanies.map((c) => [c.id, c]));
  const investmentById = new Map(base.investments.map((i) => [i.id, i]));
  const commitmentById = new Map(base.commitments.map((c) => [c.id, c]));
  const multiLpVehicleId = base.scenarios.lp_second_closing?.[0] ?? null;
  const walledInvestmentId = base.scenarios.walled_deal?.[0] ?? null;
  const firstWall = base.walls[0];

  /** An instant on a date, from the date alone. */
  const at = (date: string, hour: number): string =>
    `${date}T${String(hour).padStart(2, '0')}:00:00Z`;
  const onOrBefore = (date: string, limit: string): string =>
    compareIso(date, limit) > 0 ? limit : date;
  const spanIn = (stage: PipelineStage, factor: number): number =>
    Math.max(1, Math.round(config.stageAgingDays[stage] * factor));

  /** The date each stage was entered, walking back from the day the last one ended or still runs. */
  const entriesEndingAt = (
    stages: readonly PipelineStage[],
    end: string,
    daysInLast: number,
  ): string[] => {
    const entries: string[] = [];
    let date = addDays(end, -daysInLast);
    for (let i = stages.length - 1; i >= 0; i--) {
      entries.unshift(date);
      const previous = stages[i - 1];
      if (previous !== undefined) date = addDays(date, -spanIn(previous, 0.6));
    }
    return entries;
  };

  /** Who moved a deal into a stage, by the roles of docs/18 section 4. */
  const actorInto = (stage: DealStage): string =>
    stage === 'Approved' ? headOne : stage === 'Closed' ? opsOne : dealOne;

  interface StageExit {
    to: 'Closed' | 'Passed';
    date: string;
    command: string;
    reason: string | null;
    by: string;
  }
  const writeHistory = (
    opportunityId: string,
    stages: readonly PipelineStage[],
    entries: readonly string[],
    exit: StageExit | null,
  ): void => {
    let from: DealStage | null = null;
    stages.forEach((stage, i) => {
      out.opportunityStageHistory.push({
        id: rng.uuid(),
        opportunityId,
        fromStage: from,
        toStage: stage,
        command: i === 0 ? 'create' : 'advance',
        reason: null,
        changedBy: actorInto(stage),
        changedAt: at(entries[i] ?? asOf, 9 + i),
      });
      from = stage;
    });
    if (exit !== null)
      out.opportunityStageHistory.push({
        id: rng.uuid(),
        opportunityId,
        fromStage: from,
        toStage: exit.to,
        command: exit.command,
        reason: exit.reason,
        changedBy: exit.by,
        changedAt: at(exit.date, 16),
      });
  };

  type TaskMode = 'all_open' | 'in_diligence' | 'required_done' | 'all_done';
  const writeTasks = (
    opp: Opportunity,
    mode: TaskMode,
    completedOn: string | null,
    waiveOneOptional: boolean,
  ): void => {
    let waived = false;
    diligenceTemplateFor(opp.dealType, config.diligenceTemplates).forEach((t, i) => {
      let status: DiligenceTaskStatus = 'open';
      if (
        mode === 'all_done' ||
        (mode === 'required_done' && t.requiredForIc) ||
        (mode === 'in_diligence' && i === 0)
      )
        status = 'done';
      let waivedReason: string | null = null;
      if (waiveOneOptional && !waived && !t.requiredForIc && status === 'done') {
        status = 'waived';
        waivedReason = WAIVED_TASK_REASON;
        waived = true;
      }
      out.diligenceTasks.push({
        id: rng.uuid(),
        opportunityId: opp.id,
        workstream: t.workstream,
        title: t.title,
        ownerId: opp.ownerId,
        dueDate: status === 'open' ? addDays(asOf, 21 + 7 * i) : completedOn,
        status,
        requiredForIc: t.requiredForIc,
        evidenceDocumentId: null,
        waivedReason,
      });
    });
  };

  const writeIcDecision = (
    opp: Opportunity,
    decisionDate: string,
    amount: string | null,
    conditions: string[],
  ): void => {
    out.icDecisions.push({
      id: rng.uuid(),
      opportunityId: opp.id,
      decisionDate,
      decision: 'approved',
      amount,
      conditions,
      recordedBy: headOne,
    });
  };

  /** Vehicle-level lines, or one per client on the vehicle with a second closing (M22 tie-out). */
  const writeAllocations = (
    owner: { opportunityId: string | null; investmentId: string | null },
    vehicleId: string,
    amount: string,
    received: boolean,
  ): void => {
    const lps =
      vehicleId === multiLpVehicleId
        ? base.lpCommitments.filter((l) => l.vehicleId === vehicleId && l.ownershipPct !== null)
        : [];
    const lines: { key: string | null; amount: string }[] =
      lps.length > 0
        ? splitByOwnership(
            amount,
            lps.map((l) => ({ key: l.clientId, pct: l.ownershipPct ?? '0' })),
          )
        : [{ key: null, amount }];
    for (const line of lines)
      out.allocations.push({
        id: rng.uuid(),
        opportunityId: owner.opportunityId,
        investmentId: owner.investmentId,
        vehicleId,
        clientId: line.key,
        requested: line.amount,
        received: received ? line.amount : null,
      });
  };

  const termTypesFor = (dealType: string): string[] => {
    const names =
      dealType === 'deal_type.private_credit'
        ? [
            'notice_requirement',
            'transfer_restriction',
            'information_rights',
            'consent_requirement',
          ]
        : dealType.startsWith('deal_type.cv_')
          ? [
              'management_fee',
              'carried_interest',
              'preferred_return',
              'key_person',
              'transfer_restriction',
              'information_rights',
            ]
          : dealType === 'deal_type.primary_fund'
            ? [
                'management_fee',
                'carried_interest',
                'preferred_return',
                'key_person',
                'mfn',
                'co_invest_right',
              ]
            : [
                'information_rights',
                'transfer_restriction',
                'co_invest_right',
                'consent_requirement',
                'mfn',
              ];
    return names.map((n) => `legal_term_type.${n}`);
  };
  const writeLegalTerms = (
    closingId: string,
    investmentId: string | null,
    dealType: string,
    count: number,
    confirmed: { by: string; at: string } | null,
  ): void => {
    for (const termType of rng.shuffle(termTypesFor(dealType)).slice(0, count))
      out.legalTerms.push({
        id: rng.uuid(),
        closingId,
        investmentId,
        termType,
        value: { ...(LEGAL_TERM_VALUES[termType] ?? {}) },
        status: confirmed === null ? 'draft' : 'confirmed',
        confirmedBy: confirmed?.by ?? null,
        confirmedAt: confirmed?.at ?? null,
      });
  };

  /** The firm vehicle a new deal of a type would close into. */
  const vehicleFor = (dealType: string): string => {
    const ofType = (type: string) => base.vehicles.filter((v) => v.vehicleType === type);
    const wanted =
      dealType === 'deal_type.private_credit'
        ? ofType('vehicle_type.private_credit')
        : dealType.startsWith('deal_type.cv_')
          ? ofType('vehicle_type.cv')
          : dealType === 'deal_type.primary_fund'
            ? ofType('vehicle_type.primary_program')
            : ofType('vehicle_type.co_invest').sort((a, b) => (b.vintage ?? 0) - (a.vintage ?? 0));
    const vehicle = wanted[0] ?? base.vehicles[0];
    if (!vehicle) throw new Error('no vehicle for the pipeline');
    return vehicle.id;
  };

  const creditSponsorIds = new Set(
    base.sponsorFunds.filter((f) => f.strategy === 'strategy.credit').map((f) => f.sponsorId),
  );
  const equitySponsors = base.sponsors.filter((s) =>
    base.sponsorFunds.some((f) => f.sponsorId === s.id && f.strategy !== 'strategy.credit'),
  );
  const creditSponsors = base.sponsors.filter((s) => creditSponsorIds.has(s.id));
  const sponsorFor = (dealType: string): string => {
    const pool =
      dealType === 'deal_type.private_credit' && creditSponsors.length > 0
        ? creditSponsors
        : equitySponsors.length > 0
          ? equitySponsors
          : base.sponsors;
    return rng.pick(pool).id;
  };
  const fundFor = (sponsorId: string, dealType: string): string | null => {
    const credit = dealType === 'deal_type.private_credit';
    const funds = base.sponsorFunds.filter(
      (f) => f.sponsorId === sponsorId && (f.strategy === 'strategy.credit') === credit,
    );
    return funds.length > 0 ? rng.pick(funds).id : null;
  };
  const wallOpportunity = (opportunityId: string): void => {
    firstWall?.records.push({ entity: 'opportunity', entityId: opportunityId });
  };

  // ---- The pipeline: the same twelve deals in every profile ---------------------------------
  PIPELINE.forEach((spec, index) => {
    const sponsorId = sponsorFor(spec.dealType);
    const sector = rng.pick(deps.sectors);
    const through: PipelineStage =
      spec.stage === 'Passed' ? (spec.passedFrom ?? 'Screening') : spec.stage;
    const stages = PIPELINE_STAGES.slice(0, PIPELINE_STAGES.indexOf(through) + 1);
    const passedOn = addDays(asOf, -20);
    const end = spec.stage === 'Passed' ? passedOn : asOf;
    const daysInLast = spanIn(through, spec.stage === 'Passed' ? 0.5 : spec.aged ? 1.5 : 0.4);
    const entries = entriesEndingAt(stages, end, daysInLast);
    const entryOf = (stage: PipelineStage): string | null =>
      entries[PIPELINE_STAGES.indexOf(stage)] ?? null;
    const target = spec.targetKnown === false ? null : `${String(rng.int(5, 60))}000000.00`;
    const opp: Opportunity = {
      id: rng.uuid(),
      name: names.project(),
      companyName: names.company(sector),
      portfolioCompanyId: null,
      sponsorId,
      sponsorFundId: spec.fundKnown === false ? null : fundFor(sponsorId, spec.dealType),
      dealType: spec.dealType,
      sector,
      geography: rng.pick(deps.geographies),
      stage: spec.stage,
      ownerId: userBy(spec.owner),
      receivedDate: entries[0] ?? asOf,
      targetCommitment: target,
      source: spec.source,
      passReasonCode: spec.passReason ?? null,
      passNote: spec.passNote ?? null,
      investmentId: null,
      scenarioTag: spec.scenario ?? null,
    };
    out.opportunities.push(opp);
    if (spec.scenario !== undefined) tag(spec.scenario, opp.id);
    if (spec.scenario === 'walled_opportunity') wallOpportunity(opp.id);
    writeHistory(
      opp.id,
      stages,
      entries,
      spec.stage === 'Passed'
        ? {
            to: 'Passed',
            date: passedOn,
            command: 'pass',
            reason: spec.passNote ?? null,
            by: dealOne,
          }
        : null,
    );

    const reached = (stage: PipelineStage): boolean =>
      PIPELINE_STAGES.indexOf(through) >= PIPELINE_STAGES.indexOf(stage);
    if (spec.scenario === 'sourced_deal') writeTasks(opp, 'all_open', null, false);
    else if (spec.stage === 'IC') writeTasks(opp, 'required_done', entryOf('IC'), false);
    else if (spec.stage === 'Approved' || spec.stage === 'Closing')
      writeTasks(opp, 'all_done', entryOf('IC'), spec.scenario === 'closing_open');
    else if (reached('Diligence')) writeTasks(opp, 'in_diligence', null, false);

    if (spec.stage === 'Approved' || spec.stage === 'Closing')
      writeIcDecision(
        opp,
        entryOf('Approved') ?? asOf,
        target,
        index % 2 === 0 ? [IC_CONDITION] : [],
      );
    if (spec.stage === 'Approved' && target !== null)
      writeAllocations(
        { opportunityId: opp.id, investmentId: null },
        vehicleFor(spec.dealType),
        target,
        false,
      );
    if (spec.stage === 'Closing' && target !== null) {
      writeAllocations(
        { opportunityId: opp.id, investmentId: null },
        vehicleFor(spec.dealType),
        target,
        true,
      );
      const closing: Closing = {
        id: rng.uuid(),
        opportunityId: opp.id,
        investmentId: null,
        closeDate: addDays(asOf, 15),
        commitmentAmount: target,
        state: 'Open',
        opsConfirmedBy: null,
        opsConfirmedAt: null,
      };
      out.closings.push(closing);
      // Every required item but one is complete; the wire confirmation (or the last required
      // item) stays open for the closing page to finish.
      const required = config.closingChecklist.filter((i) => i.required).map((i) => i.code);
      const stillOpen = required.includes('wire_confirmation')
        ? 'wire_confirmation'
        : required[required.length - 1];
      for (const item of config.closingChecklist) {
        const waived = item.required && item.code !== stillOpen;
        out.closingItems.push({
          id: rng.uuid(),
          closingId: closing.id,
          itemCode: item.code,
          label: item.label,
          required: item.required,
          documentId: null,
          status: waived ? 'waived' : 'open',
          waivedReason: waived ? (WAIVED_ITEM_REASONS[item.code] ?? WAIVED_ITEM_FALLBACK) : null,
        });
      }
      writeLegalTerms(closing.id, null, spec.dealType, 2, null);
    }
  });

  // ---- One Closed opportunity and an OpsConfirmed closing per existing investment -----------
  // deal.closing needs its opportunity, so the deals that predate the prototype get the record
  // they would have had: the data captured once, closed at the entry date.
  base.investments.forEach((inv, index) => {
    const company = companyById.get(inv.portfolioCompanyId);
    const contributions = base.cashFlows.filter(
      (f) => f.investmentId === inv.id && f.flowType === 'flow_type.contribution',
    );
    const total = contributions.reduce((s, f) => s.plus(D(f.amount).abs()), D('0'));
    const first = contributions[0];
    const commitment = total.gt(0)
      ? total.toFixed(2)
      : first === undefined
        ? null
        : D(first.amount).abs().toFixed(2);
    if (commitment === null) return;
    const closeDate = inv.entryDate;
    const entries = entriesEndingAt(PIPELINE_STAGES, closeDate, spanIn('Closing', 0.6));
    const opp: Opportunity = {
      id: rng.uuid(),
      name: names.project(),
      companyName: company?.name ?? inv.investmentNumber,
      portfolioCompanyId: inv.portfolioCompanyId,
      sponsorId: inv.sponsorId,
      sponsorFundId: inv.sponsorFundId,
      dealType: inv.dealType,
      sector: company?.sector ?? null,
      geography: company?.geography ?? null,
      stage: 'Closed',
      ownerId: index % 2 === 0 ? dealOne : dealTwo,
      receivedDate: entries[0] ?? closeDate,
      targetCommitment: commitment,
      source: rng.pick(SOURCES),
      passReasonCode: null,
      passNote: null,
      investmentId: inv.id,
      scenarioTag: null,
    };
    out.opportunities.push(opp);
    if (inv.id === walledInvestmentId) wallOpportunity(opp.id);
    writeHistory(opp.id, PIPELINE_STAGES, entries, {
      to: 'Closed',
      date: closeDate,
      command: 'advance',
      reason: null,
      by: opsOne,
    });
    const icEntered = entries[PIPELINE_STAGES.indexOf('IC')] ?? closeDate;
    const approvedOn = entries[PIPELINE_STAGES.indexOf('Approved')] ?? closeDate;
    writeTasks(opp, 'all_done', icEntered, false);
    writeIcDecision(opp, approvedOn, commitment, index % 3 === 0 ? [IC_CONDITION] : []);
    writeAllocations(
      { opportunityId: null, investmentId: inv.id },
      inv.vehicleId,
      commitment,
      true,
    );
    const closing: Closing = {
      id: rng.uuid(),
      opportunityId: opp.id,
      investmentId: inv.id,
      closeDate,
      commitmentAmount: commitment,
      state: 'OpsConfirmed',
      opsConfirmedBy: opsOne,
      opsConfirmedAt: at(onOrBefore(addDays(closeDate, 1), asOf), 16),
    };
    out.closings.push(closing);
    writeLegalTerms(closing.id, inv.id, inv.dealType, rng.int(2, 3), {
      by: dealOne,
      at: at(onOrBefore(addDays(closeDate, 2), asOf), 11),
    });
  });

  // ---- The wire register and the trade tickets (SEC-12) --------------------------------------
  const fundOfNotice = (n: ControlledCapitalNotice): string | null =>
    n.investmentId !== null
      ? (investmentById.get(n.investmentId)?.sponsorFundId ?? null)
      : n.commitmentId !== null
        ? (commitmentById.get(n.commitmentId)?.sponsorFundId ?? null)
        : null;
  const calls = base.capitalNotices.filter((n) => n.noticeType === 'notice_type.capital_call');
  const wireChange = calls.find((n) => n.scenarioTag === 'wire_change');
  const counterparties: string[] = [];
  const consider = (fundId: string | null): void => {
    if (fundId === null || counterparties.includes(fundId)) return;
    if (counterparties.length < WIRE_COUNTERPARTY_CAP) counterparties.push(fundId);
  };
  if (wireChange !== undefined) consider(fundOfNotice(wireChange));
  for (const n of calls) consider(fundOfNotice(n));

  const activeByFund = new Map<string, WireInstruction>();
  for (const fundId of counterparties) {
    const fund = fundById.get(fundId);
    if (fund === undefined) continue;
    const firstIssue =
      calls
        .filter((n) => fundOfNotice(n) === fundId)
        .map((n) => n.issueDate)
        .sort()[0] ?? asOf;
    const callbackOn = addDays(firstIssue, -6);
    const instruction: WireInstruction = {
      id: rng.uuid(),
      sponsorFundId: fundId,
      investmentId: null,
      counterpartyName: fund.name,
      version: 1,
      bankDetails: {
        bankName: rng.pick(BANK_NAMES),
        accountName: fund.name,
        accountNumber: digitString(rng, 10),
        routingCode: digitString(rng, 9),
        reference: 'LP capital account',
      },
      state: 'Verified',
      proposedBy: opsOne,
      proposedAt: at(addDays(firstIssue, -7), 10),
      sourceNote: 'Instruction letter received with the subscription documents',
      callbackBy: opsTwo,
      callbackAt: at(callbackOn, 15),
      callbackNumberSource: 'prior_instruction',
      callbackResult: 'confirmed',
      verifiedAt: at(callbackOn, 15),
      rejectionReason: null,
      active: true,
    };
    out.wireInstructions.push(instruction);
    activeByFund.set(fundId, instruction);
  }

  // The changed instruction arrives as a second, unverified version; its ticket waits in draft
  // and the notice carries both alerts (SEC-12.4).
  const wireChangeFund = wireChange === undefined ? null : fundOfNotice(wireChange);
  const current = wireChangeFund === null ? undefined : activeByFund.get(wireChangeFund);
  if (wireChange !== undefined && wireChangeFund !== null && current !== undefined) {
    const otherBanks = BANK_NAMES.filter((b) => b !== current.bankDetails.bankName);
    out.wireInstructions.push({
      id: rng.uuid(),
      sponsorFundId: wireChangeFund,
      investmentId: null,
      counterpartyName: current.counterpartyName,
      version: 2,
      bankDetails: {
        bankName: rng.pick(otherBanks),
        accountName: current.counterpartyName,
        accountNumber: digitString(rng, 10),
        routingCode: digitString(rng, 9),
        reference: 'LP capital account',
      },
      state: 'Proposed',
      proposedBy: opsOne,
      proposedAt: at(asOf, 9),
      sourceNote: 'Changed instructions received in the notice',
      callbackBy: null,
      callbackAt: null,
      callbackNumberSource: null,
      callbackResult: null,
      verifiedAt: null,
      rejectionReason: null,
      active: false,
    });
    wireChange.urgencyFlag = true;
    wireChange.wireChangeFlag = true;
    out.tradeTickets.push({
      id: rng.uuid(),
      capitalNoticeId: wireChange.id,
      wireInstructionId: null,
      amount: wireChange.amount,
      currency: 'USD',
      fundingDate: wireChange.dueDate,
      preparedBy: opsOne,
      preparedAt: at(asOf, 10),
      approvedBy: null,
      approvedAt: null,
      state: 'Drafted',
    });
  }

  // Every reconciled call of a verified counterparty was funded through a ticket a second person
  // approved against the active version (SEC-12.3).
  for (const n of calls) {
    if (n.state !== 'Reconciled') continue;
    const fundId = fundOfNotice(n);
    const active = fundId === null ? undefined : activeByFund.get(fundId);
    if (active === undefined) continue;
    out.tradeTickets.push({
      id: rng.uuid(),
      capitalNoticeId: n.id,
      wireInstructionId: active.id,
      amount: n.amount,
      currency: 'USD',
      fundingDate: n.dueDate,
      preparedBy: opsOne,
      preparedAt: at(n.issueDate, 10),
      approvedBy: headOne,
      approvedAt: at(onOrBefore(addDays(n.issueDate, 1), asOf), 11),
      state: 'Funded',
    });
  }

  // ---- Deal change requests (M11): one per state plus one more Applied ----------------------
  const candidates = base.investments
    .filter((i) => i.isActive && i.id !== walledInvestmentId)
    .sort((a, b) => a.investmentNumber.localeCompare(b.investmentNumber));
  const previousQuarter = containingQuarterEnd(addMonths(asOf, -3));
  CHANGE_REQUESTS.forEach((spec, i) => {
    const inv = candidates[i % Math.max(1, candidates.length)];
    if (inv === undefined) return;
    const applied = spec.state === 'Applied';
    const row: ChangeRequest = {
      id: rng.uuid(),
      investmentId: inv.id,
      changeType: spec.changeType,
      effectiveDate: addDays(applied ? previousQuarter : asOf, -spec.daysBefore),
      details: { ...spec.details },
      summary: spec.summary,
      ownerId: spec.state === 'Submitted' ? null : opsOne,
      submittedBy: dealOne,
      state: spec.state,
      appliedPeriod: applied ? previousQuarter : null,
      appliedBy: applied ? opsOne : null,
      appliedAt: applied ? at(addDays(previousQuarter, 1), 16) : null,
      rejectionReason:
        spec.state === 'Rejected' ? 'The record already carries the new trading name' : null,
    };
    out.changeRequests.push(row);
    if (spec.state === 'InProgress') tag('change_request_open', row.id);
  });

  return out;
}
