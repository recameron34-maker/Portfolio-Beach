import { describe, expect, it } from 'vitest';
import { STANDARD_ENCODING, WIN_ANSI_ENCODING } from './encodings.js';
import { PdfError } from './errors.js';
import {
  STANDARD_FONTS,
  isStandardFont,
  measureText,
  standardFontFor,
  standardWidths,
} from './metrics.js';

function refusal(run: () => unknown): PdfError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfError);
    return error as PdfError;
  }
  throw new Error('expected a PdfError');
}

describe('standardWidths', () => {
  it('holds a width for every glyph of the Standard and WinAnsi encodings', () => {
    for (const font of ['Helvetica', 'Helvetica-Bold', 'Courier']) {
      const table = standardWidths(font);
      expect(table).not.toBeNull();
      for (const encoding of [STANDARD_ENCODING, WIN_ANSI_ENCODING]) {
        for (const glyph of encoding) {
          if (glyph !== undefined) expect(table?.width(glyph), `${font} ${glyph}`).not.toBeNull();
        }
      }
    }
  });

  it('gives the AFM widths of the core set', () => {
    const helvetica = standardWidths('Helvetica');
    expect(helvetica?.width('space')).toBe(278);
    expect(helvetica?.width('a')).toBe(556);
    expect(helvetica?.width('W')).toBe(944);
    expect(helvetica?.width('at')).toBe(1015);
    expect(helvetica?.width('Euro')).toBe(556);
    expect(helvetica?.width('g123')).toBeNull();
    const bold = standardWidths('Helvetica-Bold');
    expect(bold?.width('a')).toBe(556);
    expect(bold?.width('b')).toBe(611);
    expect(bold?.width('at')).toBe(975);
    const courier = standardWidths('Courier-BoldOblique');
    expect(courier?.width('a')).toBe(600);
    expect(courier?.width('W')).toBe(600);
    expect(courier?.width('g123')).toBeNull();
  });

  it('shares tables across the oblique faces and approximates Times by Helvetica', () => {
    expect(standardWidths('Helvetica-Oblique')?.width('a')).toBe(556);
    expect(standardWidths('Helvetica-BoldOblique')?.width('b')).toBe(611);
    expect(standardWidths('Times-Roman')?.width('a')).toBe(556);
    expect(standardWidths('Times-Bold')?.width('b')).toBe(611);
    expect(standardWidths('Times-Italic')?.width('a')).toBe(556);
    expect(standardWidths('Times-BoldItalic')?.width('b')).toBe(611);
  });

  it('has no table for Symbol, ZapfDingbats or an unknown font', () => {
    expect(standardWidths('Symbol')).toBeNull();
    expect(standardWidths('ZapfDingbats')).toBeNull();
    expect(standardWidths('Wingdings')).toBeNull();
  });
});

describe('standardFontFor', () => {
  it('folds the common aliases and subset tags', () => {
    expect(standardFontFor('Helvetica')).toBe('Helvetica');
    expect(standardFontFor('ABCDEF+Helvetica-Bold')).toBe('Helvetica-Bold');
    expect(standardFontFor('Arial')).toBe('Helvetica');
    expect(standardFontFor('ArialMT')).toBe('Helvetica');
    expect(standardFontFor('Arial,Bold')).toBe('Helvetica-Bold');
    expect(standardFontFor('Arial-BoldItalicMT')).toBe('Helvetica-BoldOblique');
    expect(standardFontFor('Arial-ItalicMT')).toBe('Helvetica-Oblique');
    expect(standardFontFor('TimesNewRoman')).toBe('Times-Roman');
    expect(standardFontFor('TimesNewRomanPS-BoldMT')).toBe('Times-Bold');
    expect(standardFontFor('TimesNewRoman,Italic')).toBe('Times-Italic');
    expect(standardFontFor('Times-BoldItalic')).toBe('Times-BoldItalic');
    expect(standardFontFor('CourierNewPSMT')).toBe('Courier');
    expect(standardFontFor('CourierNew,Bold')).toBe('Courier-Bold');
    expect(standardFontFor('Courier-Oblique')).toBe('Courier-Oblique');
    expect(standardFontFor('XYZABC+Calibri-Bold')).toBe('Helvetica-Bold');
  });

  it('returns null for Symbol, ZapfDingbats and fonts it does not know', () => {
    expect(standardFontFor('Symbol')).toBeNull();
    expect(standardFontFor('ZapfDingbats')).toBeNull();
    expect(standardFontFor('Garamond')).toBeNull();
    expect(standardFontFor('')).toBeNull();
    expect(standardFontFor('ABCDEF+')).toBeNull();
  });

  it('lists the twelve text faces', () => {
    expect(STANDARD_FONTS).toHaveLength(12);
    for (const font of STANDARD_FONTS) expect(isStandardFont(font)).toBe(true);
    expect(isStandardFont('Symbol')).toBe(false);
  });
});

describe('measureText', () => {
  it('sums the glyph widths scaled by the size', () => {
    expect(measureText('a', 'Helvetica', 1000)).toBe(556);
    expect(measureText('aa', 'Helvetica', 10)).toBeCloseTo(11.12, 10);
    expect(measureText('ab', 'Helvetica-Bold', 10)).toBeCloseTo(11.67, 10);
    expect(measureText('Hello', 'Courier', 10)).toBe(30);
    expect(measureText('Hello', 'Courier-Bold', 12)).toBe(36);
    expect(measureText('', 'Helvetica', 12)).toBe(0);
    expect(measureText('x', 'Helvetica', 0)).toBe(0);
    expect(measureText('€', 'Helvetica', 1000)).toBe(556);
    expect(measureText(' ', 'Helvetica', 1000)).toBe(278);
  });

  it('uses Helvetica widths for Times, as documented', () => {
    expect(measureText('Portfolio', 'Times-Roman', 10)).toBe(
      measureText('Portfolio', 'Helvetica', 10),
    );
    expect(measureText('Portfolio', 'Times-Bold', 10)).toBe(
      measureText('Portfolio', 'Helvetica-Bold', 10),
    );
  });

  it('refuses a character outside WinAnsi with a plain message', () => {
    const error = refusal(() => measureText('café 中', 'Helvetica', 10));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toBe(
      'The text "café 中" holds the character "中" (U+4E2D), which WinAnsiEncoding cannot carry',
    );
    expect(refusal(() => measureText('a\nb', 'Helvetica', 10)).code).toBe('invalid_input');
  });

  it('refuses a font or a size it cannot measure', () => {
    expect(refusal(() => measureText('a', 'Symbol' as never, 10)).code).toBe('invalid_input');
    expect(refusal(() => measureText('a', 'Helvetica', -1)).code).toBe('invalid_input');
    expect(refusal(() => measureText('a', 'Helvetica', Number.NaN)).code).toBe('invalid_input');
  });
});
