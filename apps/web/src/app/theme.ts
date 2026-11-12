import { createLightTheme } from '@fluentui/react-components';
import type { BrandVariants, Theme } from '@fluentui/react-components';
import brand from '../../../../config/brand.json';

/** Tokens come from config/brand.json (docs/06). Nothing in the UI hard-codes a color. */
export const tokens = brand.colors;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mix(hex: string, towards: [number, number, number], amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const ch = (c: number, t: number) => Math.round(c + (t - c) * amount);
  return `#${[ch(r, towards[0]), ch(g, towards[1]), ch(b, towards[2])].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** A 16-step brand ramp around the primary color, darker at 10 and lighter at 160, as Fluent expects. */
export function brandRamp(primary: string): BrandVariants {
  const steps = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160] as const;
  const ramp = {} as Record<(typeof steps)[number], string>;
  for (const step of steps) {
    // 80 is the primary itself; below mixes toward black, above toward white.
    const t = (step - 80) / 80;
    ramp[step] =
      t === 0
        ? primary
        : t < 0
          ? mix(primary, [0, 0, 0], -t * 0.85)
          : mix(primary, [255, 255, 255], t * 0.92);
  }
  return ramp;
}

const WHITE = hexToRgb(tokens.ui.bg); // tints move toward ui.bg, never toward a literal white
const BLACK: [number, number, number] = [0, 0, 0];

/** Mix toward the page background. */
export function tint(hex: string, amount: number): string {
  return mix(hex, WHITE, amount);
}
/** Mix toward black. */
export function shade(hex: string, amount: number): string {
  return mix(hex, BLACK, amount);
}
/** "r, g, b" so styles.css can write rgba(var(--pb-x-rgb), a) and still derive from brand.json. */
export function rgbTriplet(hex: string): string {
  return hexToRgb(hex).join(', ');
}

/**
 * Derived tokens (docs/06 addendum): every value is a formula over config/brand.json.
 * The hex comments are what the formulas produce today, for review only; the formulas govern.
 */
export const derived = {
  primaryDeep: shade(tokens.brand.primary, 0.2), // #0c3d4a  header bottom rule, header controls
  primaryTint4: tint(tokens.brand.primary, 0.96), // #f5f8f8  row and nav hover, notice wash
  primaryTint8: tint(tokens.brand.primary, 0.92), // #ecf1f2  active nav, selected row, key chip, brand badge
  primaryTint12: tint(tokens.brand.primary, 0.88), // #e2eaeb  pressed states
  accentTint10: tint(tokens.brand.accent, 0.9), // #eaf5f4  accent badge background
  accentInk: shade(tokens.brand.accent, 0.3), // #1d6e64  the only accent used as text (6.06:1 on bg)
  sandPale: tint(tokens.brand.sand, 0.5), // #faf5ec  prototype banner, tinted cards, sign-in sand
  sandEdge: shade(tokens.brand.sand, 0.08), // #e0d8c8  rules on sand
  sky: tint(tokens.brand.accent, 0.86), // #e1f1ef  sign-in sky and shallow water
  sea: tint(tokens.brand.accent, 0.72), // #c3e4e0  sign-in sea band
  seaDeep: tint(tokens.brand.primary, 0.78), // #cad8db  far swell fill
  surface2: tint(tokens.ui.text, 0.97), // #f8f8f9  empty-state and disabled fills, never the page
  hairline: tint(tokens.ui.border, 0.4), // #eff1f3  rules inside tables and lists
  borderStrong: shade(tokens.ui.border, 0.12), // #cacbcf  hovered input borders
  mutedStrong: shade(tokens.ui.muted, 0.18), // #585d69  secondary text on any tinted surface
  goodInk: shade(tokens.status.good, 0.15), // #276a2b  good as text
  goodTint: tint(tokens.status.good, 0.92), // #eef5ef
  watchInk: shade(tokens.status.watch, 0.25), // #895b17  watch as text (raw watch is 3.64:1)
  watchTint: tint(tokens.status.watch, 0.92), // #f9f4ed
  badInk: shade(tokens.status.bad, 0.1), // #b22424  bad as text
  badTint: tint(tokens.status.bad, 0.92), // #faeeee
} as const;

/** primaryTint4 -> primary-tint-4, surface2 -> surface-2, goodInk -> good-ink. */
export function cssName(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase();
}

/** WCAG 2.x relative luminance contrast ratio between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, b2] = hexToRgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function createTheme(): Theme {
  const base = createLightTheme(brandRamp(tokens.brand.primary));
  const p = rgbTriplet(tokens.brand.primary);
  const t = rgbTriplet(tokens.ui.text);
  return {
    ...base,
    colorNeutralForeground1: tokens.ui.text,
    colorNeutralForeground2: derived.mutedStrong,
    colorNeutralForeground3: tokens.ui.muted,
    colorNeutralStroke1: tokens.ui.border,
    colorNeutralStroke1Hover: derived.borderStrong,
    colorNeutralStroke2: derived.hairline,
    colorNeutralBackground1: tokens.ui.bg,
    colorNeutralBackground1Hover: derived.primaryTint4,
    colorNeutralBackground2: derived.surface2,
    colorNeutralBackground3: derived.surface2,
    colorSubtleBackgroundHover: derived.primaryTint4,
    colorBrandForegroundLink: tokens.brand.primary,
    colorCompoundBrandStroke: tokens.brand.accent, // input and dropdown focus underline (non-text, 3.32:1)
    colorCompoundBrandStrokeHover: tokens.brand.accent,
    colorStrokeFocus2: tokens.brand.accent, // focus ring on light surfaces; the header overrides it to bg
    borderRadiusSmall: '4px',
    borderRadiusMedium: '6px',
    borderRadiusLarge: '8px',
    borderRadiusXLarge: '10px',
    shadow2: `0 1px 2px rgba(${t}, 0.06)`,
    shadow4: `0 1px 2px rgba(${t}, 0.06), 0 2px 6px rgba(${p}, 0.08)`,
    shadow8: `0 2px 6px rgba(${t}, 0.06), 0 6px 16px -8px rgba(${p}, 0.16)`,
    shadow16: `0 12px 32px -12px rgba(${p}, 0.28), 0 2px 6px rgba(${t}, 0.06)`,
    fontFamilyBase: brand.fonts.ui.join(', '),
    fontFamilyNumeric: brand.fonts.ui.join(', '),
  };
}

/** CSS custom properties so feature-scoped styles can use the same tokens. */
export function cssVariables(): string {
  const chart = tokens.chartSeries.map((c, i) => `--pb-chart-${i + 1}:${c};`).join('');
  const base = `--pb-chart-muted:${tokens.chartMuted};--pb-brand-primary:${tokens.brand.primary};--pb-brand-accent:${tokens.brand.accent};--pb-brand-sand:${tokens.brand.sand};--pb-bg:${tokens.ui.bg};--pb-text:${tokens.ui.text};--pb-muted:${tokens.ui.muted};--pb-border:${tokens.ui.border};--pb-good:${tokens.status.good};--pb-watch:${tokens.status.watch};--pb-bad:${tokens.status.bad};--pb-font-ui:${brand.fonts.ui.join(', ')};--pb-font-display:${brand.fonts.display.join(', ')};`;
  const extra = Object.entries(derived)
    .map(([k, v]) => `--pb-${cssName(k)}:${v};`)
    .join('');
  const rgb: [string, string][] = [
    ['primary', tokens.brand.primary],
    ['accent', tokens.brand.accent],
    ['sand', tokens.brand.sand],
    ['bg', tokens.ui.bg],
    ['text', tokens.ui.text],
    ['good', tokens.status.good],
    ['watch', tokens.status.watch],
    ['bad', tokens.status.bad],
  ];
  const triplets = rgb.map(([k, v]) => `--pb-${k}-rgb:${rgbTriplet(v)};`).join('');
  return `:root{${chart}${base}${extra}${triplets}}`;
}
