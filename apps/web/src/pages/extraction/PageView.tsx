import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PageLayout } from '@pb/contracts';
import { estimateWidth } from './extraction.js';

/** Padding around a highlighted run, in page units. */
const PAD = 2;
/** How far above the baseline a run's glyphs reach, as a share of the font size. */
const ASCENT = 0.78;
/** How far below the baseline, as a share of the font size. */
const DESCENT = 0.24;

/**
 * A page of the document drawn from its text runs: each run at its x and its baseline y (the
 * PDF's origin is the bottom left, so y is flipped), at its own font size, on a page-sized sheet.
 * The runs that carry the quote under review sit on an accent-tinted rectangle. Widths come from
 * the browser's own measurement of each run once drawn; before that (and in a test runner) an
 * estimate of half an em per character stands in.
 */
export function PageView({
  page,
  highlight,
  label,
}: {
  page: PageLayout;
  /** Indices into page.runs of the runs that carry the quote. */
  highlight: readonly number[];
  /** The accessible name of the drawing, for example "Page 2 of the report". */
  label: string;
}): ReactNode {
  const svg = useRef<SVGSVGElement | null>(null);
  const [widths, setWidths] = useState<{ key: string; values: number[] }>({ key: '', values: [] });
  const key = `${page.number}:${page.runs.length}`;
  useLayoutEffect(() => {
    const root = svg.current;
    if (root === null) return;
    const measured: number[] = [];
    for (const text of root.querySelectorAll<SVGTextElement>('text[data-run]')) {
      const index = Number(text.dataset.run);
      // jsdom draws nothing, so the method is missing there; the estimate then stands.
      if (typeof text.getComputedTextLength !== 'function') return;
      measured[index] = text.getComputedTextLength();
    }
    setWidths({ key, values: measured });
  }, [key]);
  const widthOf = (index: number): number => {
    const run = page.runs[index];
    if (run === undefined) return 0;
    const measured = widths.key === key ? widths.values[index] : undefined;
    return measured !== undefined && measured > 0 ? measured : estimateWidth(run.text, run.size);
  };
  const marked = new Set(highlight);
  return (
    <svg
      ref={svg}
      className="pb-extraction-page"
      viewBox={`0 0 ${page.width} ${page.height}`}
      role="img"
      aria-label={label}
      data-testid="run-page-drawing"
      data-page={page.number}
    >
      <rect
        className="pb-extraction-page-sheet"
        x="0.5"
        y="0.5"
        width={page.width - 1}
        height={page.height - 1}
      />
      {page.runs.map((run, index) =>
        marked.has(index) ? (
          <rect
            key={`h-${index}`}
            className="pb-extraction-highlight"
            data-testid="run-page-highlight"
            x={run.x - PAD}
            y={page.height - run.y - run.size * ASCENT - PAD}
            width={widthOf(index) + PAD * 2}
            height={run.size * (ASCENT + DESCENT) + PAD * 2}
            rx={2}
          />
        ) : null,
      )}
      {page.runs.map((run, index) => (
        <text
          key={`t-${index}`}
          data-run={index}
          x={run.x}
          y={page.height - run.y}
          fontSize={run.size}
          {...(marked.has(index) ? { fontWeight: 600 } : {})}
        >
          {run.text}
        </text>
      ))}
    </svg>
  );
}
