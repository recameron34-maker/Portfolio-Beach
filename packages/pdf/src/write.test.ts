import { describe, expect, it } from 'vitest';
import { latin1 } from './bytes.js';
import { PdfError } from './errors.js';
import { READ_LIMITS } from './limits.js';
import { measureText } from './metrics.js';
import { nodeInflate } from './node.js';
import { ref } from './objects.js';
import { readPdf } from './read.js';
import {
  MAX_TEXT_LENGTH,
  MAX_WRITE_PAGES,
  encodeInfoString,
  encodeTextLiteral,
  formatNumber,
  writePdf,
  type WritePdfInput,
} from './write.js';
import { PdfFile } from './xref.js';

function refusal(run: () => unknown): PdfError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfError);
    return error as PdfError;
  }
  throw new Error('expected a PdfError');
}

const read = (bytes: Uint8Array) => readPdf(bytes, { inflate: nodeInflate });

const REPORT: WritePdfInput = {
  title: 'Quarterly report',
  author: 'Synthetic Sponsor Fund III',
  subject: 'Q2 2026',
  keywords: 'synthetic, prototype',
  creator: 'Portfolio Beach synthetic generator',
  producer: '@pb/pdf',
  creationDate: 'D:20260630120000Z',
  pages: [
    {
      items: [
        { kind: 'text', x: 72, y: 720, size: 18, font: 'Helvetica-Bold', text: 'Quarterly report' },
        { kind: 'text', x: 72, y: 690, size: 11, font: 'Helvetica', text: 'Revenue (LTM)' },
        { kind: 'text', x: 400, y: 690, size: 11, font: 'Courier', text: '123.45' },
        {
          kind: 'text',
          x: 72,
          y: 670,
          size: 11,
          font: 'Times-Roman',
          text: 'Café € (parens) \\ back',
        },
        { kind: 'line', x1: 72, y1: 660, x2: 540, y2: 660, width: 0.5 },
        { kind: 'rect', x: 72, y: 600, w: 100, h: 20 },
        { kind: 'rect', x: 200, y: 600, w: 100, h: 20, fill: true },
      ],
    },
    {
      width: 595.276,
      height: 841.89,
      items: [
        { kind: 'text', x: 50, y: 800, size: 9.5, font: 'Helvetica-Oblique', text: 'Page two' },
      ],
    },
  ],
};

describe('formatNumber', () => {
  it('writes at most four decimals without an exponent or trailing zeros', () => {
    expect(formatNumber(72, 'x')).toBe('72');
    expect(formatNumber(0.5, 'x')).toBe('0.5');
    expect(formatNumber(595.276, 'x')).toBe('595.276');
    expect(formatNumber(1.23456789, 'x')).toBe('1.2346');
    expect(formatNumber(-0, 'x')).toBe('0');
    expect(formatNumber(-0.00001, 'x')).toBe('0');
    expect(formatNumber(1e-7, 'x')).toBe('0');
    expect(formatNumber(-12.5, 'x')).toBe('-12.5');
  });

  it('refuses what cannot be written', () => {
    expect(refusal(() => formatNumber(Number.NaN, 'x')).code).toBe('invalid_input');
    expect(refusal(() => formatNumber(Number.POSITIVE_INFINITY, 'x')).code).toBe('invalid_input');
    expect(refusal(() => formatNumber(1e10, 'x')).code).toBe('invalid_input');
  });
});

describe('encodeTextLiteral', () => {
  it('escapes delimiters and writes non-ASCII WinAnsi bytes as octal', () => {
    expect(encodeTextLiteral('a(b)c\\d')).toBe('(a\\(b\\)c\\\\d)');
    expect(encodeTextLiteral('\u00e9\u20ac\u00a0')).toBe('(\\351\\200\\240)');
    expect(encodeTextLiteral('')).toBe('()');
  });

  it('refuses a character outside WinAnsi with a plain message', () => {
    const error = refusal(() => encodeTextLiteral('xĀ'));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toBe(
      'The text "xĀ" holds the character "Ā" (U+0100), which WinAnsiEncoding cannot carry',
    );
  });
});

