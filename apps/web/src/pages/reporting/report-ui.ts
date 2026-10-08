import type { Tone } from '../../components/ui.js';

/** Direction of a fair value change as a word and a tone; null when the change is not calculable. */
export function changeBadge(changePct: string | null): { tone: Tone; word: string } | null {
  if (changePct === null) return null;
  const n = Number(changePct);
  if (!Number.isFinite(n)) return null;
  if (n > 0) return { tone: 'good', word: 'Up' };
  if (n < 0) return { tone: 'bad', word: 'Down' };
  return { tone: 'neutral', word: 'Flat' };
}
