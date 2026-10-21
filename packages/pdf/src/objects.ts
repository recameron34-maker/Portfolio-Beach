/**
 * The PDF object model (ISO 32000-1 section 7.3), its lexer and its parser. Objects are plain
 * values with a `kind` tag so a reader never mistakes a name for a string or a reference for a
 * number. The same lexer tokenizes file objects, cross-reference tables, object streams, content
 * streams and CMaps; the parser takes a mode (file objects allow `n g R` references, content
 * streams return operators) and a nesting budget.
 */
import { hexValue, isDigit, isRegular, isWhitespace, latin1 } from './bytes.js';
import { PdfError } from './errors.js';

export interface PdfName {
  kind: 'name';
  name: string;
}
export interface PdfString {
  kind: 'string';
  bytes: Uint8Array;
}
export interface PdfRef {
  kind: 'ref';
  num: number;
  gen: number;
}
export interface PdfArray {
  kind: 'array';
  items: PdfObject[];
}
export interface PdfDict {
  kind: 'dict';
  map: Map<string, PdfObject>;
}
export interface PdfStream {
  kind: 'stream';
  dict: PdfDict;
  /** The stream's bytes as the file holds them, before any filter is applied. */
  raw: Uint8Array;
}
/** A content stream operator (only in content mode). */
export interface PdfOperator {
  kind: 'op';
  op: string;
}

export type PdfObject =
  | null
  | boolean
  | number
  | PdfName
  | PdfString
  | PdfRef
  | PdfArray
  | PdfDict
  | PdfStream
  | PdfOperator;

export const name = (value: string): PdfName => ({ kind: 'name', name: value });
export const ref = (num: number, gen: number): PdfRef => ({ kind: 'ref', num, gen });
export const dict = (entries: Record<string, PdfObject> = {}): PdfDict => ({
  kind: 'dict',
  map: new Map(Object.entries(entries)),
});
export const array = (items: PdfObject[]): PdfArray => ({ kind: 'array', items });
export const string = (bytes: Uint8Array): PdfString => ({ kind: 'string', bytes });

export const isName = (o: PdfObject | undefined, value?: string): o is PdfName =>
  o !== null &&
  typeof o === 'object' &&
  o.kind === 'name' &&
  (value === undefined || o.name === value);
export const isDict = (o: PdfObject | undefined): o is PdfDict =>
  o !== null && typeof o === 'object' && o.kind === 'dict';
export const isStream = (o: PdfObject | undefined): o is PdfStream =>
  o !== null && typeof o === 'object' && o.kind === 'stream';
export const isArray = (o: PdfObject | undefined): o is PdfArray =>
  o !== null && typeof o === 'object' && o.kind === 'array';
export const isRef = (o: PdfObject | undefined): o is PdfRef =>
  o !== null && typeof o === 'object' && o.kind === 'ref';
export const isString = (o: PdfObject | undefined): o is PdfString =>
  o !== null && typeof o === 'object' && o.kind === 'string';
export const isNumber = (o: PdfObject | undefined): o is number => typeof o === 'number';
export const isOperator = (o: PdfObject | undefined): o is PdfOperator =>
  o !== null && typeof o === 'object' && o.kind === 'op';

/** The dictionary of a dict or a stream, or null. */
export function dictOf(o: PdfObject | undefined): PdfDict | null {
  if (isDict(o)) return o;
  if (isStream(o)) return o.dict;
  return null;
}

export type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; bytes: Uint8Array }
  | { kind: 'name'; name: string }
  | { kind: 'delimiter'; value: '[' | ']' | '<<' | '>>' | '{' | '}' }
  | { kind: 'keyword'; value: string }
  | { kind: 'eof' };

const NUMBER = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;
/** A real with extra signs or dots, as some writers emit (`--5`, `3.4.5`); read as far as it makes sense. */
const LOOSE_NUMBER = /^([+-]*)([0-9]*)(?:\.([0-9]*))?/;

/** Parses a PDF numeric token; never through parseFloat, which would accept trailing garbage. */
export function parseNumber(text: string): number {
  if (NUMBER.test(text)) {
    const value = Number(text);
    if (Number.isFinite(value)) return value;
  }
  const loose = LOOSE_NUMBER.exec(text);
  if (loose && (loose[2] !== '' || (loose[3] !== undefined && loose[3] !== ''))) {
    const negative = (loose[1] ?? '').includes('-');
    const whole = loose[2] === '' ? '0' : (loose[2] ?? '0');
    const fraction = loose[3] ?? '';
    const value = Number(`${whole}.${fraction === '' ? '0' : fraction}`);
    if (Number.isFinite(value)) return negative ? -value : value;
  }
  throw new PdfError(`The file holds "${text}" where a number was expected`, 'corrupt');
}

