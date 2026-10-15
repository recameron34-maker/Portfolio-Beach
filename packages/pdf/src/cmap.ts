/**
 * CMaps (ISO 32000-1 sections 9.7.5 and 9.10.3): the ToUnicode map of a font (`bfchar` and
 * `bfrange`, the latter with a destination string or an array of them) and an embedded
 * encoding CMap of a Type0 font (`codespacerange`, `cidchar`, `cidrange`). The codespace ranges
 * say how many bytes each code takes, which is how a string is split into codes. Predefined
 * CMaps are not bundled: `Identity-H` and `Identity-V` are two-byte identity maps, and any other
 * name is unknown (the font then splits by its ToUnicode codespace, see `fonts.ts`).
 */
import { decodeUtf16be } from './bytes.js';
import { glyphToText } from './encodings.js';
import { PdfError } from './errors.js';
import {
  Parser,
  isArray,
  isName,
  isNumber,
  isOperator,
  isString,
  type PdfObject,
} from './objects.js';

export interface CodespaceRange {
  bytes: number;
  low: number;
  high: number;
}

interface TextRange {
  bytes: number;
  low: number;
  high: number;
  /** The text of `low`; later codes add their offset to its last code unit. */
  text: string;
}

interface CidRange {
  low: number;
  high: number;
  cid: number;
}

export interface Code {
  code: number;
  /** How many bytes the code took in the string. */
  length: number;
}

/** The most mappings one CMap may hold; more is not a font, it is a hostile file. */
const MAX_MAPPINGS = 65_536 * 4;

export class CMap {
  readonly codespace: CodespaceRange[] = [];
  private readonly singles = new Map<string, string>();
  private readonly ranges: TextRange[] = [];
  private readonly cidSingles = new Map<number, number>();
  private readonly cidRanges: CidRange[] = [];
  /** True for Identity-H and Identity-V. */
  identity = false;
  private mappings = 0;

  /** The byte lengths the map uses, from its codespace ranges or, without them, its mappings. */
  private lengths: number[] = [];

  private count(): void {
    this.mappings += 1;
    if (this.mappings > MAX_MAPPINGS) {
      throw new PdfError('A CMap holds more mappings than the reader accepts', 'too_large');
    }
  }

  addCodespace(bytes: number, low: number, high: number): void {
    this.count();
    this.codespace.push({ bytes, low, high });
    this.lengths = [];
  }

  addSingle(bytes: number, code: number, text: string): void {
    this.count();
    this.singles.set(`${bytes}:${code}`, text);
    this.lengths = [];
  }

  addRange(bytes: number, low: number, high: number, text: string): void {
    this.count();
    this.ranges.push({ bytes, low, high, text });
    this.lengths = [];
  }

  addCid(code: number, cid: number): void {
    this.count();
    this.cidSingles.set(code, cid);
  }

  addCidRange(low: number, high: number, cid: number): void {
    this.count();
    this.cidRanges.push({ low, high, cid });
  }

  /** Whether the map has any text mapping at all. */
  get hasText(): boolean {
    return this.singles.size > 0 || this.ranges.length > 0;
  }

  /** The text of a code, or null when the map does not cover it. */
  text(code: Code): string | null {
    const single = this.singles.get(`${code.length}:${code.code}`);
    if (single !== undefined) return single;
    for (const range of this.ranges) {
      if (range.bytes === code.length && code.code >= range.low && code.code <= range.high) {
        return offsetText(range.text, code.code - range.low);
      }
    }
    return null;
  }

  /** The CID of a code: identity for the Identity maps, else from the cid mappings, else null. */
  cid(code: Code): number | null {
    if (this.identity) return code.code;
    const single = this.cidSingles.get(code.code);
    if (single !== undefined) return single;
    for (const range of this.cidRanges) {
      if (code.code >= range.low && code.code <= range.high)
        return range.cid + (code.code - range.low);
    }
    return null;
  }

  private byteLengths(): number[] {
    if (this.lengths.length > 0) return this.lengths;
    const set = new Set<number>();
    for (const range of this.codespace) set.add(range.bytes);
    if (set.size === 0) {
      for (const key of this.singles.keys()) set.add(Number(key.split(':')[0]));
      for (const range of this.ranges) set.add(range.bytes);
    }
    if (set.size === 0) set.add(this.identity ? 2 : 1);
    this.lengths = [...set].sort((a, b) => a - b);
    return this.lengths;
  }

  /**
   * Splits a string into codes: at each position the shortest codespace range that holds the
   * bytes wins; when none does, the shortest byte length the map uses is taken, as the
   * specification's partial-match rule leads to, and the code comes back unmapped.
   */
  split(bytes: Uint8Array): Code[] {
    const lengths = this.byteLengths();
    const out: Code[] = [];
    let i = 0;
    while (i < bytes.length) {
      let taken: Code | null = null;
      for (const length of lengths) {
        if (i + length > bytes.length) break;
        const code = codeAt(bytes, i, length);
        if (this.codespace.length === 0 || this.inCodespace(code, length)) {
          taken = { code, length };
          break;
        }
      }
      if (!taken) {
        const length = Math.min(lengths[0] ?? 1, bytes.length - i);
        taken = { code: codeAt(bytes, i, length), length };
      }
      out.push(taken);
      i += taken.length;
    }
    return out;
  }

  private inCodespace(code: number, length: number): boolean {
    for (const range of this.codespace) {
      if (range.bytes === length && code >= range.low && code <= range.high) return true;
    }
    return false;
  }
}

