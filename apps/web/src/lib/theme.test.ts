import { describe, expect, it } from 'vitest';
import { brandRamp, cssVariables, tokens } from '../app/theme.js';

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
