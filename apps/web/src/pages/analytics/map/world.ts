/**
 * The world's outline as the map draws it: the generated file (scripts/build-world-map.mjs) read
 * back into lines, then into two SVG paths in the map's frame. Both are worked out once.
 */
import generated from './world.generated.json';
import { project } from './projection.js';

export type Line = [longitude: number, latitude: number][];

/** One line of the file: the first point as it is, then steps, all in hundredths of a degree. */
export function decodeLine(text: string): Line {
  if (text === '') return [];
  const numbers = text.split(',').map(Number);
  const line: Line = [];
  let lon = 0;
  let lat = 0;
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    lon += numbers[i] ?? 0;
    lat += numbers[i + 1] ?? 0;
    line.push([lon / 100, lat / 100]);
  }
  return line;
}

let lines: { land: Line[]; borders: Line[] } | undefined;

/** Coastlines (closed) and the borders two countries share (open), in degrees. */
export function worldLines(): { land: Line[]; borders: Line[] } {
  lines ??= {
    land: generated.land.map(decodeLine),
    borders: generated.borders.map(decodeLine),
  };
  return lines;
}

const tenth = (value: number): string => String(Math.round(value * 10) / 10);

function pathOf(line: Line, closed: boolean): string {
  const points = line.map(([lon, lat]) => {
    const { x, y } = project(lon, lat);
    return `${tenth(x)} ${tenth(y)}`;
  });
  return `M${points.join('L')}${closed ? 'Z' : ''}`;
}

let paths: { land: string; borders: string } | undefined;

/** The land as one closed path and the borders as one open path, in the map's frame. */
export function worldPaths(): { land: string; borders: string } {
  paths ??= {
    land: worldLines()
      .land.map((line) => pathOf(line, true))
      .join(''),
    borders: worldLines()
      .borders.map((line) => pathOf(line, false))
      .join(''),
  };
  return paths;
}

/** Where the outline comes from, for the credit line under the map. */
export const WORLD_SOURCE: string = generated.source;
