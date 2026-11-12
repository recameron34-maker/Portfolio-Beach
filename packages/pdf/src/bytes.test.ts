import { describe, expect, it } from 'vitest';
import {
  bytesAt,
  concatBytes,
  decodeUtf16be,
  decodeUtf8,
  encodeUtf8,
  hexValue,
  indexOfBytes,
  isDelimiter,
  isRegular,
  isWhitespace,
  lastIndexOfBytes,
  latin1,
  latin1Bytes,
  textString,
} from './bytes.js';
import { PdfError } from './errors.js';

describe('bytes', () => {
  it('encodes and decodes UTF-8, refusing bytes that are not UTF-8', () => {
    expect(decodeUtf8(encodeUtf8('café'), 'A string')).toBe('café');
    expect(() => decodeUtf8(new Uint8Array([0xc3, 0x28]), 'A string')).toThrow(PdfError);
    try {
      decodeUtf8(new Uint8Array([0xff]), 'The name');
    } catch (error) {
      expect((error as PdfError).code).toBe('corrupt');
      expect((error as PdfError).message).toBe('The name is not UTF-8 text');
    }
  });

  it('decodes UTF-16BE and refuses a lone surrogate', () => {
    expect(decodeUtf16be(new Uint8Array([0x00, 0x41, 0x20, 0xac]), 'x')).toBe('A€');
    expect(() => decodeUtf16be(new Uint8Array([0xd8, 0x00]), 'x')).toThrow(PdfError);
  });

  it('maps bytes to one character each and back', () => {
    const bytes = new Uint8Array([0x00, 0x41, 0xe9, 0xff]);
    expect(latin1(bytes)).toBe('\u0000Aéÿ');
    expect(latin1Bytes('\u0000Aéÿ')).toEqual(bytes);
  });

  it('concatenates parts', () => {
    expect(concatBytes([new Uint8Array([1, 2]), new Uint8Array(0), new Uint8Array([3])])).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('classifies PDF characters', () => {
    for (const b of [0x20, 0x0a, 0x0d, 0x09, 0x0c, 0x00]) expect(isWhitespace(b)).toBe(true);
    expect(isWhitespace(0x41)).toBe(false);
    for (const c of '()<>[]{}/%') expect(isDelimiter(c.charCodeAt(0))).toBe(true);
    expect(isDelimiter(0x41)).toBe(false);
    expect(isRegular(0x41)).toBe(true);
    expect(isRegular(0x20)).toBe(false);
    expect(isRegular(0x2f)).toBe(false);
  });

  it('reads hexadecimal digits', () => {
    expect(hexValue(0x30)).toBe(0);
    expect(hexValue(0x39)).toBe(9);
    expect(hexValue(0x41)).toBe(10);
    expect(hexValue(0x66)).toBe(15);
    expect(hexValue(0x67)).toBe(-1);
    expect(hexValue(0x20)).toBe(-1);
  });

  it('finds ASCII sequences forwards and backwards', () => {
    const bytes = encodeUtf8('ab obj cd obj');
    expect(bytesAt(bytes, 3, 'obj')).toBe(true);
    expect(bytesAt(bytes, 4, 'obj')).toBe(false);
    expect(bytesAt(bytes, 12, 'obj')).toBe(false);
    expect(bytesAt(bytes, -1, 'a')).toBe(false);
    expect(indexOfBytes(bytes, 'obj')).toBe(3);
    expect(indexOfBytes(bytes, 'obj', 4)).toBe(10);
    expect(indexOfBytes(bytes, 'obj', 11)).toBe(-1);
    expect(indexOfBytes(bytes, 'zzz')).toBe(-1);
    expect(lastIndexOfBytes(bytes, 'obj')).toBe(10);
    expect(lastIndexOfBytes(bytes, 'obj', 9)).toBe(3);
    expect(lastIndexOfBytes(bytes, 'obj', 2)).toBe(-1);
  });

  it('decodes text strings by their byte order mark', () => {
    expect(textString(encodeUtf8('Plain'), 'x')).toBe('Plain');
    expect(textString(new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]), 'x')).toBe('Hi');
    expect(textString(new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0x69]), 'x')).toBe('Hi');
    expect(textString(new Uint8Array([0xe9]), 'x')).toBe('é');
  });
});
