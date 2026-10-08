import type { Tone } from '../../components/ui.js';
import { formatDate, MISSING } from '../../lib/format.js';

/** "TicketDrafted" -> "Ticket drafted" for workflow state codes (docs/18). */
export function humanizeState(state: string): string {
  const spaced = state.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0) + spaced.slice(1).toLowerCase();
}

/** Capital notice states (docs/18 section 3): settled states read as good, an approved ticket as brand, the rest as watch. */
export function noticeTone(state: string): Tone {
  if (state === 'Funded' || state === 'Reconciled') return 'good';
  if (state === 'TicketApproved') return 'brand';
  return 'watch';
}

/** Direction of a fair value change as a word and a tone; null when the change is not calculable. */
export function changeBadge(changePct: string | null): { tone: Tone; word: string } | null {
  if (changePct === null) return null;
  const n = Number(changePct);
  if (!Number.isFinite(n)) return null;
  if (n > 0) return { tone: 'good', word: 'Up' };
  if (n < 0) return { tone: 'bad', word: 'Down' };
  return { tone: 'neutral', word: 'Flat' };
}

/** Table cell class for a formatted number: right aligned, muted when it shows the missing placeholder or NM. */
export function numClass(value: string): string {
  return value === MISSING || value === 'NM' ? 'num is-missing' : 'num';
}

/** "2025-06-30T12:00:00.000Z" -> "Jun 30, 2025 12:00:00 UTC" through the date formatter; the raw text when not ISO. */
export function formatDateTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  if (m === null) return iso;
  return `${formatDate(m[1] ?? '')} ${m[2] ?? ''} UTC`;
}
