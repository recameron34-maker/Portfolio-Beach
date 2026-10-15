import { describe, expect, it } from 'vitest';
import {
  MAC_ROMAN_ENCODING,
  STANDARD_ENCODING,
  WIN_ANSI_ENCODING,
  encodingByName,
  glyphToText,
  winAnsiCode,
} from './encodings.js';

describe('the standard encodings', () => {
  it('share the ASCII range except for the two quote codes', () => {
    for (let code = 32; code < 127; code += 1) {
      if (code === 39 || code === 96) continue;
      expect(STANDARD_ENCODING[code]).toBe(WIN_ANSI_ENCODING[code]);
      expect(STANDARD_ENCODING[code]).toBe(MAC_ROMAN_ENCODING[code]);
    }
    expect(STANDARD_ENCODING[39]).toBe('quoteright');
    expect(WIN_ANSI_ENCODING[39]).toBe('quotesingle');
    expect(MAC_ROMAN_ENCODING[39]).toBe('quotesingle');
    expect(STANDARD_ENCODING[96]).toBe('quoteleft');
    expect(WIN_ANSI_ENCODING[96]).toBe('grave');
    expect(STANDARD_ENCODING[65]).toBe('A');
    expect(STANDARD_ENCODING[126]).toBe('asciitilde');
  });

  it('place the Annex D glyphs at their codes', () => {
    expect(STANDARD_ENCODING[174]).toBe('fi');
    expect(STANDARD_ENCODING[208]).toBe('emdash');
    expect(STANDARD_ENCODING[251]).toBe('germandbls');
    expect(STANDARD_ENCODING[128]).toBeUndefined();
    expect(WIN_ANSI_ENCODING[128]).toBe('Euro');
    expect(WIN_ANSI_ENCODING[145]).toBe('quoteleft');
    expect(WIN_ANSI_ENCODING[150]).toBe('endash');
    expect(WIN_ANSI_ENCODING[160]).toBe('space');
    expect(WIN_ANSI_ENCODING[173]).toBe('hyphen');
    expect(WIN_ANSI_ENCODING[192]).toBe('Agrave');
    expect(WIN_ANSI_ENCODING[255]).toBe('ydieresis');
    expect(WIN_ANSI_ENCODING[127]).toBe('bullet');
    expect(WIN_ANSI_ENCODING[129]).toBe('bullet');
    expect(WIN_ANSI_ENCODING[31]).toBeUndefined();
    expect(MAC_ROMAN_ENCODING[128]).toBe('Adieresis');
    expect(MAC_ROMAN_ENCODING[202]).toBe('space');
    expect(MAC_ROMAN_ENCODING[222]).toBe('fi');
    expect(MAC_ROMAN_ENCODING[255]).toBe('caron');
    expect(MAC_ROMAN_ENCODING[240]).toBe('apple');
  });

  it('are selected by name', () => {
    expect(encodingByName('StandardEncoding')).toBe(STANDARD_ENCODING);
    expect(encodingByName('WinAnsiEncoding')).toBe(WIN_ANSI_ENCODING);
    expect(encodingByName('MacRomanEncoding')).toBe(MAC_ROMAN_ENCODING);
    expect(encodingByName('MacExpertEncoding')).toBeNull();
    expect(encodingByName('Identity-H')).toBeNull();
  });

  it('name only glyphs the glyph list knows', () => {
    for (const encoding of [STANDARD_ENCODING, WIN_ANSI_ENCODING, MAC_ROMAN_ENCODING]) {
      for (const glyph of encoding) {
        if (glyph !== undefined) expect(glyphToText(glyph)).not.toBeNull();
      }
    }
  });
});

describe('glyphToText', () => {
  it('maps names to their text, including uniXXXX, uXXXX and suffixed names', () => {
    expect(glyphToText('A')).toBe('A');
    expect(glyphToText('space')).toBe(' ');
    expect(glyphToText('eacute')).toBe('é');
    expect(glyphToText('Euro')).toBe('€');
    expect(glyphToText('fi')).toBe('ﬁ');
    expect(glyphToText('emdash')).toBe(String.fromCharCode(0x2014));
    expect(glyphToText('uni00E9')).toBe('é');
    expect(glyphToText('u1F600')).toBe('\u{1f600}');
    expect(glyphToText('a.sc')).toBe('a');
    expect(glyphToText('uni0041.alt')).toBe('A');
  });

  it('refuses names it does not know rather than guessing', () => {
    expect(glyphToText('g123')).toBeNull();
    expect(glyphToText('cid42')).toBeNull();
    expect(glyphToText('uni00e9')).toBeNull();
    expect(glyphToText('u110000')).toBeNull();
    expect(glyphToText('')).toBeNull();
    expect(glyphToText('.notdef')).toBeNull();
  });
});

describe('winAnsiCode', () => {
  it('gives the code of a character WinAnsi carries and -1 otherwise', () => {
    expect(winAnsiCode('A')).toBe(65);
    expect(winAnsiCode(' ')).toBe(32);
    expect(winAnsiCode("'")).toBe(39);
    expect(winAnsiCode('`')).toBe(96);
    expect(winAnsiCode('€')).toBe(128);
    expect(winAnsiCode('’')).toBe(146);
    expect(winAnsiCode('•')).toBe(149);
    expect(winAnsiCode(' ')).toBe(160);
    expect(winAnsiCode('­')).toBe(173);
    expect(winAnsiCode('é')).toBe(233);
    expect(winAnsiCode('ÿ')).toBe(255);
    expect(winAnsiCode('Ā')).toBe(-1);
    expect(winAnsiCode('ﬁ')).toBe(-1);
    expect(winAnsiCode('中')).toBe(-1);
    expect(winAnsiCode('\n')).toBe(-1);
  });
});
