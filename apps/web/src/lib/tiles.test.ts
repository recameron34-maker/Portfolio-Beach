import { afterEach, describe, expect, it, vi } from 'vitest';
import { balanceTiles, tileColumns } from './tiles.js';

describe('even rows of tiles', () => {
  it('keeps the fewest rows and fills them evenly', () => {
    expect(tileColumns(8, 5)).toBe(4); // 4 + 4, not 5 + 3
    expect(tileColumns(8, 6)).toBe(4); // 4 + 4, not 6 + 2
    expect(tileColumns(6, 5)).toBe(3); // 3 + 3, not 5 + 1
    expect(tileColumns(6, 4)).toBe(3); // 3 + 3, not 4 + 2
    expect(tileColumns(5, 4)).toBe(3); // 3 + 2, not 4 + 1
    expect(tileColumns(4, 3)).toBe(2); // 2 + 2, not 3 + 1
    expect(tileColumns(9, 5)).toBe(5); // 5 + 4 is already even
  });

  it('puts every tile in one row when they fit, and never asks for zero columns', () => {
    expect(tileColumns(5, 5)).toBe(5);
    expect(tileColumns(3, 7.9)).toBe(3);
    expect(tileColumns(6, 0.4)).toBe(1);
    expect(tileColumns(0, 4)).toBe(1);
  });

  it('never needs more rows than a full auto-fit grid would', () => {
    for (let cells = 1; cells <= 12; cells++) {
      for (let across = 1; across <= 8; across++) {
        const cols = tileColumns(cells, across);
        expect(cols).toBeLessThanOrEqual(across);
        expect(Math.ceil(cells / cols)).toBe(Math.ceil(cells / across));
        // Fewer empty places than rows: with two rows, the last is at most one tile short.
        expect(cols * Math.ceil(cells / cols) - cells).toBeLessThan(Math.ceil(cells / cols));
      }
    }
  });
});

describe('balanceTiles', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing without ResizeObserver, so the CSS columns stand', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const grid = document.createElement('div');
    expect(balanceTiles(grid)).toBeUndefined();
    expect(grid.style.gridTemplateColumns).toBe('');
  });

  it('sets even columns from the grid width and --pb-tile-min, and stops on cleanup', () => {
    const observed: Element[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {}
        observe(el: Element): void {
          observed.push(el);
          this.callback();
        }
        disconnect = disconnect;
      },
    );
    const grid = document.createElement('div');
    grid.style.setProperty('--pb-tile-min', '172px');
    grid.style.columnGap = '12px';
    Object.defineProperty(grid, 'clientWidth', { value: 996 });
    for (let i = 0; i < 8; i++) grid.append(document.createElement('div'));
    const cleanup = balanceTiles(grid);
    expect(observed).toEqual([grid]);
    // 996px fits five 172px tiles with 12px gaps; eight tiles go 4 + 4.
    expect(grid.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    cleanup?.();
    expect(disconnect).toHaveBeenCalled();
  });
});