/**
 * Tokenizes PDF syntax from a byte array. The position is public so callers can read raw bytes
 * (stream data, inline image data) and continue after them.
 */
export class Lexer {
  pos: number;

  constructor(
    readonly bytes: Uint8Array,
    pos = 0,
  ) {
    this.pos = pos;
  }

  /** Skips white space and comments. */
  skipWhitespace(): void {
    const { bytes } = this;
    while (this.pos < bytes.length) {
      const b = bytes[this.pos] ?? 0;
      if (isWhitespace(b)) this.pos += 1;
      else if (b === 0x25) {
        while (this.pos < bytes.length && bytes[this.pos] !== 0x0a && bytes[this.pos] !== 0x0d) {
          this.pos += 1;
        }
      } else break;
    }
  }

  peek(): Token {
    const saved = this.pos;
    const token = this.next();
    this.pos = saved;
    return token;
  }

  next(): Token {
    const { bytes } = this;
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= bytes.length) return { kind: 'eof' };
      const b = bytes[this.pos] ?? 0;
      if (b === 0x29 || (b === 0x3e && bytes[this.pos + 1] !== 0x3e)) {
        // A stray ")" or a lone ">" is not PDF syntax; skip it as the common readers do. A loop,
        // not a recursive call, so a long run of them cannot overflow the stack.
        this.pos += 1;
        continue;
      }
      if (isDigit(b) || b === 0x2b || b === 0x2d || b === 0x2e) return this.number();
      if (b === 0x28) return this.literalString();
      if (b === 0x2f) return this.name();
      if (b === 0x3c) {
        if (bytes[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return { kind: 'delimiter', value: '<<' };
        }
        return this.hexString();
      }
      if (b === 0x3e) {
        this.pos += 2;
        return { kind: 'delimiter', value: '>>' };
      }
      if (b === 0x5b || b === 0x5d || b === 0x7b || b === 0x7d) {
        this.pos += 1;
        return { kind: 'delimiter', value: String.fromCharCode(b) as '[' | ']' | '{' | '}' };
      }
      return this.keyword();
    }
  }

  private number(): Token {
    const start = this.pos;
    const { bytes } = this;
    while (this.pos < bytes.length && isRegular(bytes[this.pos] ?? 0)) this.pos += 1;
    const text = latin1(bytes.subarray(start, this.pos));
    if (/^[+-.]+$/.test(text)) {
      // A sign or dot on its own is read as zero, as the common readers do.
      return { kind: 'number', value: 0 };
    }
    if (!/^[+-.0-9]/.test(text) || !/^[+-.0-9]+$/.test(text)) {
      // Something like "12abc": a keyword that starts with a digit.
      return { kind: 'keyword', value: text };
    }
    return { kind: 'number', value: parseNumber(text) };
  }

  private name(): Token {
    const { bytes } = this;
    this.pos += 1;
    let out = '';
    while (this.pos < bytes.length) {
      const b = bytes[this.pos] ?? 0;
      if (!isRegular(b)) break;
      this.pos += 1;
      if (b === 0x23) {
        const hi = hexValue(bytes[this.pos] ?? 0);
        const lo = hexValue(bytes[this.pos + 1] ?? 0);
        if (hi >= 0 && lo >= 0) {
          out += String.fromCharCode(hi * 16 + lo);
          this.pos += 2;
          continue;
        }
      }
      out += String.fromCharCode(b);
    }
    return { kind: 'name', name: out };
  }

  private keyword(): Token {
    const start = this.pos;
    const { bytes } = this;
    while (this.pos < bytes.length && isRegular(bytes[this.pos] ?? 0)) this.pos += 1;
    if (this.pos === start) {
      // A delimiter the branches above did not take; consume one byte so the lexer moves on.
      this.pos += 1;
      return { kind: 'keyword', value: String.fromCharCode(bytes[start] ?? 0) };
    }
    return { kind: 'keyword', value: latin1(bytes.subarray(start, this.pos)) };
  }

  private literalString(): Token {
    const { bytes } = this;
    this.pos += 1;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < bytes.length) {
      let b = bytes[this.pos] ?? 0;
      this.pos += 1;
      if (b === 0x5c) {
        if (this.pos >= bytes.length) break;
        b = bytes[this.pos] ?? 0;
        this.pos += 1;
        switch (b) {
          case 0x6e:
            out.push(0x0a);
            break;
          case 0x72:
            out.push(0x0d);
            break;
          case 0x74:
            out.push(0x09);
            break;
          case 0x62:
            out.push(0x08);
            break;
          case 0x66:
            out.push(0x0c);
            break;
          case 0x0d:
            if (bytes[this.pos] === 0x0a) this.pos += 1;
            break;
          case 0x0a:
            break;
          default:
            if (b >= 0x30 && b <= 0x37) {
              let code = b - 0x30;
              for (let n = 0; n < 2; n += 1) {
                const next = bytes[this.pos] ?? 0;
                if (next < 0x30 || next > 0x37) break;
                code = code * 8 + (next - 0x30);
                this.pos += 1;
              }
              out.push(code & 0xff);
            } else out.push(b);
        }
        continue;
      }
      if (b === 0x28) depth += 1;
      else if (b === 0x29) {
        depth -= 1;
        if (depth === 0) return { kind: 'string', bytes: Uint8Array.from(out) };
      } else if (b === 0x0d) {
        // An end-of-line inside a literal is one line feed whatever form it takes.
        if (bytes[this.pos] === 0x0a) this.pos += 1;
        out.push(0x0a);
        continue;
      }
      out.push(b);
    }
    throw new PdfError('A string literal is not closed before the file ends', 'corrupt');
  }

  private hexString(): Token {
    const { bytes } = this;
    this.pos += 1;
    const out: number[] = [];
    let pending = -1;
    while (this.pos < bytes.length) {
      const b = bytes[this.pos] ?? 0;
      this.pos += 1;
      if (b === 0x3e) {
        if (pending >= 0) out.push(pending * 16);
        return { kind: 'string', bytes: Uint8Array.from(out) };
      }
      if (isWhitespace(b)) continue;
      const v = hexValue(b);
      if (v < 0) {
        throw new PdfError(
          `A hexadecimal string holds "${String.fromCharCode(b)}", which is not a hexadecimal digit`,
          'corrupt',
        );
      }
      if (pending < 0) pending = v;
      else {
        out.push(pending * 16 + v);
        pending = -1;
      }
    }
    throw new PdfError('A hexadecimal string is not closed before the file ends', 'corrupt');
  }
}

