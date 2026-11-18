import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { DialogProps } from '@fluentui/react-components';
import { act, renderHook } from '@testing-library/react';
import type { AnimationEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EASE,
  MOTION,
  REDUCED_MOTION_QUERY,
  dialogSurfaceMotion,
  useJustChanged,
  useReducedMotion,
} from './motion.js';

/** The web app's src folder, whether the tests run from the repository root or from apps/web. */
const SRC = [resolve('apps/web/src'), resolve('src')].find((dir) =>
  existsSync(join(dir, 'styles.css')),
);
if (SRC === undefined)
  throw new Error('the web source folder was not found from the working directory');
const STYLES = readFileSync(join(SRC, 'styles.css'), 'utf8');

/** The value of a custom property declared in the stylesheet's first :root block. */
function rootValue(name: string): string {
  const root = /:root\s*\{([^}]*)\}/.exec(STYLES.replace(/\/\*[\s\S]*?\*\//g, ''));
  const decl = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(root?.[1] ?? '');
  if (decl?.[1] === undefined) throw new Error(`styles.css :root declares no ${name}`);
  return decl[1].trim().replace(/\s+/g, ' ');
}

describe('the motion tokens (docs/06 section 5)', () => {
  it('match styles.css, value for value', () => {
    expect(rootValue('--pb-dur-instant')).toBe(`${MOTION.instant}ms`);
    expect(rootValue('--pb-dur-fast')).toBe(`${MOTION.fast}ms`);
    expect(rootValue('--pb-dur')).toBe(`${MOTION.base}ms`);
    expect(rootValue('--pb-dur-enter')).toBe(`${MOTION.enter}ms`);
    expect(rootValue('--pb-dur-slow')).toBe(`${MOTION.slow}ms`);
    expect(rootValue('--pb-dur-draw')).toBe(`${MOTION.draw}ms`);
    expect(rootValue('--pb-stagger')).toBe(`${MOTION.stagger}ms`);
    expect(rootValue('--pb-rise')).toBe(`${MOTION.rise}px`);
    expect(rootValue('--pb-ease')).toBe(EASE.standard);
    expect(rootValue('--pb-ease-inout')).toBe(EASE.inout);
    expect(rootValue('--pb-ease-exit')).toBe(EASE.exit);
  });

  it('switch off on a slow display as well as under reduced motion', () => {
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce), (update: slow)');
    expect(STYLES).toContain(`@media ${REDUCED_MOTION_QUERY}`);
  });
});

// ---- Every animated selector is switched off under reduced motion ------------------------------

const REDUCED = /prefers-reduced-motion:\s*reduce/;

type Kind = 'animation' | 'transition';
/** A declaration that moves something: animation, animation-name or transition, other than none. */
const MOVES: Record<Kind, RegExp> = {
  animation: /(?:^|;)\s*animation(?:-name)?\s*:(?!\s*none\s*(?:;|$))[^;]+/,
  transition: /(?:^|;)\s*transition\s*:(?!\s*none\s*(?:;|$))[^;]+/,
};
/** The declaration that stops it. */
const STOPS: Record<Kind, RegExp> = {
  animation: /(?:^|;)\s*animation(?:-name)?\s*:\s*none\s*(?:;|$)/,
  transition: /(?:^|;)\s*transition\s*:\s*none\s*(?:;|$)/,
};
const KINDS: Kind[] = ['animation', 'transition'];

/** Splits a selector list on its top-level commas (`:not(.a, .b)` holds commas of its own). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim().replace(/\s+/g, ' ')).filter((s) => s !== '');
}

interface Rule {
  selectors: string[];
  body: string;
  reduced: boolean;
}

/** The style rules of a stylesheet, each with whether it sits inside a reduced-motion block. */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  const preludes: string[] = [];
  let buffer = '';
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') {
      preludes.push(buffer.trim());
      buffer = '';
    } else if (ch === '}') {
      const prelude = preludes.pop();
      const inKeyframes = preludes.some((p) => p.startsWith('@keyframes'));
      if (prelude !== undefined && !prelude.startsWith('@') && !inKeyframes)
        rules.push({
          selectors: splitSelectors(prelude),
          body: buffer,
          reduced: preludes.some((p) => p.startsWith('@media') && REDUCED.test(p)),
        });
      buffer = '';
    } else buffer += ch;
  }
  return rules;
}

/**
 * The selectors that animate or transition outside a reduced-motion block and are not switched
 * off, under exactly the same selector, inside one (`animation: none`, `transition: none`). A media
 * block adds no specificity, so only the same selector, later in the file, wins; a shorter form
 * (`.pb-main > *` for `.pb-main > :not(...)`) leaves the motion on.
 */
