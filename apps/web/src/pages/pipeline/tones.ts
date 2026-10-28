/*
 * merge: replace with lib/states.ts
 *
 * Tone maps for the deal stage (docs/18 section 4) and the closing state (section 12). W1 adds
 * stageTone and closingTone to lib/states.ts in a parallel worktree; at the merge the orchestrator
 * deletes this file and points the pipeline imports at lib/states.ts. docs/06: a colour carries
 * one meaning, so the maps follow the ones the notice and valuation pages use: watch is a person's
 * turn (the IC decision, the operations confirmation), brand is work in progress the team owns,
 * good is settled, neutral needs nobody.
 */
import type { Tone } from '../../components/ui.js';

const STAGE_TONES: Readonly<Record<string, Tone>> = {
  Sourced: 'neutral',
  Screening: 'neutral',
  Prescreen: 'brand',
  Diligence: 'brand',
  IC: 'watch',
  Approved: 'good',
  Closing: 'brand',
  Closed: 'good',
  Passed: 'neutral',
};

export function stageTone(stage: string): Tone {
  return STAGE_TONES[stage] ?? 'neutral';
}

const CLOSING_TONES: Readonly<Record<string, Tone>> = {
  Open: 'watch',
  OpsConfirmed: 'good',
};

export function closingTone(state: string): Tone {
  return CLOSING_TONES[state] ?? 'neutral';
}
