export { generateDataset } from './generate.js';
export type { GenerateOptions, GeneratedDataset } from './generate.js';
export { verifyDataset } from './verify.js';
export type { VerifyReport } from './verify.js';
export { PROFILES, DATA_SCENARIOS, DOCUMENT_SCENARIOS } from './profiles.js';
export { Rng } from './prng.js';
export { accountingExport, accountingExports } from './accounting-export.js';
export type {
  AccountingExport,
  AccountingExportExpectations,
  AccountingExportOptions,
  ExportScenario,
} from './accounting-export.js';
export {
  QUARTERLY_REPORTING_DEAL_TYPES,
  previewBook,
  previewDocumentPath,
  previewLookthroughExtracts,
  previewLookthroughFileName,
  previewOpsDropFileName,
  previewOpsDropWorkbooks,
  previewSampleFileName,
  previewWeeklyFileName,
  previewWeeklyFiles,
} from './preview-book.js';
export type {
  PreviewBook,
  PreviewBookDocument,
  PreviewBookExpectedDocumentDefaults,
  PreviewBookInvestment,
  PreviewBookLookthroughSample,
  PreviewBookMark,
  PreviewBookOpsDropSample,
  PreviewBookOptions,
  PreviewBookQuarter,
  PreviewBookSample,
  PreviewBookSponsorFund,
  PreviewBookWeeklySample,
} from './preview-book.js';
export {
  ALIASES_PER_COMPANY_MAX,
  ALIAS_SHARE,
  abbreviatedForm,
  aliasesOf,
  companyAliasesFor,
  shortenedForm,
} from './aliases.js';
export type { AliasGuard, AliasSource, AliasedDataset, CompanyAlias } from './aliases.js';
export { csvCell, csvText } from './csv.js';
export {
  INTAKE_DEFAULTS,
  PIPELINE_DEFAULTS,
  intakeDecimal,
  intakeWholeNumber,
  pipelineStageAgingDays,
} from './settings.js';
export type { IntakeDecimalKey, IntakeWholeNumberKey, PipelineStageKey } from './settings.js';
export {
  BANK_NAMES,
  CONTROLS_DEFAULTS,
  CONTROL_SCENARIOS,
  PIPELINE_STAGES,
  PIPELINE_STAGE_COUNTS,
  WIRE_COUNTERPARTY_CAP,
  closingChecklistFrom,
  controlsConfig,
  controlsOf,
  digitString,
  diligenceTemplateFor,
  diligenceTemplatesFrom,
  generateControls,
  splitByOwnership,
} from './controls.js';
export type {
  Allocation,
  BankDetails,
  CallbackNumberSource,
  CallbackResult,
  CapitalNoticeFlags,
  ChangeRequest,
  ChangeRequestState,
  Closing,
  ClosingChecklistItem,
  ClosingItem,
  ClosingItemStatus,
  ClosingState,
  ControlScenario,
  ControlledCapitalNotice,
  ControlsBase,
  ControlsConfig,
  ControlsDataset,
  ControlsDeps,
  DealStage,
  DiligenceTask,
  DiligenceTaskStatus,
  DiligenceTemplateTask,
  DiligenceTemplates,
  IcDecision,
  IcDecisionOutcome,
  LegalTerm,
  LegalTermStatus,
  Opportunity,
  OpportunityStageHistory,
  PipelineStage,
  TradeTicket,
  TradeTicketState,
  WireInstruction,
  WireInstructionState,
} from './controls.js';
export { activePositions, latestLockedMark, takeRows, walledInvestment } from './marks.js';
export {
  WEEKLY_HEADER,
  WEEKLY_MOVES,
  WEEKLY_MOVE_BEYOND,
  fridayOnOrBefore,
  weeklyValues,
  weeklyValuesSet,
} from './weekly-values.js';
export type {
  WeeklyScenario,
  WeeklyValues,
  WeeklyValuesExpectations,
  WeeklyValuesOptions,
} from './weekly-values.js';
export {
  LOOKTHROUGH_COST_BEYOND,
  LOOKTHROUGH_MOVES,
  LOOKTHROUGH_MOVE_BEYOND,
  PROVIDER_LABELS,
  PROVIDER_VOCABULARY,
  UNMAPPED_SECTOR_LABEL,
  investedCost,
  lookthroughExtract,
  lookthroughExtracts,
} from './lookthrough-extract.js';
export type {
  LookthroughExpectations,
  LookthroughExtract,
  LookthroughExtractOptions,
  LookthroughField,
  LookthroughScenario,
} from './lookthrough-extract.js';
export {
  OPS_DROP_COLUMNS,
  OPS_DROP_FIGURES_HEADER,
  OPS_DROP_NOTES_PREPARED_BY,
  OPS_DROP_SCENARIOS,
  OPS_DROP_SHEET_NAMES,
  OPS_DROP_TEMPLATE,
  OPS_DROP_UNKNOWN_HEADER_CELL,
  opsDropSamples,
  opsDropSheets,
  opsDropWorkbook,
  opsDropWorkbooks,
} from './ops-drop.js';
export type {
  OpsDropExpectations,
  OpsDropOptions,
  OpsDropSample,
  OpsDropScenario,
  OpsDropSheet,
  OpsDropWorkbook,
} from './ops-drop.js';
export {
  DOCUMENT_DEFAULTS,
  DOCUMENT_FOOTER,
  DOCUMENT_SET_SCENARIOS,
  DOC_TYPE_LABELS,
  INJECTION_PAGE_ONE_TEXT,
  INJECTION_TEXT,
  NOTICE_FIELDS,
  QUARTERLY_FIELDS,
  RESTATEMENT_DRIFT,
  STATEMENT_FIELDS,
  SYNTHETIC_DOC_TYPES,
  UNTAGGED_FILE_NAME,
  dateInWords,
  documentFileName,
  generateDocuments,
  millions,
  sanitizeFileName,
  sha256Hex,
  wrapText,
} from './documents.js';
export type {
  DocumentScenario,
  DocumentSet,
  DocumentSetExpectations,
  GenerateDocumentsOptions,
  LateFinancials,
  QuarterlyField,
  SyntheticDocType,
  SyntheticDocument,
  Truth,
  TruthField,
  TruthUnit,
} from './documents.js';
