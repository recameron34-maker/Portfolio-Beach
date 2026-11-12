import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildWorld } from '../../../../scripts/lib/world.mjs';
import generated from './world.generated.json';
import { decodeLine, worldLines, worldPaths } from './world.js';

const require = createRequire(import.meta.url);

/** Whether a point is inside any of the closed lines (even-odd, ray to the east). */
function onLand(lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of worldLines().land) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
  }
  return inside;
}

describe('the world outline', () => {
  it('is the file the script writes from the source package, to the byte', () => {
    const topology = JSON.parse(
      readFileSync(require.resolve('world-atlas/countries-110m.json'), 'utf8'),
    );
    expect(buildWorld(topology)).toEqual(generated);
  });

  it('decodes a line from its first point and the steps after it', () => {
    expect(decodeLine('100,200,5,-5,-10,0')).toEqual([
      [1, 2],
      [1.05, 1.95],
      [0.95, 1.95],
    ]);
    expect(decodeLine('')).toEqual([]);
  });

  it('stays on the globe, north of 60 south, and never steps across the date line', () => {
    const { land, borders } = worldLines();
    expect(land.length).toBeGreaterThan(100);
    expect(borders.length).toBeGreaterThan(300);
    for (const line of [...land, ...borders]) {
      expect(line.length).toBeGreaterThan(1);
      for (let i = 0; i < line.length; i += 1) {
        const [lon, lat] = line[i]!;
        expect(Math.abs(lon)).toBeLessThanOrEqual(180);
        expect(lat).toBeLessThanOrEqual(84);
        expect(lat).toBeGreaterThanOrEqual(-90);
        if (i > 0) expect(Math.abs(lon - line[i - 1]![0])).toBeLessThanOrEqual(180);
      }
    }
  });

  it('closes each coastline with a short step, never a line across the map', () => {
    // A ring cut at the date line and closed where it was cut runs along that line; one closed
    // back to an arbitrary start would cross a continent.
    for (const ring of worldLines().land) {
      const [startLon, startLat] = ring[0]!;
      const [endLon, endLat] = ring[ring.length - 1]!;
      const alongDateLine = Math.abs(startLon) > 170 && Math.abs(endLon) > 170;
      const gap = Math.hypot(startLon - endLon, startLat - endLat);
      expect(alongDateLine || gap < 2, `${startLon},${startLat} to ${endLon},${endLat}`).toBe(true);
    }
  });

  it('has land where the cities are and sea where the oceans are', () => {
    for (const [name, lon, lat] of [
      ['Denver', -104.9903, 39.7392],
      ['Chicago', -87.6298, 41.8781],
      ['Madrid', -3.7038, 40.4168],
      ['Munich', 11.582, 48.1351],
      ['Warsaw', 21.0122, 52.2297],
      ['Bengaluru', 77.5946, 12.9716],
    ] as const)
      expect(onLand(lon, lat), name).toBe(true);
    for (const [name, lon, lat] of [
      ['mid Atlantic', -35, 30],
      ['mid Pacific', -150, 10],
      ['Indian Ocean', 80, -25],
    ] as const)
      expect(onLand(lon, lat), name).toBe(false);
  });

  it('draws as two paths inside the frame', () => {
    const { land, borders } = worldPaths();
    expect(land.startsWith('M')).toBe(true);
    expect(land.endsWith('Z')).toBe(true);
    expect(borders.startsWith('M')).toBe(true);
    expect(borders.includes('Z')).toBe(false);
    // One decimal is all a 1000-unit frame needs; no exponent, no NaN.
    expect(land).toMatch(/^[MLZ0-9. -]+$/);
    expect(borders).toMatch(/^[ML0-9. -]+$/);
    expect(worldPaths()).toBe(worldPaths());
  });
});