function selectorsLeftMoving(css: string): string[] {
  const rules = rulesOf(css);
  const stopped = (kind: Kind): Set<string> =>
    new Set(rules.filter((r) => r.reduced && STOPS[kind].test(r.body)).flatMap((r) => r.selectors));
  const left: string[] = [];
  for (const kind of KINDS) {
    const off = stopped(kind);
    for (const rule of rules)
      if (!rule.reduced && MOVES[kind].test(rule.body))
        for (const s of rule.selectors) if (!off.has(s)) left.push(`${s} (${kind})`);
  }
  return left;
}

function stylesheetsUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stylesheetsUnder(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

describe('the reduced-motion guard (docs/06 section 5)', () => {
  it('finds a selector switched off only in a shorter form', () => {
    const css = `
      .pb-main > :not(.pb-banner, .pb-tabs) { animation: pb-enter 220ms; }
      .ok > :not(.a, .b) { animation: pb-enter 220ms; }
      .pb-steps > li[data-status='done']::before { transition: transform 120ms; }
      .quiet { animation-delay: 24ms; transition: none; }
      @keyframes pb-enter { from { opacity: 0; } }
      @media (prefers-reduced-motion: reduce), (update: slow) {
        .pb-main > *, .ok > :not(.a, .b), .pb-steps > li::before { animation: none; }
      }`;
    expect(selectorsLeftMoving(css)).toEqual([
      '.pb-main > :not(.pb-banner, .pb-tabs) (animation)',
      ".pb-steps > li[data-status='done']::before (transition)",
    ]);
  });

  it('finds a selector repeated without the declaration that stops it', () => {
    const css = `
      .pb-wave-a { animation: pb-drift 36s linear infinite; }
      .pb-row { animation: pb-wash 640ms; transition: color 120ms; }
      @media (prefers-reduced-motion: reduce), (update: slow) {
        .pb-wave { animation: none; }
        .pb-wave-a { transform: translate3d(-12%, 0, 0); }
        .pb-row { animation: none; }
      }`;
    expect(selectorsLeftMoving(css)).toEqual(['.pb-wave-a (animation)', '.pb-row (transition)']);
  });

  it('passes a selector repeated exactly, whatever its spacing', () => {
    const css = `
      .pb-main > :not(.pb-banner, .pb-tabs) { animation: pb-enter 220ms; }
      @media (max-width: 760px) { .pb-x { transition: color 120ms; } }
      @media (prefers-reduced-motion: reduce), (update: slow) {
        .pb-main >  :not(.pb-banner,  .pb-tabs),
        .pb-x { animation: none; transition: none; }
      }`;
    expect(selectorsLeftMoving(css)).toEqual([]);
  });

  it('holds for every stylesheet of the web app', () => {
    const sheets = stylesheetsUnder(SRC);
    expect(sheets.map((s) => relative(SRC, s))).toContain('styles.css');
    const left = sheets.flatMap((sheet) =>
      selectorsLeftMoving(readFileSync(sheet, 'utf8')).map((s) => `${relative(SRC, sheet)}: ${s}`),
    );
    expect(left).toEqual([]);
  });
});

// ---- Script motion ------------------------------------------------------------------------------

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useReducedMotion', () => {
  it('says yes where the browser cannot say', () => {
    expect(typeof globalThis.matchMedia).toBe('undefined');
    expect(renderHook(() => useReducedMotion()).result.current).toBe(true);
  });

  it('follows the media query where there is one', () => {
    stubMatchMedia(false);
    expect(renderHook(() => useReducedMotion()).result.current).toBe(false);
    stubMatchMedia(true);
    expect(renderHook(() => useReducedMotion()).result.current).toBe(true);
  });
});

describe('dialogSurfaceMotion', () => {
  it('fits the dialog slot, and is instant under reduced motion', () => {
    const moving: DialogProps['surfaceMotion'] = dialogSurfaceMotion(false);
    expect(moving).toEqual({
      outScale: 0.98,
      duration: 200,
      easing: EASE.standard,
      exitDuration: MOTION.fast,
      exitEasing: EASE.exit,
    });
    expect(dialogSurfaceMotion(true)).toMatchObject({ duration: 0, exitDuration: 0 });
  });
});

describe('useJustChanged', () => {
  const ended = (animationName: string) =>
    ({ animationName }) as unknown as AnimationEvent<HTMLElement>;

  it('marks the row the command changed until its wash ends', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useJustChanged());
    expect(result.current.rowProps('a')).toEqual({});
    act(() => result.current.mark('a'));
    expect(result.current.rowProps('a')['data-just-changed']).toBe(true);
    expect(result.current.rowProps('b')).toEqual({});
    // Another animation inside the row does not end the wash.
    act(() => result.current.rowProps('a').onAnimationEnd?.(ended('pb-enter')));
    expect(result.current.rowProps('a')['data-just-changed']).toBe(true);
    act(() => result.current.rowProps('a').onAnimationEnd?.(ended('pb-wash')));
    expect(result.current.rowProps('a')).toEqual({});
  });

  it('marks nothing under reduced motion', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useJustChanged());
    act(() => result.current.mark('a'));
    expect(result.current.rowProps('a')).toEqual({});
  });
});
