import {
  callbackNumberSource,
  callbackResult,
  wireInstructionProposeBody,
  wireInstructionState,
} from '@pb/contracts';
import type {
  CallbackNumberSource,
  CallbackResult,
  WireCallback,
  WireCounterparty,
  WireInstructionCommandBody,
  WireInstructionProposeBody,
  WireInstructionRow,
  WireInstructionState,
} from '@pb/contracts';
import { MISSING } from '../../lib/format.js';
import { isReason } from '../../lib/workflow.js';

/*
 * The wire register's pure helpers (docs/04 M16, docs/18 section 11, SEC-12.1 to SEC-12.3):
 * the states and their filters, the words for the callback choices, and the two forms' checks,
 * made against the contract's own schemas so nothing leaves the page that the API would refuse.
 */

/** The four states in the order of docs/18 section 11. */
export const WIRE_STATES: readonly WireInstructionState[] = wireInstructionState.options;

export function isWireState(value: string): value is WireInstructionState {
  return (WIRE_STATES as readonly string[]).includes(value);
}

export const NUMBER_SOURCES: readonly CallbackNumberSource[] = callbackNumberSource.options;

export function isNumberSource(value: string): value is CallbackNumberSource {
  return (NUMBER_SOURCES as readonly string[]).includes(value);
}

export const CALLBACK_RESULTS: readonly CallbackResult[] = callbackResult.options;

export function isCallbackResult(value: string): value is CallbackResult {
  return (CALLBACK_RESULTS as readonly string[]).includes(value);
}

/** Where the callback number came from, in words: never the notice or the email asking for the change. */
export const NUMBER_SOURCE_WORDS: Readonly<Record<CallbackNumberSource, string>> = {
  prior_instruction: 'Prior instruction on file',
  sponsor_website: 'Sponsor website',
  known_contact: 'Known contact',
  fund_administrator: 'Fund administrator',
};

export const RESULT_WORDS: Readonly<Record<CallbackResult, string>> = {
  confirmed: 'Confirmed',
  not_confirmed: 'Not confirmed',
};

/** "Tomas Achterberg: confirmed (prior instruction on file)", or the missing placeholder. */
export function callbackWords(callback: WireCallback | null): string {
  if (callback === null) return MISSING;
  return `${callback.by.name}: ${RESULT_WORDS[callback.result].toLowerCase()} (${NUMBER_SOURCE_WORDS[callback.numberSource].toLowerCase()})`;
}

/** The calendar day of an ISO timestamp ("2025-07-10T09:00:00.000Z" to "2025-07-10"). */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** "Sponsor fund" or "Investment": the kind of counterparty an instruction belongs to. */
export function kindLabel(kind: WireCounterparty['kind']): string {
  return kind === 'investment' ? 'Investment' : 'Sponsor fund';
}

/** The roles that record a callback (docs/18 section 11: operations and approvers, never the proposer). */
export const CALLBACK_ROLES: readonly string[] = ['operations', 'approver'];

/** The roles that propose a version: operations types the details from a verified source (SEC-12.1). */
export const PROPOSE_ROLES: readonly string[] = ['operations'];

/** The second-person rule as the machine words it (SEC-12.2). */
export const SECOND_PERSON_RULE =
  'The callback must be made by a person other than the proposer (SEC-12.2)';

export interface WireFilters {
  state: WireInstructionState | '';
  counterparty: string;
}

/** Client-side filters over the one unfiltered page, in the register's own order (newest first). */
export function filterWires(
  items: readonly WireInstructionRow[],
  f: WireFilters,
): WireInstructionRow[] {
  return items.filter(
    (w) =>
      (f.state === '' || w.state === f.state) &&
      (f.counterparty === '' || w.counterparty.name === f.counterparty),
  );
}

/** Distinct counterparty names, sorted. */
export function counterpartyNames(items: readonly WireInstructionRow[]): string[] {
  return [...new Set(items.map((w) => w.counterparty.name))].sort((a, b) => a.localeCompare(b));
}

/** The query that lists every version of an instruction's counterparty. */
export function counterpartyFilter(
  counterparty: WireCounterparty,
): { investmentId: string } | { sponsorFundId: string } {
  return counterparty.kind === 'investment'
    ? { investmentId: counterparty.id }
    : { sponsorFundId: counterparty.id };
}

/* ---- The propose form ---- */

