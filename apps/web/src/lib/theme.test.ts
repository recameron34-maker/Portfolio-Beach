import { describe, expect, it } from 'vitest';
import { brandRamp, contrastRatio, cssName, cssVariables, derived, tokens } from '../app/theme.js';

describe('theme tokens (docs/06)', () => {
  it('builds a 16-step ramp with the primary at step 80 and lighter steps above it', () => {
    const ramp = brandRamp(tokens.brand.primary);
    expect(Object.keys(ramp)).toHaveLength(16);
    expect(ramp[80]).toBe(tokens.brand.primary);
    expect(ramp[160]).not.toBe(ramp[10]);
    expect(ramp[10]).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('exposes every brand token as a CSS variable', () => {
    const css = cssVariables();
    expect(css).toContain(`--pb-brand-primary:${tokens.brand.primary}`);
    expect(css).toContain(`--pb-bad:${tokens.status.bad}`);
  });
});

describe('derived tokens and contrast (docs/06 addendum)', () => {
  it('derives every extra token as a six-digit hex and emits it as a CSS variable', () => {
    const css = cssVariables();
    for (const [k, v] of Object.entries(derived)) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
      expect(css).toContain(`--pb-${cssName(k)}:${v}`);
    }
    expect(css).toContain(`--pb-primary-rgb:`);
    expect(cssName('primaryTint4')).toBe('primary-tint-4');
    expect(cssName('surface2')).toBe('surface-2');
  });

  it('keeps every text pair the stylesheet uses at WCAG AA (docs/06)', () => {
    const bg = tokens.ui.bg;
    const text: [string, string][] = [
      [tokens.ui.text, bg],
      [tokens.ui.muted, bg],
      [tokens.brand.primary, bg],
      [bg, tokens.brand.primary],
      [bg, derived.primaryDeep],
      [derived.accentInk, bg],
      [derived.accentInk, derived.accentTint10],
      [derived.goodInk, derived.goodTint],
      [derived.watchInk, derived.watchTint],
      [derived.badInk, derived.badTint],
      [derived.goodInk, bg],
      [derived.watchInk, bg],
      [derived.badInk, bg],
      [tokens.brand.primary, derived.primaryTint8],
      [derived.mutedStrong, derived.primaryTint4],
      [tokens.ui.text, derived.sandPale],
      [tokens.brand.primary, derived.sandPale],
      [derived.mutedStrong, derived.sandPale],
      [tokens.brand.primary, tokens.brand.sand],
      [derived.mutedStrong, derived.surface2],
      [tokens.brand.primary, derived.sky],
      [tokens.brand.primary, derived.sea],
      [tokens.brand.primary, derived.seaDeep],
    ];
    for (const [a, b] of text)
      expect(contrastRatio(a, b), `${a} on ${b}`).toBeGreaterThanOrEqual(4.5);
    const nonText: [string, string][] = [
      [tokens.brand.accent, bg],
      [bg, tokens.brand.primary],
    ];
    for (const [a, b] of nonText) expect(contrastRatio(a, b)).toBeGreaterThanOrEqual(3);
  });

  it('documents the pairs the stylesheet forbids', () => {
    expect(contrastRatio(tokens.brand.accent, tokens.ui.bg)).toBeLessThan(4.5); // accent is never text
    expect(contrastRatio(tokens.status.watch, tokens.ui.bg)).toBeLessThan(4.5); // raw watch is never text
    expect(contrastRatio(tokens.ui.muted, tokens.brand.sand)).toBeLessThan(4.5); // muted never on sand
  });
});
