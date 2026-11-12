import { describe, expect, it } from 'vitest';
import { encodeUtf8 } from './bytes.js';
import { assemble, streamBody, type FixtureObject } from './fixtures.js';
import { loadFont, undecodableFont, type LoadedFont } from './fonts.js';
import { READ_LIMITS } from './limits.js';
import { nodeInflate } from './node.js';
import { isDict, ref } from './objects.js';
import { PdfFile } from './xref.js';

const TO_UNICODE = `1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0001> <0048> <0002> <0069> endbfchar
1 beginbfrange <0010> <0012> <0061> endbfrange`;

const SIMPLE_TO_UNICODE = `1 begincodespacerange <00> <FF> endcodespacerange
1 beginbfchar <41> <00E9> endbfchar`;

const OBJECTS: FixtureObject[] = [
  { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
  { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
  { num: 10, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  {
    num: 11,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  },
  {
    num: 12,
    body: '<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Arial /FirstChar 65 /LastChar 67 /Widths [700 650 0] /FontDescriptor 13 0 R /Encoding << /BaseEncoding /MacRomanEncoding /Differences [66 /eacute 67 /g123 /g124] >> >>',
  },
  {
    num: 13,
    body: '<< /Type /FontDescriptor /FontName /ABCDEF+Arial /Flags 32 /MissingWidth 250 >>',
  },
  {
    num: 14,
    body: '<< /Type /Font /Subtype /TrueType /BaseFont /Mystery /FontDescriptor 15 0 R >>',
  },
  { num: 15, body: '<< /Type /FontDescriptor /FontName /Mystery /Flags 4 >>' },
  {
    num: 16,
    body: '<< /Type /Font /Subtype /TrueType /BaseFont /Mystery /FontDescriptor 15 0 R /ToUnicode 17 0 R >>',
  },
  { num: 17, body: streamBody('', SIMPLE_TO_UNICODE) },
  {
    num: 20,
    body: '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Garamond /Encoding /Identity-H /DescendantFonts [21 0 R] /ToUnicode 22 0 R >>',
  },
  {
    num: 21,
    body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Garamond /DW 500 /W [1 [600 700] 16 18 800] >>',
  },
  { num: 22, body: streamBody('', TO_UNICODE) },
  {
    num: 23,
    body: '<< /Type /Font /Subtype /Type0 /BaseFont /NoMap /Encoding /Identity-H /DescendantFonts [21 0 R] >>',
  },
  {
    num: 24,
    body: '<< /Type /Font /Subtype /Type0 /BaseFont /Embedded /Encoding 25 0 R /DescendantFonts [21 0 R] /ToUnicode 22 0 R >>',
  },
  {
    num: 25,
    body: streamBody(
      '',
      '1 begincodespacerange <0000> <ffff> endcodespacerange 1 begincidrange <0001> <0002> 16 endcidrange',
    ),
  },
  {
    num: 26,
    body: '<< /Type /Font /Subtype /Type0 /BaseFont /Predefined /Encoding /UniGB-UCS2-H /DescendantFonts [21 0 R] /ToUnicode 22 0 R >>',
  },
  {
    num: 30,
    body: '<< /Type /Font /Subtype /Type3 /FontMatrix [0.01 0 0 0.01 0 0] /FirstChar 97 /Widths [50 60] /Encoding << /Differences [97 /a /b] >> /CharProcs << >> >>',
  },
  { num: 31, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>' },
  {
    num: 32,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /MacExpertEncoding /Widths [] >>',
  },
  {
    num: 33,
    body: '<< /Type /Font /Subtype /Type0 /BaseFont /NoDescendant /Encoding /Identity-H >>',
  },
];

async function fonts(): Promise<(num: number) => Promise<LoadedFont>> {
  const file = await PdfFile.open(
    assemble(OBJECTS, { trailer: '/Root 1 0 R' }),
    nodeInflate,
    READ_LIMITS,
  );
  return async (num) => {
    const dict = await file.fetch(ref(num, 0));
    if (!isDict(dict)) throw new Error(`object ${num} is not a dictionary`);
    return loadFont(file, dict, `F${num}`);
  };
}

const textOf = (font: LoadedFont, bytes: Uint8Array): (string | null)[] =>
  font.codes(bytes).map((code) => font.text(code));

describe('loadFont', () => {
  it('decodes a standard font through the standard encoding and its metrics', async () => {
    const font = await (await fonts())(10);
    expect(font.name).toBe('Helvetica');
    expect(textOf(font, encodeUtf8("Hi'"))).toEqual(['H', 'i', '’']);
    expect(font.width({ code: 72, length: 1 })).toBeCloseTo(0.722, 10);
    expect(font.width({ code: 1, length: 1 })).toBe(0);
    expect(font.text({ code: 1, length: 1 })).toBeNull();
    expect(font.isWordSpace({ code: 32, length: 1 })).toBe(true);
    expect(font.isWordSpace({ code: 32, length: 2 })).toBe(false);
  });

  it('uses a named encoding and the bold metrics', async () => {
    const font = await (await fonts())(11);
    expect(textOf(font, new Uint8Array([0x27, 0x80, 0xe9]))).toEqual(["'", '€', 'é']);
    expect(font.width({ code: 0x61, length: 1 })).toBeCloseTo(0.556, 10);
    expect(font.width({ code: 0x62, length: 1 })).toBeCloseTo(0.611, 10);
  });

  it('applies a base encoding, /Differences, /Widths and /MissingWidth, and drops the subset tag', async () => {
    const font = await (await fonts())(12);
    expect(font.name).toBe('Arial');
    expect(textOf(font, new Uint8Array([65, 66, 67, 68, 0x8e]))).toEqual([
      'A',
      'é',
      null,
      null,
      'é',
    ]);
    expect(font.width({ code: 65, length: 1 })).toBe(0.7);
    expect(font.width({ code: 66, length: 1 })).toBe(0.65);
    expect(font.width({ code: 67, length: 1 })).toBe(0);
    expect(font.width({ code: 68, length: 1 })).toBe(0.25);
    expect(font.width({ code: 10, length: 1 })).toBe(0.25);
  });

  it('decodes nothing for a symbolic embedded font without an encoding or a ToUnicode map', async () => {
    const load = await fonts();
    const font = await load(14);
    expect(font.name).toBe('Mystery');
    expect(textOf(font, encodeUtf8('AB'))).toEqual([null, null]);
    expect(font.width({ code: 65, length: 1 })).toBe(0);
    const mapped = await load(16);
    expect(textOf(mapped, encodeUtf8('AB'))).toEqual(['é', null]);
  });

  it('decodes a Type0 font through its ToUnicode map with /W and /DW widths', async () => {
    const font = await (await fonts())(20);
    expect(font.name).toBe('Garamond');
    const bytes = new Uint8Array([0, 1, 0, 2, 0, 0x11, 0, 0x30]);
    expect(textOf(font, bytes)).toEqual(['H', 'i', 'b', null]);
    expect(font.width({ code: 1, length: 2 })).toBe(0.6);
    expect(font.width({ code: 2, length: 2 })).toBe(0.7);
    expect(font.width({ code: 0x11, length: 2 })).toBe(0.8);
    expect(font.width({ code: 0x30, length: 2 })).toBe(0.5);
    expect(font.isWordSpace({ code: 32, length: 2 })).toBe(false);
  });

  it('decodes nothing for a Type0 font without a ToUnicode map, still advancing', async () => {
    const font = await (await fonts())(23);
    expect(textOf(font, new Uint8Array([0, 1]))).toEqual([null]);
    expect(font.width({ code: 1, length: 2 })).toBe(0.6);
  });

  it('maps codes to CIDs through an embedded encoding CMap for widths', async () => {
    const font = await (await fonts())(24);
    expect(font.width({ code: 1, length: 2 })).toBe(0.8);
    expect(font.width({ code: 2, length: 2 })).toBe(0.8);
    expect(font.width({ code: 3, length: 2 })).toBe(0.5);
    expect(textOf(font, new Uint8Array([0, 1]))).toEqual(['H']);
  });

  it('splits by the ToUnicode codespace when the encoding CMap is predefined and not bundled', async () => {
    const font = await (await fonts())(26);
    expect(font.codes(new Uint8Array([0, 1, 0, 2]))).toEqual([
      { code: 1, length: 2 },
      { code: 2, length: 2 },
    ]);
    expect(textOf(font, new Uint8Array([0, 1]))).toEqual(['H']);
  });

  it('scales Type3 widths through the font matrix and decodes through /Differences', async () => {
    const font = await (await fonts())(30);
    expect(font.name).toBe('F30');
    expect(textOf(font, encodeUtf8('abc'))).toEqual(['a', 'b', null]);
    expect(font.width({ code: 97, length: 1 })).toBeCloseTo(0.5, 10);
    expect(font.width({ code: 98, length: 1 })).toBeCloseTo(0.6, 10);
    expect(font.width({ code: 99, length: 1 })).toBe(0);
  });

  it('reports Symbol as undecodable rather than guessing Latin text', async () => {
    const font = await (await fonts())(31);
    expect(font.name).toBe('Symbol');
    // Symbol is a standard font, so the standard encoding names its codes, but it has no width table.
    expect(font.width({ code: 97, length: 1 })).toBe(0);
  });

  it('falls back to the standard encoding for an unknown encoding name and empty widths', async () => {
    const font = await (await fonts())(32);
    expect(textOf(font, encodeUtf8('A'))).toEqual(['A']);
    expect(font.width({ code: 65, length: 1 })).toBeCloseTo(0.667, 10);
  });

  it('loads a Type0 font without descendants with default widths', async () => {
    const font = await (await fonts())(33);
    expect(font.width({ code: 5, length: 2 })).toBe(1);
    expect(font.text({ code: 5, length: 2 })).toBeNull();
  });
});

describe('undecodableFont', () => {
  it('decodes nothing and advances nothing', () => {
    const font = undecodableFont('Missing');
    expect(font.name).toBe('Missing');
    expect(textOf(font, encodeUtf8('ab'))).toEqual([null, null]);
    expect(font.width({ code: 97, length: 1 })).toBe(0);
    expect(font.isWordSpace({ code: 32, length: 1 })).toBe(true);
  });
});
