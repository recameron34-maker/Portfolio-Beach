import type { Tone } from '../../components/ui.js';

/*
 * merge: replace with lib/states.ts. The tone maps of the wire register and the trade tickets
 * (docs/18 sections 3 and 11), defined here while agent W1 adds the same names to lib/states.ts;
 * the orchestrator dedups at the merge. docs/06: a colour carries one meaning, so a step waiting
 * on a person reads watch, an approved ticket brand, a verified or settled record good, a refusal
 * bad, and a version that no longer matters neutral.
 */

const WIRE_TONES: Readonly<Record<string, Tone>> = {
  Proposed: 'watch',
  Verified: 'good',
  Rejected: 'bad',
  Superseded: 'neutral',
};

/** docs/18 section 11: Proposed waits for its callback, Verified is the one active version. */
export function wireTone(state: string): Tone {
  return WIRE_TONES[state] ?? 'neutral';
}

const TICKET_TONES: Readonly<Record<string, Tone>> = {
  Drafted: 'watch',
  Approved: 'brand',
  Funded: 'good',
  Withdrawn: 'neutral',
};

/** docs/18 section 3: Drafted waits for its approver, Approved waits for the wire, Funded is settled. */
export function ticketTone(state: string): Tone {
  return TICKET_TONES[state] ?? 'neutral';
}
