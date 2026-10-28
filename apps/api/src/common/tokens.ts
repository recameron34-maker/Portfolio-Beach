/** Injection tokens for runtime objects built outside Nest (database, adapters, config, logger). */
export const DB_HANDLE = 'PB_DB_HANDLE';
export const ADAPTERS = 'PB_ADAPTERS';
export const CONFIG = 'PB_CONFIG';
export const LOGGER = 'PB_LOGGER';
export const DEFINITIONS = 'PB_DEFINITIONS';
/** config/accounting_layout.json as read from disk; the intake service parses it with @pb/validation. */
export const ACCOUNTING_LAYOUT = 'PB_ACCOUNTING_LAYOUT';
/** config/lookthrough_mapping.json, parsed and checked at startup (LookthroughMapping from @pb/contracts). */
export const LOOKTHROUGH_MAPPING = 'PB_LOOKTHROUGH_MAPPING';
/** config/ops_drop_templates.json, parsed and checked at startup (OpsDropTemplates from @pb/contracts). */
export const OPS_DROP_TEMPLATES = 'PB_OPS_DROP_TEMPLATES';
/** config/closing_checklist.json, parsed and checked at startup (ClosingChecklist from @pb/contracts). */
export const CLOSING_CHECKLIST = 'PB_CLOSING_CHECKLIST';
/** config/diligence_templates.json, parsed and checked at startup (DiligenceTemplates from @pb/contracts). */
export const DILIGENCE_TEMPLATES = 'PB_DILIGENCE_TEMPLATES';