export interface ParseOptions {
  /** The deepest nesting of arrays and dictionaries accepted. */
  maxDepth: number;
  /** Whether `n g R` references are recognized (file objects) or not (content streams, CMaps). */
  allowRefs: boolean;
  /**
   * Resolves an indirect /Length when a stream's dictionary holds a reference; absent, or when it
   * returns null, the stream's end is found by searching for `endstream`.
   */
  resolveLength?: (ref: PdfRef) => number | null;
}

/** The object parser. One instance per byte array; `parse()` reads the object at the lexer position. */
export class Parser {
  readonly lexer: Lexer;

  constructor(
    bytes: Uint8Array,
    readonly options: ParseOptions,
    pos = 0,
  ) {
    this.lexer = new Lexer(bytes, pos);
  }

  get pos(): number {
    return this.lexer.pos;
  }

  set pos(value: number) {
    this.lexer.pos = value;
  }

  /** Parses the next object; at the end of input returns an `op` of `eof` only in content mode. */
  parse(depth = 0): PdfObject | undefined {
    const token = this.lexer.next();
    return this.fromToken(token, depth);
  }

  private fromToken(token: Token, depth: number): PdfObject | undefined {
    if (token.kind === 'delimiter' && (token.value === '[' || token.value === '<<')) {
      // `depth` counts the containers already open; this one makes depth + 1.
      if (depth + 1 > this.options.maxDepth) {
        throw new PdfError(
          `An object is nested deeper than the ${this.options.maxDepth} levels the reader accepts`,
          'too_large',
        );
      }
    }
    switch (token.kind) {
      case 'eof':
        return undefined;
      case 'number':
        return this.options.allowRefs ? this.numberOrRef(token.value) : token.value;
      case 'string':
        return string(token.bytes);
      case 'name':
        return name(token.name);
      case 'delimiter':
        switch (token.value) {
          case '[':
            return this.array(depth);
          case '<<':
            return this.dictOrStream(depth);
          case ']':
          case '>>':
          case '{':
          case '}':
            if (this.options.allowRefs) {
              throw new PdfError(`The file holds an unexpected "${token.value}"`, 'corrupt');
            }
            return { kind: 'op', op: token.value };
          default:
            return undefined;
        }
      case 'keyword':
        if (token.value === 'true') return true;
        if (token.value === 'false') return false;
        if (token.value === 'null') return null;
        if (this.options.allowRefs) {
          throw new PdfError(
            `The file holds the keyword "${token.value}" where an object was expected`,
            'corrupt',
          );
        }
        return { kind: 'op', op: token.value };
      default:
        return undefined;
    }
  }

  private numberOrRef(value: number): PdfObject {
    if (!Number.isInteger(value) || value < 0) return value;
    const saved = this.lexer.pos;
    const second = this.lexer.next();
    if (second.kind === 'number' && Number.isInteger(second.value) && second.value >= 0) {
      const third = this.lexer.next();
      if (third.kind === 'keyword' && third.value === 'R') return ref(value, second.value);
    }
    this.lexer.pos = saved;
    return value;
  }

