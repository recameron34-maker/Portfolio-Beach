import { describe, expect, it } from 'vitest';
import { encodeUtf8 } from './bytes.js';
import {
  IDENTITY,
  apply,
  interpretContent,
  multiply,
  translation,
  type Matrix,
  type TextRun,
} from './content.js';
import { assemble, streamBody, type FixtureObject } from './fixtures.js';
import type { LoadedFont } from './fonts.js';
import { READ_LIMITS, type ReadLimits } from './limits.js';
import { nodeInflate } from './node.js';
import { isDict, ref, type PdfDict } from './objects.js';
import { PdfFile } from './xref.js';

/** The content of form Fm2, which inherits the page's resources. */
const FORM_OPERATORS = 'BT /F1 10 Tf 0 0 Td (inherit) Tj ET';

const OBJECTS: FixtureObject[] = [
  { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
  { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
  {
    num: 3,
    body:
      '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /F2 4 0 R /F3 << /Type /Font /Subtype /Type0 /BaseFont /Mono /Encoding /Identity-H /DescendantFonts [<< /Subtype /CIDFontType2 /DW 1000 >>] >> >> ' +
      '/XObject << /Fm1 5 0 R /Fm2 6 0 R /Im1 7 0 R /Loop 8 0 R >> >>',
  },
  { num: 4, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>' },
  {
    num: 5,
    body: streamBody(
      '/Type /XObject /Subtype /Form /Matrix [1 0 0 1 100 50] /Resources << /Font << /F1 4 0 R >> >>',
      'BT /F1 10 Tf 0 0 Td (form) Tj ET',
    ),
  },
  { num: 6, body: streamBody('/Type /XObject /Subtype /Form', FORM_OPERATORS) },
  { num: 7, body: streamBody('/Type /XObject /Subtype /Image /Width 1 /Height 1', 'x') },
  {
    num: 8,
    body: streamBody('/Type /XObject /Subtype /Form', '/Loop Do BT /F1 10 Tf (once) Tj ET'),
  },
];

async function interpret(
  operators: string,
  options: {
    limits?: Partial<ReadLimits>;
    ctm?: Matrix;
    budget?: { used: number; max: number };
  } = {},
): Promise<TextRun[]> {
  const file = await PdfFile.open(assemble(OBJECTS, { trailer: '/Root 1 0 R' }), nodeInflate, {
    ...READ_LIMITS,
    ...options.limits,
  });
  const resources = await file.fetch(ref(3, 0));
  return interpretContent(encodeUtf8(operators), {
    file,
    ctm: options.ctm ?? IDENTITY,
    resources: isDict(resources) ? resources : null,
    budget: options.budget ?? { used: 0, max: READ_LIMITS.maxOperators },
    fontCache: new Map<PdfDict, LoadedFont>(),
  });
}

const near = (value: number, expected: number): void => {
  expect(value).toBeCloseTo(expected, 6);
};

describe('matrices', () => {
  it('multiplies in PDF order and applies points', () => {
    const scale: Matrix = [2, 0, 0, 3, 0, 0];
    const moved = multiply(scale, translation(10, 20));
    expect(moved).toEqual([2, 0, 0, 3, 10, 20]);
    expect(multiply(translation(10, 20), scale)).toEqual([2, 0, 0, 3, 20, 60]);
    expect(apply(moved, 1, 1)).toEqual({ x: 12, y: 23 });
    expect(multiply(IDENTITY, moved)).toEqual(moved);
  });
});

describe('interpretContent', () => {
  it('positions a Tj run by Td and advances by the standard widths', async () => {
    const runs = await interpret('BT /F1 12 Tf 72 700 Td (Hello) Tj (World) Tj ET');
    expect(runs).toHaveLength(2);
    const [hello, world] = runs;
    expect(hello).toMatchObject({ x: 72, y: 700, size: 12, font: 'Helvetica', text: 'Hello' });
    // H 722 e 556 l 222 l 222 o 556 = 2278 / 1000 * 12
    near(hello?.width ?? 0, 27.336);
    near(world?.x ?? 0, 72 + 27.336);
    expect(world?.text).toBe('World');
  });

  it('applies Tc, Tw, Tz and Ts to the advance and the rise', async () => {
    const runs = await interpret('BT /F1 10 Tf 2 Tc 5 Tw 50 Tz 3 Ts 0 0 Td (a b) Tj ET');
    const [run] = runs;
    // a 556 space 278 b 556: ((0.556*10+2) + (0.278*10+2+5) + (0.556*10+2)) * 0.5
    near(run?.width ?? 0, (7.56 + 9.78 + 7.56) * 0.5);
    near(run?.y ?? 0, 3);
    near(run?.size ?? 0, 10);
  });

  it('uses TD, TL, T*, the quote operators and Tm for line positioning', async () => {
    const runs = await interpret(
      'BT /F1 10 Tf 72 700 Td 0 -14 TD (one) Tj T* (two) Tj 12 TL (three) \' 1 2 (four) " 1 0 0 1 300 400 Tm (five) Tj ET',
    );
    expect(runs.map((r) => [r.text, Math.round(r.x), Math.round(r.y)])).toEqual([
      ['one', 72, 686],
      ['two', 72, 672],
      ['three', 72, 660],
      ['four', 72, 648],
      ['five', 300, 400],
    ]);
  });

  it('reads TJ arrays, one run per string, kerning moving the next run', async () => {
    const runs = await interpret('BT /F1 10 Tf 0 0 Td [(A) -500 (B) 250 (C)] TJ ET');
    expect(runs.map((r) => r.text)).toEqual(['A', 'B', 'C']);
    const [a, b, c] = runs;
    near(a?.width ?? 0, 6.67);
    near(b?.x ?? 0, 6.67 + 5);
    near(c?.x ?? 0, 6.67 + 5 + 6.67 - 2.5);
  });

  it('resolves positions through cm and the text matrix, nested q and Q', async () => {
    const runs = await interpret(
      'q 2 0 0 2 10 20 cm q 1 0 0 1 5 5 cm BT /F1 10 Tf 0 0 Td (in) Tj ET Q BT /F1 10 Tf 0 0 Td (out) Tj ET Q BT /F1 10 Tf 0 0 Td (base) Tj ET',
    );
    const [inner, outer, base] = runs;
    expect(inner).toMatchObject({ x: 20, y: 30, size: 20, text: 'in' });
    expect(outer).toMatchObject({ x: 10, y: 20, size: 20, text: 'out' });
    expect(base).toMatchObject({ x: 0, y: 0, size: 10, text: 'base' });
    // i 222 n 556 at 10pt doubled
    near(inner?.width ?? 0, 0.778 * 10 * 2);
    const rotated = await interpret('BT /F1 10 Tf 0 1 -1 0 100 100 Tm (up) Tj ET');
    expect(rotated[0]).toMatchObject({ x: 100, y: 100, size: 10 });
    near(rotated[0]?.width ?? 0, (0.556 + 0.556) * 10);
    const page = await interpret('BT /F1 10 Tf 10 10 Td (x) Tj ET', { ctm: translation(-5, -7) });
    expect(page[0]).toMatchObject({ x: 5, y: 3 });
  });

  it('keeps an unbalanced Q, a missing font and a font with no decoding harmless', async () => {
    const runs = await interpret(
      'Q Q BT (nofont) Tj /Nope 12 Tf (missing) Tj /F3 12 Tf <00410042> Tj ET',
    );
    expect(runs).toEqual([
      { x: 0, y: 0, width: 0, size: 0, font: '', text: '', undecodable: true },
      { x: 0, y: 0, width: 0, size: 12, font: 'Nope', text: '', undecodable: true },
      { x: 0, y: 0, width: 24, size: 12, font: 'Mono', text: '', undecodable: true },
    ]);
  });

  it('marks a run undecodable when any of its codes has no text', async () => {
    const runs = await interpret('BT /F1 12 Tf (ok) Tj (a\\001b) Tj ET');
    expect(runs[0]).toMatchObject({ text: 'ok' });
    expect(runs[0]?.undecodable).toBeUndefined();
    expect(runs[1]).toMatchObject({ text: '', undecodable: true });
    near(runs[1]?.width ?? 0, (0.556 + 0 + 0.556) * 12);
  });

  it('enters form XObjects with their matrix and resources, skips images, stops a self-drawing form', async () => {
    const runs = await interpret(
      'q 1 0 0 1 0 100 cm /Fm1 Do Q /Im1 Do /Fm2 Do BT /F1 10 Tf (after) Tj ET /Loop Do',
    );
    expect(runs.map((r) => [r.text, r.font, r.x, r.y])).toEqual([
      ['form', 'Courier', 100, 150],
      ['inherit', 'Helvetica', 0, 0],
      ['after', 'Helvetica', 0, 0],
      ['once', 'Helvetica', 0, 0],
    ]);
  });

  it('skips inline image data up to EI', async () => {
    const runs = await interpret(
      'BT /F1 10 Tf (a) Tj ET BI /W 2 /H 1 /BPC 8 /CS /G ID \u0000EIÿ EI BT /F1 10 Tf (b) Tj ET BI /W 1 ID x',
    );
    expect(runs.map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('ignores operators it does not draw and drops their operands', async () => {
    const runs = await interpret(
      '0 0 1 rg 1 w 10 10 m 20 20 l S /GS0 gs BT /F1 10 Tf (text) Tj 1 0 0 RG ET',
    );
    expect(runs.map((r) => r.text)).toEqual(['text']);
  });

  it('counts operators against the document budget, at the boundary', async () => {
    const ops = 'BT /F1 10 Tf (a) Tj ET';
    await expect(interpret(ops, { budget: { used: 0, max: 4 } })).resolves.toHaveLength(1);
    await expect(interpret(ops, { budget: { used: 1, max: 4 } })).rejects.toMatchObject({
      code: 'too_large',
    });
    await expect(interpret(ops, { budget: { used: 0, max: 3 } })).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('counts a form against the total stream bytes every time it is drawn (PDF-6)', async () => {
    const draws = '/Fm2 Do '.repeat(10);
    const total = FORM_OPERATORS.length * 10;
    await expect(
      interpret(draws, { limits: { maxTotalStreamBytes: total - 1 } }),
    ).rejects.toMatchObject({ code: 'too_large' });
    await expect(
      interpret(draws, { limits: { maxTotalStreamBytes: total } }),
    ).resolves.toHaveLength(10);
  });

  it('refuses saved states nested past maxDepth', async () => {
    await expect(interpret('q '.repeat(7), { limits: { maxDepth: 6 } })).rejects.toMatchObject({
      code: 'too_large',
    });
    await expect(interpret('q '.repeat(6), { limits: { maxDepth: 6 } })).resolves.toEqual([]);
  });

  it('refuses forms nested past maxDepth', async () => {
    // A chain of three forms with resources nested two deep: form C sits three levels down.
    const chain: FixtureObject[] = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 3, body: '<< /XObject << /A 4 0 R /B 5 0 R /C 6 0 R >> >>' },
      { num: 4, body: streamBody('/Type /XObject /Subtype /Form', '/B Do') },
      { num: 5, body: streamBody('/Type /XObject /Subtype /Form', '/C Do') },
      { num: 6, body: streamBody('/Type /XObject /Subtype /Form', '0 0 m') },
    ];
    const deep = async (maxDepth: number): Promise<TextRun[]> => {
      const file = await PdfFile.open(assemble(chain, { trailer: '/Root 1 0 R' }), nodeInflate, {
        ...READ_LIMITS,
        maxDepth,
      });
      const resources = await file.fetch(ref(3, 0));
      return interpretContent(encodeUtf8('/A Do'), {
        file,
        ctm: IDENTITY,
        resources: isDict(resources) ? resources : null,
        budget: { used: 0, max: 100 },
        fontCache: new Map<PdfDict, LoadedFont>(),
      });
    };
    await expect(deep(3)).resolves.toEqual([]);
    await expect(deep(2)).rejects.toMatchObject({ code: 'too_large' });
  });
});
