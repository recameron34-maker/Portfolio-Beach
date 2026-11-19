import { describe, expect, it } from 'vitest';
import { MAP_HEIGHT, MAP_WIDTH, equalEarth, project } from './projection.js';

describe('the Equal Earth projection', () => {
  it('matches the published values of the projection', () => {
    // Savric, Patterson and Jenny (2018): the pole sits at y = 1.31736..., the edge of the
    // equator at x = 2.70663...
    expect(equalEarth(0, 0)).toEqual([0, 0]);
    expect(equalEarth(0, 90)[1]).toBeCloseTo(1.3173627591574, 9);
    expect(equalEarth(180, 0)[0]).toBeCloseTo(2.706629983696, 9);
    // Equal area means the pole is a line, not a point.
    expect(equalEarth(180, 90)[0]).toBeGreaterThan(1);
  });

  it('is symmetric left to right and top to bottom', () => {
    const [x, y] = equalEarth(37.5, 52.25);
    expect(equalEarth(-37.5, 52.25)).toEqual([-x, y]);
    expect(equalEarth(37.5, -52.25)).toEqual([x, -y]);
  });

  it('frames the map from the far north to 60 south, the full width of the globe', () => {
    expect(MAP_WIDTH).toBe(1000);
    expect(project(0, 0).x).toBeCloseTo(500, 9);
    expect(project(-180, 0).x).toBeCloseTo(0, 9);
    expect(project(180, 0).x).toBeCloseTo(1000, 9);
    expect(project(0, 84).y).toBeCloseTo(0, 9);
    expect(project(0, -60).y).toBeCloseTo(MAP_HEIGHT, 9);
    expect(MAP_HEIGHT).toBeGreaterThan(380);
    expect(MAP_HEIGHT).toBeLessThan(460);
  });

  it('puts places where a reader expects them', () => {
    const newYork = project(-74.006, 40.7128);
    const london = project(-0.1278, 51.5074);
    const miami = project(-80.1918, 25.7617);
    const sydney = project(151.2093, -33.8688);
    expect(newYork.x).toBeLessThan(london.x);
    expect(london.y).toBeLessThan(newYork.y);
    expect(newYork.y).toBeLessThan(miami.y);
    expect(sydney.x).toBeGreaterThan(london.x);
    expect(sydney.y).toBeGreaterThan(miami.y);
  });
});