  private array(depth: number): PdfArray {
    const items: PdfObject[] = [];
    for (;;) {
      const token = this.lexer.next();
      if (token.kind === 'eof')
        throw new PdfError('An array is not closed before the file ends', 'corrupt');
      if (token.kind === 'delimiter' && token.value === ']') return array(items);
      if (token.kind === 'delimiter' && token.value === '>>' && this.options.allowRefs) {
        // A damaged array in a file object; close it where the enclosing dictionary ends.
        this.lexer.pos -= 2;
        return array(items);
      }
      const item = this.fromToken(token, depth + 1);
      if (item === undefined)
        throw new PdfError('An array is not closed before the file ends', 'corrupt');
      items.push(item);
    }
  }

  private dictOrStream(depth: number): PdfDict | PdfStream {
    const map = new Map<string, PdfObject>();
    for (;;) {
      const token = this.lexer.next();
      if (token.kind === 'eof')
        throw new PdfError('A dictionary is not closed before the file ends', 'corrupt');
      if (token.kind === 'delimiter' && token.value === '>>') break;
      if (token.kind !== 'name') {
        if (this.options.allowRefs) {
          throw new PdfError('A dictionary holds a key that is not a name', 'corrupt');
        }
        // Content streams and CMaps carry loose dictionaries; skip the stray value.
        continue;
      }
      const valueToken = this.lexer.next();
      if (valueToken.kind === 'delimiter' && valueToken.value === '>>') {
        map.set(token.name, null);
        break;
      }
      const value = this.fromToken(valueToken, depth + 1);
      if (value === undefined)
        throw new PdfError('A dictionary is not closed before the file ends', 'corrupt');
      if (isOperator(value)) continue;
      map.set(token.name, value);
    }
    const result: PdfDict = { kind: 'dict', map };
    if (!this.options.allowRefs) return result;
    const saved = this.lexer.pos;
    const after = this.lexer.next();
    if (after.kind === 'keyword' && after.value === 'stream') return this.stream(result);
    this.lexer.pos = saved;
    return result;
  }

  private stream(streamDict: PdfDict): PdfStream {
    const { bytes } = this.lexer;
    let start = this.lexer.pos;
    if (bytes[start] === 0x0d) start += 1;
    if (bytes[start] === 0x0a) start += 1;
    let length: number | null = null;
    const declared = streamDict.map.get('Length');
    if (typeof declared === 'number') length = declared;
    else if (declared !== undefined && isRef(declared) && this.options.resolveLength) {
      length = this.options.resolveLength(declared);
    }
    let end = -1;
    if (
      length !== null &&
      Number.isInteger(length) &&
      length >= 0 &&
      start + length <= bytes.length
    ) {
      const probe = new Lexer(bytes, start + length);
      const token = probe.next();
      if (token.kind === 'keyword' && token.value === 'endstream') {
        end = start + length;
        this.lexer.pos = probe.pos;
      }
    }
    if (end < 0) {
      // The /Length is missing or wrong: the stream ends where "endstream" is found.
      const marker = findEndstream(bytes, start);
      if (marker < 0) throw new PdfError('A stream has no endstream keyword', 'corrupt');
      end = marker;
      if (bytes[end - 1] === 0x0a) end -= 1;
      if (bytes[end - 1] === 0x0d) end -= 1;
      this.lexer.pos = marker + 'endstream'.length;
    }
    return { kind: 'stream', dict: streamDict, raw: bytes.subarray(start, end) };
  }
}

function findEndstream(bytes: Uint8Array, from: number): number {
  const word = 'endstream';
  const first = word.charCodeAt(0);
  for (let i = from; i + word.length <= bytes.length; i += 1) {
    if (bytes[i] !== first) continue;
    let match = true;
    for (let k = 1; k < word.length; k += 1) {
      if (bytes[i + k] !== word.charCodeAt(k)) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/** Reads `num gen obj` at `pos` and returns the numbers and the position after `obj`, or null. */
export function readObjectHeader(
  bytes: Uint8Array,
  pos: number,
): { num: number; gen: number; after: number } | null {
  const lexer = new Lexer(bytes, pos);
  const a = lexer.next();
  if (a.kind !== 'number' || !Number.isInteger(a.value) || a.value < 0) return null;
  const b = lexer.next();
  if (b.kind !== 'number' || !Number.isInteger(b.value) || b.value < 0) return null;
  const c = lexer.next();
  if (c.kind !== 'keyword' || c.value !== 'obj') return null;
  return { num: a.value, gen: b.value, after: lexer.pos };
}
