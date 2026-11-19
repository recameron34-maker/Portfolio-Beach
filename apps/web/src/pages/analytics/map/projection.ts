/**
 * The Equal Earth projection (Savric, Patterson and Jenny, 2018) for the co-investment map: equal
 * area, so no part of the world is flattered, and gentle to look at. Written out here in a dozen
 * lines because the app carries no mapping library (decision 0017).
 */

const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;
const RADIANS = Math.PI / 180;

/** Longitude and latitude in degrees to the projection's own plane: x within 2.7066, y within 1.3174. */
export function equalEarth(longitude: number, latitude: number): [number, number] {
  const theta = Math.asin(M * Math.sin(latitude * RADIANS));
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  const x =
    (longitude * RADIANS * Math.cos(theta)) /
    (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
  const y = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  // A zero that comes out negative is still zero.
  return [x === 0 ? 0 : x, y === 0 ? 0 : y];
}

/** The frame: the whole width of the globe, from the northern edge of the land to 60 south. */
export const MAP_WIDTH = 1000;
const NORTH = 84;
const SOUTH = -60;

const X_EDGE = equalEarth(180, 0)[0];
const Y_TOP = equalEarth(0, NORTH)[1];
const Y_BOTTOM = equalEarth(0, SOUTH)[1];
const SCALE = MAP_WIDTH / (2 * X_EDGE);

export const MAP_HEIGHT = (Y_TOP - Y_BOTTOM) * SCALE;

/** A place on the map's frame, in its units: x from 0 to MAP_WIDTH, y from 0 down to MAP_HEIGHT. */
export function project(longitude: number, latitude: number): { x: number; y: number } {
  const [x, y] = equalEarth(longitude, latitude);
  return { x: (x + X_EDGE) * SCALE, y: (Y_TOP - y) * SCALE };
}
