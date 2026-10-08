/*
 * Even rows of stat tiles. An auto-fit grid puts as many tiles in a row as fit, so eight tiles read
 * 5 + 3 and six read 5 + 1. balanceTiles keeps the same number of rows but spreads the tiles evenly
 * across them (4 + 4, 3 + 3). The narrowest a tile may get comes from --pb-tile-min in the CSS, so the
 * stylesheet still decides the breakpoints; this only picks among column counts that fit.
 */

/** Columns for `cells` tiles when at most `across` fit in a row: the fewest rows, filled evenly. */
export function tileColumns(cells: number, across: number): number {
  if (cells <= 0) return 1;
  const fit = Math.max(1, Math.floor(across));
  if (cells <= fit) return cells;
  return Math.ceil(cells / Math.ceil(cells / fit));
}

/**
 * Ref for a .pb-tiles grid: sets its columns from tileColumns whenever its width or its tiles
 * change. A wide tile (StatTile wide) counts as two cells, so grids with one keep their own CSS
 * columns instead (Home). Without ResizeObserver (jsdom) the CSS auto-fit columns stand.
 */
export function balanceTiles(grid: HTMLElement | null): (() => void) | undefined {
  if (grid === null || typeof ResizeObserver === 'undefined') return undefined;
  const fit = (): void => {
    const style = getComputedStyle(grid);
    const min = Number.parseFloat(style.getPropertyValue('--pb-tile-min'));
    const gap = Number.parseFloat(style.columnGap) || 0;
    if (!Number.isFinite(min) || min <= 0) return;
    const cells = [...grid.children].reduce(
      (n, tile) => n + (tile.classList.contains('is-wide') ? 2 : 1),
      0,
    );
    const across = (grid.clientWidth + gap) / (min + gap);
    grid.style.gridTemplateColumns = `repeat(${tileColumns(cells, across)}, minmax(0, 1fr))`;
  };
  const resized = new ResizeObserver(fit);
  const changed = new MutationObserver(fit);
  resized.observe(grid);
  changed.observe(grid, { childList: true });
  return () => {
    resized.disconnect();
    changed.disconnect();
  };
}
