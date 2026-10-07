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

export function createTheme(): Theme {
  const base = createLightTheme(brandRamp(tokens.brand.primary));
  return {
    ...base,
    colorNeutralForeground1: tokens.ui.text,
    colorNeutralForeground3: tokens.ui.muted,
    colorNeutralStroke1: tokens.ui.border,
    colorNeutralBackground1: tokens.ui.bg,
    fontFamilyBase: brand.fonts.ui.join(', '),
  };
}

/** CSS custom properties so feature-scoped styles can use the same tokens. */
export function cssVariables(): string {
  const chart = tokens.chartSeries.map((c, i) => `--pb-chart-${i + 1}:${c};`).join('');
  return `:root{${chart}--pb-chart-muted:${tokens.chartMuted};--pb-brand-primary:${tokens.brand.primary};--pb-brand-accent:${tokens.brand.accent};--pb-brand-sand:${tokens.brand.sand};--pb-bg:${tokens.ui.bg};--pb-text:${tokens.ui.text};--pb-muted:${tokens.ui.muted};--pb-border:${tokens.ui.border};--pb-good:${tokens.status.good};--pb-watch:${tokens.status.watch};--pb-bad:${tokens.status.bad};--pb-font-ui:${brand.fonts.ui.join(', ')};--pb-font-display:${brand.fonts.display.join(', ')};}`;
}