describe('encodeInfoString', () => {
  it('writes printable ASCII as a literal and anything else as UTF-16BE hex', () => {
    expect(encodeInfoString('Plain title')).toBe('(Plain title)');
    expect(encodeInfoString('a(b)')).toBe('<FEFF0061002800620029>');
    expect(encodeInfoString('é')).toBe('<FEFF00E9>');
    expect(encodeInfoString('')).toBe('()');
  });
});

describe('writePdf', () => {
  it('is deterministic: the same input gives the same bytes', () => {
    const a = writePdf(REPORT);
    const b = writePdf(structuredClone(REPORT));
    expect(a).toEqual(b);
    expect(latin1(a.subarray(0, 9))).toBe('%PDF-1.4\n');
    expect(latin1(a).endsWith('%%EOF\n')).toBe(true);
  });

  it('writes a cross-reference table whose offsets point at every object', async () => {
    const bytes = writePdf(REPORT);
    const file = await PdfFile.open(bytes, nodeInflate, READ_LIMITS);
    expect(file.reconstructed).toBe(false);
    // 1 catalog, 2 pages, 4 page and content objects, 5 fonts, 1 info: 12 objects, Size 13.
    expect(file.trailer.map.get('Size')).toBe(13);
    for (let num = 1; num <= 12; num += 1) {
      expect(await file.fetch(ref(num, 0)), `object ${num}`).not.toBeNull();
    }
    expect(file.reconstructed).toBe(false);
    const text = latin1(bytes);
    expect(text).toContain('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding');
    expect(text).toContain('0.5 w 72 660 m 540 660 l S');
    expect(text).toContain('72 600 100 20 re S');
    expect(text).toContain('200 600 100 20 re f');
    expect(text).not.toContain('/Filter');
  });

  it('reads back with the runs it wrote: text, position, size and font', async () => {
    const document = await read(writePdf(REPORT));
    expect(document.version).toBe('1.4');
    expect(document.pageCount).toBe(2);
    expect(document.reconstructed).toBe(false);
    expect(document.info).toEqual({
      title: 'Quarterly report',
      author: 'Synthetic Sponsor Fund III',
      subject: 'Q2 2026',
      keywords: 'synthetic, prototype',
      creator: 'Portfolio Beach synthetic generator',
      producer: '@pb/pdf',
      creationDate: 'D:20260630120000Z',
    });
    const [first, second] = document.pages;
    expect(first).toMatchObject({ number: 1, width: 612, height: 792, rotate: 0 });
    const items = REPORT.pages[0]?.items.filter((item) => item.kind === 'text') ?? [];
    expect(first?.runs).toHaveLength(items.length);
    items.forEach((item, i) => {
      if (item.kind !== 'text') return;
      const run = first?.runs[i];
      expect(run).toMatchObject({
        x: item.x,
        y: item.y,
        size: item.size,
        font: item.font,
        text: item.text,
      });
      expect(run?.undecodable).toBeUndefined();
      expect(run?.width).toBeCloseTo(measureText(item.text, item.font, item.size), 6);
    });
    expect(first?.lines.map((line) => line.text)).toEqual([
      'Quarterly report',
      'Revenue (LTM) 123.45',
      'Café € (parens) \\ back',
    ]);
    expect(first?.text).toBe('Quarterly report\nRevenue (LTM) 123.45\nCafé € (parens) \\ back');
    expect(second).toMatchObject({ number: 2, width: 595.276, height: 841.89 });
    expect(second?.runs[0]).toMatchObject({
      x: 50,
      y: 800,
      size: 9.5,
      font: 'Helvetica-Oblique',
      text: 'Page two',
    });
  });

  it('writes no information dictionary when no value is given', async () => {
    const bytes = writePdf({ pages: [{ items: [] }] });
    expect(latin1(bytes)).not.toContain('/Info');
    const document = await read(bytes);
    expect(document.info).toEqual({});
    expect(document.pages[0]?.runs).toEqual([]);
    expect(document.pages[0]?.text).toBe('');
  });

  it('carries non-ASCII information strings through UTF-16', async () => {
    const document = await read(writePdf({ title: 'Résumé (draft)', pages: [{ items: [] }] }));
    expect(document.info.title).toBe('Résumé (draft)');
  });

  it('shares one font object across pages and numbers fonts in first-use order', () => {
    const text = latin1(
      writePdf({
        pages: [
          { items: [{ kind: 'text', x: 0, y: 0, size: 10, font: 'Courier', text: 'a' }] },
          {
            items: [
              { kind: 'text', x: 0, y: 0, size: 10, font: 'Helvetica', text: 'b' },
              { kind: 'text', x: 0, y: 0, size: 10, font: 'Courier', text: 'c' },
            ],
          },
        ],
      }),
    );
    expect(text.match(/\/Type \/Font/g)).toHaveLength(2);
    expect(text).toContain('/F1 7 0 R /F2 8 0 R');
    expect(text).toContain('7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier');
    expect(text).toContain('8 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica');
  });

  it('refuses text outside WinAnsi, naming the character', () => {
    const error = refusal(() =>
      writePdf({
        pages: [
          { items: [{ kind: 'text', x: 0, y: 0, size: 10, font: 'Helvetica', text: 'ok 中' }] },
        ],
      }),
    );
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('U+4E2D');
  });

  it('refuses input it cannot write, naming the page and item', () => {
    const page = (item: object): WritePdfInput => ({ pages: [{ items: [item as never] }] });
    expect(refusal(() => writePdf({ pages: [] })).code).toBe('invalid_input');
    expect(refusal(() => writePdf({ pages: 'no' as never })).code).toBe('invalid_input');
    expect(refusal(() => writePdf({ pages: [{ width: 0, items: [] }] })).code).toBe(
      'invalid_input',
    );
    expect(refusal(() => writePdf({ pages: [{ height: -1, items: [] }] })).code).toBe(
      'invalid_input',
    );
    expect(
      refusal(() => writePdf({ creationDate: '2026-06-30', pages: [{ items: [] }] })).code,
    ).toBe('invalid_input');
    expect(
      refusal(() =>
        writePdf(page({ kind: 'text', x: 0, y: 0, size: 0, font: 'Helvetica', text: 'a' })),
      ).message,
    ).toBe('page 1 item 1 has a font size that is not positive');
    expect(
      refusal(() =>
        writePdf(page({ kind: 'text', x: 0, y: 0, size: 10, font: 'Symbol', text: 'a' })),
      ).code,
    ).toBe('invalid_input');
    expect(
      refusal(() => writePdf(page({ kind: 'text', x: 0, y: 0, size: 10, font: 'Helvetica' }))).code,
    ).toBe('invalid_input');
    expect(
      refusal(() =>
        writePdf(
          page({ kind: 'text', x: Number.NaN, y: 0, size: 10, font: 'Helvetica', text: 'a' }),
        ),
      ).code,
    ).toBe('invalid_input');
    expect(
      refusal(() =>
        writePdf(
          page({
            kind: 'text',
            x: 0,
            y: 0,
            size: 10,
            font: 'Helvetica',
            text: 'x'.repeat(MAX_TEXT_LENGTH + 1),
          }),
        ),
      ).code,
    ).toBe('invalid_input');
    expect(
      refusal(() => writePdf(page({ kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1, width: -1 }))).code,
    ).toBe('invalid_input');
    expect(
      refusal(() => writePdf(page({ kind: 'rect', x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 1 })))
        .code,
    ).toBe('invalid_input');
    expect(refusal(() => writePdf(page({ kind: 'circle' }))).code).toBe('invalid_input');
    const many = { pages: Array.from({ length: MAX_WRITE_PAGES + 1 }, () => ({ items: [] })) };
    expect(refusal(() => writePdf(many)).code).toBe('invalid_input');
  });

  it('accepts every date form the specification allows', () => {
    for (const date of [
      'D:2026',
      'D:202606',
      'D:20260630',
      'D:2026063012',
      'D:202606301200',
      'D:20260630120000',
      'D:20260630120000Z',
      "D:20260630120000+01'00'",
      "D:20260630120000-05'00",
    ]) {
      expect(latin1(writePdf({ creationDate: date, pages: [{ items: [] }] }))).toContain(
        `/CreationDate (${date})`,
      );
    }
  });
});
