import { describe, expect, it } from 'vitest';
import {
  radarAnchor,
  radarLayout,
  radarPoint,
  radarRing,
  radarRingLabel,
  radarShape,
} from './radar.js';

const round = (n: number): number => Math.round(n * 1000) / 1000;

describe('radar geometry', () => {
  it('starts at the top and goes round clockwise', () => {
    const at = (i: number, value: number) => {
      const p = radarPoint(i, 4, value, 100, 200, 150);
      return [round(p.x), round(p.y)];
    };
    expect(at(0, 100)).toEqual([200, 50]);
    expect(at(1, 100)).toEqual([300, 150]);
    expect(at(2, 100)).toEqual([200, 250]);
    expect(at(3, 100)).toEqual([100, 150]);
    // Half the score is half way out; nothing is the centre; a value past its ends is held.
    expect(at(1, 50)).toEqual([250, 150]);
    expect(at(2, 0)).toEqual([200, 150]);
    expect(at(1, 140)).toEqual([300, 150]);
    expect(at(1, -5)).toEqual([200, 150]);
  });

  it('draws a ring as a closed outline through every axis', () => {
    expect(radarRing(4, 0.5, 100, 200, 150)).toBe('200,100 250,150 200,200 150,150');
    expect(radarRing(3, 1, 10, 0, 0).split(' ')).toHaveLength(3);
  });

  it('writes the figure of a ring beside the top spoke, half way to the last one', () => {
    // Four spokes: the top is (200, 50), the last is (100, 150); the full ring's label is between.
    expect(radarRingLabel(4, 1, 100, 200, 150)).toEqual({ x: 150, y: 100 });
    expect(radarRingLabel(4, 0.5, 100, 200, 150)).toEqual({ x: 175, y: 125 });
  });

  it('closes the shape when every measure has a score', () => {
    const axes = [
      { key: 'a', value: 100 },
      { key: 'b', value: 50 },
      { key: 'c', value: 50 },
      { key: 'd', value: 100 },
    ];
    const shape = radarShape(axes, 100, 200, 150);
    expect(shape.points.map((p) => p.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(shape.outline).toBe('M200,50L250,150L200,200L100,150Z');
    expect(shape.area).toBe(shape.outline);
  });

  it('leaves a gap at a measure with no score, never a zero and never a line across it', () => {
    const axes = [
      { key: 'a', value: 100 },
      { key: 'b', value: null },
      { key: 'c', value: 50 },
      { key: 'd', value: 100 },
    ];
    const shape = radarShape(axes, 100, 200, 150);
    expect(shape.points.map((p) => p.key)).toEqual(['a', 'c', 'd']);
    // One run of neighbours, c to d to a (it passes the top): a line, and a wedge from the centre.
    expect(shape.outline).toBe('M200,200L100,150L200,50');
    expect(shape.area).toBe('M200,150L200,200L100,150L200,50Z');
  });

  it('draws each run of neighbours on its own, and nothing for a score with no neighbour', () => {
    const six = (values: (number | null)[]) =>
      radarShape(
        values.map((value, i) => ({ key: String(i), value })),
        100,
        0,
        0,
      );
    const two = six([100, 100, null, 100, 100, null]);
    expect(two.outline.match(/M/g)).toHaveLength(2);
    expect(two.area.match(/Z/g)).toHaveLength(2);
    const lone = six([100, null, 100, null, null, null]);
    expect(lone.points).toHaveLength(2);
    expect(lone.outline).toBe('');
    expect(lone.area).toBe('');
    expect(six([null, null, null, null, null, null])).toEqual({
      points: [],
      outline: '',
      area: '',
    });
    expect(radarShape([], 100, 0, 0)).toEqual({ points: [], outline: '', area: '' });
  });

  it('sets a label on the side of the chart it sits on', () => {
    expect([0, 1, 2, 3].map((i) => radarAnchor(i, 4))).toEqual([
      'middle',
      'start',
      'middle',
      'end',
    ]);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => radarAnchor(i, 7))).toEqual([
      'middle',
      'start',
      'start',
      'start',
      'end',
      'end',
      'end',
    ]);
  });

  it('fits the chart to the room it has, and never past its largest size', () => {
    const wide = radarLayout(900);
    expect(wide.radius).toBe(180);
    expect(wide.cx).toBe(450);
    expect(wide.height).toBe(wide.cy * 2);
    const narrow = radarLayout(320);
    expect(narrow.radius).toBeLessThan(wide.radius);
    expect(narrow.radius).toBeGreaterThanOrEqual(48);
    // The labels keep their room on both sides at any width.
    expect(narrow.cx - narrow.radius).toBeGreaterThanOrEqual(80);
    expect(radarLayout(120).radius).toBe(48);
  });
});
