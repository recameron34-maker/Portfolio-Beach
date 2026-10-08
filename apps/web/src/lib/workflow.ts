import { useCallback, useRef, useState } from 'react';
import { previewMode } from '../app/env.js';
import { rolesLabel } from './states.js';

/**
 * Workflow action rules shared by the valuation board and the capital notice pages (docs/18).
 * The API serves reads only in this build, so outside the preview every action is disabled;
 * the preview simulates the commands through the same transition tables.
 */
export const PHASE_3_TITLE = 'Workflow actions arrive with Phase 3';

/** The words every success message ends with: nothing is saved or audited in the preview. */
export function resultSuffix(): string {
  return previewMode ? '(simulated in this preview, not audited)' : '(audited)';
}

/** What a command needs from the transition table, as commandOptions reports it. */
export interface ActionGate {
  allowed: boolean;
  roles: readonly string[];
}

/**
 * Why an action button is disabled, or null when it is live: outside the preview every action
 * waits for Phase 3; in the preview a command the signed-in roles may not issue names the roles
 * it needs (or the page's own wording, such as "Service accounts only").
 */
export function blockedTitle(gate: ActionGate, notAllowed?: string): string | null {
  if (!previewMode) return PHASE_3_TITLE;
  if (!gate.allowed) return notAllowed ?? `Needs ${rolesLabel(gate.roles)}`;
  return null;
}

/** The transition tables ask for a reason of at least three characters (packages/contracts simulated.ts). */
export const MIN_REASON_LENGTH = 3;

export function isReason(text: string): boolean {
  return text.trim().length >= MIN_REASON_LENGTH;
}

export interface ActionEntry {
  id: number;
  tone: 'good' | 'bad';
  text: string;
}

export interface ActionLog {
  /** The latest result, shown in the page's one status region. */
  latest: ActionEntry | null;
  /** Every result this page session, newest first. */
  entries: ActionEntry[];
  record: (tone: ActionEntry['tone'], text: string) => void;
}

/** Results of the actions taken on a page, kept in memory only: they clear when the page reloads. */
export function useActionLog(): ActionLog {
  const [entries, setEntries] = useState<ActionEntry[]>([]);
  const next = useRef(1);
  const record = useCallback((tone: ActionEntry['tone'], text: string) => {
    const id = next.current;
    next.current += 1;
    setEntries((prev) => [{ id, tone, text }, ...prev]);
  }, []);
  return { latest: entries[0] ?? null, entries, record };
}
