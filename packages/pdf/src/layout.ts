/**
 * Lines from runs: runs whose baselines lie within `BASELINE_TOLERANCE` page units of the
 * line's top-most run form one line; lines are ordered top to bottom and the runs of a line left to right; a space
 * is put between two runs when the gap between them is more than a third of the font size (a
 * word break the writer expressed by positioning rather than by a space character). Undecodable
 * runs keep their place for the gaps but add no text.
 */
import type { TextRun } from './content.js';

export interface TextLine {
  /** The baseline of the line (its left-most run's y), in page units. */
  y: number;
  text: string;
}

export const BASELINE_TOLERANCE = 2;
const GAP_FRACTION = 1 / 3;

export function buildLines(runs: readonly TextRun[]): TextLine[] {
  const ordered = runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => b.run.y - a.run.y || a.index - b.index)
    .map((entry) => entry.run);
  const groups: { y: number; runs: TextRun[] }[] = [];
  for (const run of ordered) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.y - run.y) <= BASELINE_TOLERANCE) last.runs.push(run);
    else groups.push({ y: run.y, runs: [run] });
  }
  return groups.map((group) => joinRuns(group.runs));
}

/** One line from its runs: the baseline of the left-most run and the text left to right. */
function joinRuns(runs: TextRun[]): TextLine {
  const ordered = runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => a.run.x - b.run.x || a.index - b.index)
    .map((entry) => entry.run);
  let text = '';
  let previous: TextRun | null = null;
  for (const run of ordered) {
    if (previous && !run.undecodable && run.text !== '') {
      const gap = run.x - (previous.x + previous.width);
      const threshold = Math.max(previous.size, run.size) * GAP_FRACTION;
      const boundary = text.endsWith(' ') || run.text.startsWith(' ');
      if (gap > threshold && !boundary && text !== '') text += ' ';
    }
    if (!run.undecodable) text += run.text;
    previous = run;
  }
  return { y: ordered[0]?.y ?? 0, text };
}
