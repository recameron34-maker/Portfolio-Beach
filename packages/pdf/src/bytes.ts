/**
 * Byte helpers shared by every layer. PDF syntax is bytes, not text: keywords, names and
 * numbers are ASCII, strings are byte strings whose meaning depends on the font or on the
 * string's own encoding marker. Nothing here imports a runtime module.
 */
import { PdfError } from './errors.js';

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf16be = new TextDecoder('utf-16be', { fatal: true });

/** Encodes text as UTF-8 bytes (ASCII stays ASCII). */
export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decodes UTF-8 strictly: a byte sequence that is not UTF-8 refuses rather than guesses. */
export function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    throw new PdfError(`${what} is not UTF-8 text`, 'corrupt', { cause });
  }
}

/** Decodes UTF-16BE strictly (the form a PDF text string takes after a byte order mark). */
export function decodeUtf16be(bytes: Uint8Array, what: string): string {
  try {
    return utf16be.decode(bytes);
  } catch (cause) {
    throw new PdfError(`${what} is not UTF-16 text`, 'corrupt', { cause });
  }
}

/** One character per byte (ISO 8859-1), the view the lexer and the fallback scan take of bytes. */
export function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** The bytes of a string whose characters are all below 256 (the inverse of `latin1`). */
export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** PDF white-space characters (ISO 32000-1 table 1). */
export function isWhitespace(byte: number): boolean {
  return (
    byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0
  );
}

/** PDF delimiter characters (ISO 32000-1 table 2): ( ) < > [ ] { } / % */
export function isDelimiter(byte: number): boolean {
  return (
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x7b ||
    byte === 0x7d ||
    byte === 0x2f ||
    byte === 0x25
  );
}

/** Every byte that is neither white space nor a delimiter. */
export function isRegular(byte: number): boolean {
  return !isWhitespace(byte) && !isDelimiter(byte);
}

export function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

/** The value of a hexadecimal digit, or -1. */
export function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

/** Whether `bytes` holds `ascii` at `at`. */
export function bytesAt(bytes: Uint8Array, at: number, ascii: string): boolean {
  if (at < 0 || at + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[at + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/** The first position at or after `from` where `ascii` occurs, or -1. */
export function indexOfBytes(bytes: Uint8Array, ascii: string, from = 0): number {
  const first = ascii.charCodeAt(0);
  const last = bytes.length - ascii.length;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    if (bytes[i] === first && bytesAt(bytes, i, ascii)) return i;
  }
  return -1;
}

/** The last position at or before `from` where `ascii` occurs, or -1. */
export function lastIndexOfBytes(bytes: Uint8Array, ascii: string, from?: number): number {
  const first = ascii.charCodeAt(0);
  let i = Math.min(from ?? bytes.length, bytes.length - ascii.length);
  for (; i >= 0; i -= 1) {
    if (bytes[i] === first && bytesAt(bytes, i, ascii)) return i;
  }
  return -1;
}

/**
 * A PDF text string (ISO 32000-1 section 7.9.2.2) as text: UTF-16BE after a byte order mark,
 * UTF-8 after its byte order mark (PDF 2.0), otherwise PDFDocEncoding, which the reader takes as
 * ISO 8859-1 (the two agree on every letter and digit; the PDFDocEncoding specials in the 0x80
 * to 0xA0 range are rare in metadata and come back as the Latin-1 character of the same byte).
 */
export function textString(bytes: Uint8Array, what: string): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16be(bytes.subarray(2), what);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8(bytes.subarray(3), what);
  }
  return latin1(bytes);
}
