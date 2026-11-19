import { labelOf } from '../lib/format.js';
import { withoutReferences } from '../lib/references.js';

/*
 * A sentence written for the audit trail or the engineer, as a page shows it (docs/06 section 6).
 * The API, the validation rules and the workflow notes keep their own words; the page shows them
 * without what names the build:
 * - the controls and documents a sentence cites, "(SEC-12.3)" or "(docs/18 section 4)"
 *   (lib/references.ts);
 * - a bare "(section 12)", which a workflow note uses for the guide's section on a step;
 * - a switch's key in brackets, "AI extraction is switched off (ai.extraction)": the sentence
 *   already says which switch in words;
 * - a configuration file: dropped when it stands alone in brackets, and named in words where the
 *   sentence needs it, "not in config/lookthrough_mapping.json" reading "not in the look-through
 *   mapping".
 * Every other word stays as it came.
 */

const SECTIONS = / ?\(sections? \d+(?:(?:, | and )\d+)*\)/g;
const SWITCH_KEY = / ?\((?:ai|adapter|ops)\.[a-z_.]+\)/g;
const CONFIG_ALONE = / ?\(config\/[\w-]+\.json(?: [\w.]+)?\)/g;
const CONFIG_FILE = /config\/([\w-]+)\.json/g;

const fileWords = (name: string): string =>
  `the ${name.split(/[_-]/).join(' ').replace('lookthrough', 'look-through')}`;

export function plainWords(text: string): string {
  return withoutReferences(text)
    .replace(SECTIONS, '')
    .replace(SWITCH_KEY, '')
    .replace(CONFIG_ALONE, '')
    .replace(CONFIG_FILE, (_file, name: string) => fileWords(name));
}

/*
 * A taxonomy code ("sector.energy_transition") inside a value or a reason a record holds, by the
 * domains the taxonomy keeps. A file name ("extract.csv") is not one of them, so it stays.
 */
const DOMAINS =
  'base_rate|change_type|covenant_status|deal_type|diligence_workstream|doc_type|exception_severity|facility_type|flow_type|geography|legal_term_type|notice_type|pass_reason|payment_status|realization_outlook|record_status|sector|sponsor_tier|strategy|valuation_method|vehicle_type';
const CODE = new RegExp(`\\b(?:${DOMAINS})\\.[a-z0-9_]+\\b`, 'g');
const WHOLE_CODE = new RegExp(`^(?:${DOMAINS})\\.[a-z0-9_]+$`);
/** A provider's label followed by the code it was mapped to: "Healthcare (sector.healthcare)". */
const MAPPED = new RegExp(` \\((?:${DOMAINS})\\.[a-z0-9_]+\\)$`);

/**
 * A value as a reader says it: a code by its label ("Energy transition"), a provider's label
 * without the code it was mapped to ("Healthcare"), a code inside a sentence by its label. Any
 * other value (a figure, a name, a sentence) stays exactly as it came; no unit is added.
 */
export function codeWords(value: string): string {
  if (WHOLE_CODE.test(value)) return labelOf(value);
  return value.replace(MAPPED, '').replace(CODE, (code) => labelOf(code));
}
