/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript shared by the scripts and vite.config.ts; the shapes are written as JSDoc and read by tsc */
// The site's colour and font tokens, derived from config/brand.json (docs/06): the same brand
// values and the same kind of formulas as apps/web/src/app/theme.ts, so the site and the tool are
// plainly one product. Nothing in the site's CSS, the brochures or the demo captions writes a
// colour of its own; they read these custom properties. The light set is the tool's own palette;
// the dark set is the same beach after sunset, mixed from the same three brand colours.
// @ts-check
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BRAND_FILE = resolve(here, '..', '..', '..', '..', 'config', 'brand.json');

/**
 * @typedef {{
 *   name: string,
 *   colors: {
 *     brand: { primary: string, accent: string, sand: string },
 *     ui: { bg: string, text: string, muted: string, border: string },
 *     status: { good: string, watch: string, bad: string },
 *   },
 *   fonts: { ui: string[], display: string[] },
 * }} Brand
 */

/** @returns {Brand} */
export function readBrand() {
  return JSON.parse(readFileSync(BRAND_FILE, 'utf8'));
}

/** @param {string} hex @returns {[number, number, number]} */
function rgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Mixes a colour toward another by an amount between 0 and 1. @param {string} from @param {string} to @param {number} amount */
export function mix(from, to, amount) {
  const a = rgb(from);
  const b = rgb(to);
  return `#${a
    .map((c, i) => Math.round(c + ((b[i] ?? 0) - c) * amount))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** "r, g, b", for rgba(var(--pb-x-rgb), alpha). @param {string} hex */
export function triplet(hex) {
  return rgb(hex).join(', ');
}

/** WCAG 2.x contrast ratio between two colours. @param {string} a @param {string} b */
export function contrast(a, b) {
  /** @param {string} hex */
  const luminance = (hex) => {
    const [r, g, bl] = rgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** @param {string[]} names */
function fontStack(names) {
  return names.map((n) => (/\s/.test(n) ? `"${n}"` : n)).join(', ');
}

/**
 * The two token sets. Keys become custom properties: bg > --pb-bg, accentInk > --pb-accent-ink.
 * @param {Brand} [brand]
 */
export function tokenSets(brand = readBrand()) {
  const { primary, accent, sand } = brand.colors.brand;
  const { bg, text, muted, border } = brand.colors.ui;
  const black = '#000000';

  const light = {
    bg,
    surface: mix(sand, bg, 0.6), // pale sand band
    surfaceCool: mix(primary, bg, 0.96), // cool wash
    card: bg,
    text,
    muted: mix(muted, black, 0.18), // secondary text, AA on bg and on every surface
    border,
    borderStrong: mix(border, black, 0.12),
    hairline: mix(border, bg, 0.4),
    primary, // headings, links, the primary button
    primaryHover: mix(primary, black, 0.2),
    onPrimary: bg,
    accent, // rules, focus, marks: never text
    accentInk: mix(accent, black, 0.3), // the accent as text
    accentWash: mix(accent, bg, 0.9),
    sand,
    onSand: primary, // text on the sand chip
    sandPale: mix(sand, bg, 0.5),
    sandEdge: mix(sand, black, 0.08),
    deep: primary, // the full-width dark band
    deepEnd: mix(primary, black, 0.32),
    onDeep: bg,
    onDeepMuted: mix(primary, bg, 0.8),
    deepCard: mix(primary, bg, 0.07),
    deepBorder: mix(primary, bg, 0.2),
    deepAccent: mix(accent, bg, 0.55),
    // The scene, back to front.
    sceneSkyTop: bg,
    sceneSky: mix(accent, bg, 0.86),
    sceneGlow: mix(sand, bg, 0.5),
    sceneSun: mix(sand, bg, 0.08),
    sceneSunCore: mix(sand, bg, 0.7),
    sceneSeaFar: mix(accent, bg, 0.6),
    sceneSeaNear: mix(accent, bg, 0.8),
    sceneSwellA: mix(primary, bg, 0.72),
    sceneSwellB: mix(accent, bg, 0.52),
    sceneSwellC: bg,
    sceneFoam: bg,
    sceneWash: mix(accent, bg, 0.86),
    sceneSand: mix(sand, bg, 0.35),
    sceneSandEnd: sand,
    sceneHorizon: mix(primary, bg, 0.62),
    good: mix(brand.colors.status.good, black, 0.15),
    watch: mix(brand.colors.status.watch, black, 0.25),
    shot: bg, // the frame around a screenshot
    shadow: primary, // shadows are tinted with the sea in daylight
    shotDim: '1',
  };

  const nightBg = mix(primary, black, 0.74);
  const dark = {
    bg: nightBg,
    surface: mix(primary, black, 0.62),
    surfaceCool: mix(primary, black, 0.66),
    card: mix(primary, black, 0.52),
    text: mix(sand, '#ffffff', 0.45),
    muted: mix(primary, '#ffffff', 0.64),
    border: mix(primary, black, 0.18),
    borderStrong: mix(primary, '#ffffff', 0.12),
    hairline: mix(primary, black, 0.36),
    primary: mix(accent, '#ffffff', 0.52),
    primaryHover: mix(accent, '#ffffff', 0.68),
    onPrimary: nightBg,
    accent,
    accentInk: mix(accent, '#ffffff', 0.42),
    accentWash: mix(primary, black, 0.4),
    sand: mix(sand, black, 0.12),
    onSand: nightBg,
    sandPale: mix(primary, black, 0.58),
    sandEdge: mix(primary, black, 0.2),
    deep: mix(primary, black, 0.44),
    deepEnd: mix(primary, black, 0.66),
    onDeep: mix(sand, '#ffffff', 0.45),
    onDeepMuted: mix(primary, '#ffffff', 0.68),
    deepCard: mix(primary, black, 0.3),
    deepBorder: mix(primary, black, 0.05),
    deepAccent: mix(accent, '#ffffff', 0.42),
    sceneSkyTop: mix(primary, black, 0.8),
    sceneSky: mix(primary, black, 0.42),
    sceneGlow: mix(primary, sand, 0.22),
    sceneSun: mix(sand, '#ffffff', 0.35),
    sceneSunCore: mix(sand, '#ffffff', 0.8),
    sceneSeaFar: mix(primary, black, 0.2),
    sceneSeaNear: mix(primary, black, 0.5),
    sceneSwellA: mix(primary, black, 0.36),
    sceneSwellB: mix(accent, black, 0.5),
    sceneSwellC: mix(accent, black, 0.3),
    sceneFoam: mix(sand, '#ffffff', 0.3),
    sceneWash: mix(primary, black, 0.1),
    sceneSand: mix(mix(sand, black, 0.6), primary, 0.32),
    sceneSandEnd: mix(mix(sand, black, 0.7), primary, 0.4),
    sceneHorizon: mix(accent, black, 0.2),
    good: mix(brand.colors.status.good, '#ffffff', 0.5),
    watch: mix(brand.colors.status.watch, '#ffffff', 0.45),
    shot: mix(primary, black, 0.3),
    shadow: black,
    shotDim: '0.92',
  };

  const fonts = { ui: fontStack(brand.fonts.ui), display: fontStack(brand.fonts.display) };
  return { light, dark, fonts };
}

/** bg > bg, accentInk > accent-ink, sceneSkyTop > scene-sky-top. @param {string} key */
function cssName(key) {
  return key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/** @param {Record<string, string>} set */
function declarations(set) {
  return Object.entries(set)
    .flatMap(([key, value]) => {
      const name = `--pb-${cssName(key)}`;
      return value.startsWith('#')
        ? [`${name}:${value}`, `${name}-rgb:${triplet(value)}`]
        : [`${name}:${value}`];
    })
    .join(';');
}

/**
 * The token stylesheet: light on :root, dark for a reader whose system asks for it (unless the
 * page was switched to light), and dark again when the page was switched to dark.
 * @param {Brand} [brand]
 */
export function tokensCss(brand = readBrand()) {
  const { light, dark, fonts } = tokenSets(brand);
  const base = `--pb-font-ui:${fonts.ui};--pb-font-display:${fonts.display}`;
  return [
    `:root{color-scheme:light;${base};${declarations(light)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;${declarations(dark)}}}`,
    `:root[data-theme="dark"]{color-scheme:dark;${declarations(dark)}}`,
  ].join('\n');
}

/** Only the light set, for the brochures and the demo captions (print and video are light). @param {Brand} [brand] */
export function lightTokensCss(brand = readBrand()) {
  const { light, fonts } = tokenSets(brand);
  return `:root{--pb-font-ui:${fonts.ui};--pb-font-display:${fonts.display};${declarations(light)}}`;
}