function codeAt(bytes: Uint8Array, at: number, length: number): number {
  let code = 0;
  for (let k = 0; k < length; k += 1) code = code * 256 + (bytes[at + k] ?? 0);
  return code;
}

/** `text` with `offset` added to its last UTF-16 code unit (how `bfrange` destinations advance). */
function offsetText(text: string, offset: number): string {
  if (offset === 0 || text.length === 0) return text;
  const last = text.charCodeAt(text.length - 1) + offset;
  if (last > 0xffff) return text;
  return text.slice(0, -1) + String.fromCharCode(last);
}

/** A two-byte identity map. */
export function identityCMap(): CMap {
  const map = new CMap();
  map.identity = true;
  map.addCodespace(2, 0, 0xffff);
  return map;
}

function bytesToCode(bytes: Uint8Array): { code: number; length: number } | null {
  if (bytes.length === 0 || bytes.length > 4) return null;
  return { code: codeAt(bytes, 0, bytes.length), length: bytes.length };
}

/** The text a `bf` destination stands for: UTF-16BE bytes, a glyph name, or a number as a code unit. */
function destinationText(object: PdfObject): string | null {
  if (isString(object)) {
    const { bytes } = object;
    if (bytes.length % 2 === 1) {
      // A single byte or an odd run: the common readers take each byte as a code unit.
      let out = '';
      for (const b of bytes) out += String.fromCharCode(b);
      return out;
    }
    try {
      return decodeUtf16be(bytes, 'A CMap destination');
    } catch {
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
      }
      return out;
    }
  }
  if (isName(object)) return glyphToText(object.name);
  if (isNumber(object) && Number.isInteger(object) && object >= 0 && object <= 0x10ffff) {
    return String.fromCodePoint(object);
  }
  return null;
}

/**
 * Parses a CMap program. Operators the reader does not use (`def`, `findresource`, `usecmap` of
 * a predefined map other than Identity) are skipped with their operands; nothing is executed.
 */
export function parseCMap(data: Uint8Array, maxDepth: number): CMap {
  const map = new CMap();
  const parser = new Parser(data, { maxDepth, allowRefs: false });
  let stack: PdfObject[] = [];
  const next = (): PdfObject | undefined => parser.parse();
  const readUntil = (end: string): PdfObject[] => {
    const items: PdfObject[] = [];
    for (;;) {
      const item = next();
      if (item === undefined) throw new PdfError(`A CMap section has no ${end}`, 'corrupt');
      if (isOperator(item)) {
        if (item.op === end) return items;
        continue;
      }
      items.push(item);
    }
  };
  for (let object = next(); object !== undefined; object = next()) {
    if (!isOperator(object)) {
      stack.push(object);
      if (stack.length > 64) stack = stack.slice(-64);
      continue;
    }
    switch (object.op) {
      case 'begincodespacerange': {
        const items = readUntil('endcodespacerange');
        for (let i = 0; i + 1 < items.length; i += 2) {
          const low = items[i];
          const high = items[i + 1];
          if (!isString(low) || !isString(high)) continue;
          const a = bytesToCode(low.bytes);
          const b = bytesToCode(high.bytes);
          if (!a || !b) continue;
          map.addCodespace(a.length, a.code, b.code);
        }
        break;
      }
      case 'beginbfchar': {
        const items = readUntil('endbfchar');
        for (let i = 0; i + 1 < items.length; i += 2) {
          const src = items[i];
          if (!isString(src)) continue;
          const code = bytesToCode(src.bytes);
          const text = destinationText(items[i + 1] ?? null);
          if (!code || text === null) continue;
          map.addSingle(code.length, code.code, text);
        }
        break;
      }
      case 'beginbfrange': {
        const items = readUntil('endbfrange');
        for (let i = 0; i + 2 < items.length; i += 3) {
          const low = items[i];
          const high = items[i + 1];
          const dst = items[i + 2] ?? null;
          if (!isString(low) || !isString(high)) continue;
          const a = bytesToCode(low.bytes);
          const b = bytesToCode(high.bytes);
          if (!a || !b || b.code < a.code) continue;
          if (isArray(dst)) {
            dst.items.forEach((item, k) => {
              if (a.code + k > b.code) return;
              const text = destinationText(item);
              if (text !== null) map.addSingle(a.length, a.code + k, text);
            });
          } else {
            const text = destinationText(dst);
            if (text !== null) map.addRange(a.length, a.code, b.code, text);
          }
        }
        break;
      }
      case 'begincidchar': {
        const items = readUntil('endcidchar');
        for (let i = 0; i + 1 < items.length; i += 2) {
          const src = items[i];
          const cid = items[i + 1];
          if (!isString(src) || !isNumber(cid)) continue;
          const code = bytesToCode(src.bytes);
          if (code) map.addCid(code.code, cid);
        }
        break;
      }
      case 'begincidrange': {
        const items = readUntil('endcidrange');
        for (let i = 0; i + 2 < items.length; i += 3) {
          const low = items[i];
          const high = items[i + 1];
          const cid = items[i + 2];
          if (!isString(low) || !isString(high) || !isNumber(cid)) continue;
          const a = bytesToCode(low.bytes);
          const b = bytesToCode(high.bytes);
          if (a && b && b.code >= a.code) map.addCidRange(a.code, b.code, cid);
        }
        break;
      }
      case 'usecmap': {
        const parent = stack[stack.length - 1];
        if (isName(parent) && (parent.name === 'Identity-H' || parent.name === 'Identity-V')) {
          map.identity = true;
          if (map.codespace.length === 0) map.addCodespace(2, 0, 0xffff);
        }
        break;
      }
      default:
        break;
    }
    stack = [];
  }
  return map;
}