export interface ProposeForm {
  kind: WireCounterparty['kind'];
  counterpartyId: string;
  counterpartyName: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  routingCode: string;
  reference: string;
  sourceNote: string;
}

export const EMPTY_PROPOSE_FORM: ProposeForm = {
  kind: 'investment',
  counterpartyId: '',
  counterpartyName: '',
  bankName: '',
  accountName: '',
  accountNumber: '',
  routingCode: '',
  reference: '',
  sourceNote: '',
};

/** The body as the contract shapes it: trimmed, the optional fields left out when empty. */
export function proposeBody(form: ProposeForm): unknown {
  const reference = form.reference.trim();
  const sourceNote = form.sourceNote.trim();
  return {
    ...(form.kind === 'investment'
      ? { investmentId: form.counterpartyId }
      : { sponsorFundId: form.counterpartyId }),
    counterpartyName: form.counterpartyName.trim(),
    bankDetails: {
      bankName: form.bankName.trim(),
      accountName: form.accountName.trim(),
      accountNumber: form.accountNumber.trim(),
      routingCode: form.routingCode.trim(),
      ...(reference === '' ? {} : { reference }),
    },
    ...(sourceNote === '' ? {} : { sourceNote }),
  };
}

export type ProposeField = keyof ProposeForm;

/** What the form says about each field, in plain words, before anything is sent. */
const FIELD_WORDS: Readonly<Record<ProposeField, string>> = {
  kind: 'Choose the kind of counterparty.',
  counterpartyId: 'Choose the counterparty.',
  counterpartyName: 'Give the counterparty name as it appears on the instruction.',
  bankName: 'Give the bank name.',
  accountName: 'Give the account name.',
  accountNumber: 'Digits only, 6 to 20 of them.',
  routingCode: 'Digits only, 6 to 20 of them.',
  reference: 'Up to 200 characters.',
  sourceNote: 'Up to 500 characters.',
};

const PATH_FIELDS: Readonly<Record<string, ProposeField>> = {
  investmentId: 'counterpartyId',
  sponsorFundId: 'counterpartyId',
  counterpartyName: 'counterpartyName',
  'bankDetails.bankName': 'bankName',
  'bankDetails.accountName': 'accountName',
  'bankDetails.accountNumber': 'accountNumber',
  'bankDetails.routingCode': 'routingCode',
  'bankDetails.reference': 'reference',
  sourceNote: 'sourceNote',
};

/**
 * The problems of the form by field, judged by the contract's propose body: an empty map means
 * the body is ready. A field the schema names that the form does not know maps to the name.
 */
export function proposeProblems(form: ProposeForm): Partial<Record<ProposeField, string>> {
  const out: Partial<Record<ProposeField, string>> = {};
  if (form.counterpartyId === '') out.counterpartyId = FIELD_WORDS.counterpartyId;
  const parsed = wireInstructionProposeBody.safeParse(proposeBody(form));
  if (parsed.success) return out;
  for (const issue of parsed.error.issues) {
    const field = PATH_FIELDS[issue.path.join('.')] ?? 'counterpartyName';
    out[field] ??= FIELD_WORDS[field];
  }
  return out;
}

/** The parsed body, or null while the form has problems. */
export function parsedProposeBody(form: ProposeForm): WireInstructionProposeBody | null {
  const parsed = wireInstructionProposeBody.safeParse(proposeBody(form));
  return parsed.success ? parsed.data : null;
}

/* ---- The callback form ---- */

export interface CallbackForm {
  numberSource: CallbackNumberSource | '';
  result: CallbackResult | '';
  reason: string;
}

export const EMPTY_CALLBACK_FORM: CallbackForm = { numberSource: '', result: '', reason: '' };

/**
 * verify for a confirming callback; reject, with the callback logged, for one that did not
 * confirm (docs/18 section 11: reject needs a reason). Null while a choice or the reason is missing.
 */
export function callbackBody(form: CallbackForm): WireInstructionCommandBody | null {
  if (form.numberSource === '' || form.result === '') return null;
  if (form.result === 'confirmed')
    return {
      command: 'verify',
      callbackNumberSource: form.numberSource,
      callbackResult: 'confirmed',
    };
  if (!isReason(form.reason)) return null;
  return {
    command: 'reject',
    callbackNumberSource: form.numberSource,
    callbackResult: 'not_confirmed',
    reason: form.reason.trim(),
  };
}
