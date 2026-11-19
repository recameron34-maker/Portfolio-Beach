/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript run by node with no build; the shapes are written as JSDoc */
/**
 * The world's outline for the co-investment map (decision 0017), from the TopoJSON of the
 * `world-atlas` package (Natural Earth 1:110m, public domain). Read once by
 * scripts/build-world-map.mjs; the app ships the small file that script writes and never this
 * package. Two things are kept: the coastlines (the land's rings) and the borders two countries
 * share. Antarctica is left off: no company is there and it would take a fifth of the frame.
 *
 * Each line is written as text: longitude and latitude in hundredths of a degree, the first
 * point as it is and every later one as the step from the point before, separated by commas.
 * Commas, not spaces: a bundler may join the lines with a dot, and three numbers set apart by
 * dots and spaces can read as a telephone number to the repository's data guard.
 */

/** @typedef {{ scale: [number, number], translate: [number, number] }} Transform */
/** @typedef {{ type: string, arcs: any, id?: string }} Geometry */
/** @typedef {{ arcs: number[][][], transform: Transform, objects: Record<string, { geometries: Geometry[] }> }} Topology */

const SOUTH_LIMIT = -60;

/**
 * The arcs as longitude and latitude: TopoJSON stores each as steps on an integer grid.
 * @param {Topology} topology
 * @returns {[number, number][][]}
 */
function decodeArcs(topology) {
  const [sx, sy] = topology.transform.scale;
  const [tx, ty] = topology.transform.translate;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return /** @type {[number, number]} */ ([x * sx + tx, y * sy + ty]);
    });
  });
}

/** The index of the arc a ring names; a negative one means the arc walked backwards. */
const arcOf = (index) => (index >= 0 ? index : ~index);

/**
 * @param {Geometry} geometry
 * @returns {number[][]} its rings, each a list of arc indexes
 */
function ringsOf(geometry) {
  if (geometry.type === 'Polygon') return geometry.arcs;
  if (geometry.type === 'MultiPolygon') return geometry.arcs.flat();
  return [];
}

/**
 * @param {number[]} ring
 * @param {[number, number][][]} arcs
 * @returns {[number, number][]} the ring's points, each arc joined to the next at their shared end
 */
function stitch(ring, arcs) {
  const points = [];
  for (const index of ring) {
    const arc = arcs[arcOf(index)];
    const walked = index >= 0 ? arc : [...arc].reverse();
    points.push(...(points.length === 0 ? walked : walked.slice(1)));
  }
  return points;
}

/**
 * @param {[number, number][]} points
 * @returns {string}
 */
function encode(points) {
  const out = [];
  let px = 0;
  let py = 0;
  for (const [lon, lat] of points) {
    const x = Math.round(lon * 100);
    const y = Math.round(lat * 100);
    // A step of nothing adds nothing to a line.
    if (out.length > 0 && x === px && y === py) continue;
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out.join(',');
}

const north = (points) => points.some(([, lat]) => lat > SOUTH_LIMIT);

/** A line needs two different points; rounding can leave a short piece with one. */
const drawable = (text) => text.split(',').length >= 4;

/**
 * A line that steps across the 180th meridian would be drawn straight across the whole map, so it
 * is cut there into pieces that each stay on one side.
 * @param {[number, number][]} points
 * @returns {[number, number][][]} every piece, a single point included
 */
function cutAtDateLine(points) {
  const pieces = [[]];
  for (const point of points) {
    const piece = pieces[pieces.length - 1];
    const last = piece[piece.length - 1];
    if (last !== undefined && Math.abs(point[0] - last[0]) > 180) pieces.push([point]);
    else piece.push(point);
  }
  return pieces;
}

const twoOrMore = (piece) => piece.length > 1;

/**
 * An open line (a border), cut at the date line.
 * @param {[number, number][]} line
 */
const splitLine = (line) => cutAtDateLine(line).filter(twoOrMore);

/**
 * A coastline is a closed ring, and where it starts is arbitrary. Cut at the date line, its last
 * piece and its first are one stretch of coast on the same side, so they are joined again: left
 * apart, closing each would draw a line from the date line back to wherever the ring began.
 * @param {[number, number][]} ring
 * @returns {[number, number][][]}
 */
function splitRing(ring) {
  const pieces = cutAtDateLine(ring);
  if (pieces.length < 2) return pieces.filter(twoOrMore);
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  return [[...last, ...first.slice(1)], ...pieces.slice(1, -1)].filter(twoOrMore);
}

/**
 * @param {Topology} topology the countries file of world-atlas
 * @returns {{ source: string, land: string[], borders: string[] }}
 */
export function buildWorld(topology) {
  const arcs = decodeArcs(topology);
  const land = topology.objects.land.geometries
    .flatMap(ringsOf)
    .map((ring) => stitch(ring, arcs))
    .filter(north)
    .flatMap(splitRing)
    .map(encode)
    .filter(drawable);

  // A border is an arc two countries' rings both walk; a coast is walked by one.
  const uses = new Map();
  for (const country of topology.objects.countries.geometries)
    for (const ring of ringsOf(country))
      for (const index of ring) uses.set(arcOf(index), (uses.get(arcOf(index)) ?? 0) + 1);
  const borders = [...uses]
    .filter(([, count]) => count > 1)
    .map(([index]) => index)
    .sort((a, b) => a - b)
    .map((index) => arcs[index])
    .filter(north)
    .flatMap(splitLine)
    .map(encode)
    .filter(drawable);

  return {
    source: 'world-atlas 2.0.2, countries-110m (Natural Earth 1:110m, public domain)',
    land,
    borders,
  };
}
