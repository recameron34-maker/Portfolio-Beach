/**
 * Fonts (ISO 32000-1 section 9): a font dictionary becomes a `LoadedFont` that splits a string
 * into codes, gives the text of each code and its advance width. Simple fonts (Type1, MMType1,
 * TrueType, Type3) decode through their encoding (StandardEncoding, WinAnsiEncoding,
 * MacRomanEncoding, a /Differences array, the standard encoding by default for a non-symbolic
 * font) and the glyph list; Type0 fonts decode through their ToUnicode CMap only. A ToUnicode
 * map, when present, is consulted first for every font, since it states what the writer meant.
 * A code neither the map nor the encoding covers decodes to null: the run is reported as
 * undecodable, never guessed. Widths come from /Widths (simple fonts), /W and /DW (CID fonts)
 * or the standard 14 metrics by base font name; a Type3 font's widths go through its
 * /FontMatrix. Font programs (FontFile streams) are never opened.
 */
import { identityCMap, parseCMap, type CMap, type Code } from './cmap.js';
import { STANDARD_ENCODING, encodingByName, glyphToText, type Encoding } from './encodings.js';
import { standardFontFor, standardWidths, type WidthTable } from './metrics.js';
import { isArray, isDict, isName, isNumber, isStream, type PdfDict } from './objects.js';
import type { PdfFile } from './xref.js';

export interface LoadedFont {
  /** The base font name without its subset tag, or the resource name when the font has none. */
  name: string;
  /** Splits a string operand into codes. */
  codes(bytes: Uint8Array): Code[];
  /** The text of a code, or null when the font cannot decode it. */
  text(code: Code): string | null;
  /** The horizontal advance of a code in text space units (glyph space over 1000, or through the Type3 matrix). */
  width(code: Code): number;
  /** Whether the code is the single-byte code 32, to which word spacing applies. */
  isWordSpace(code: Code): boolean;
}

const FLAG_SYMBOLIC = 1 << 2;
const FLAG_NONSYMBOLIC = 1 << 5;

function stripSubset(name: string): string {
  return /^[A-Z]{6}\+/.test(name) ? name.slice(7) : name;
}

async function toUnicodeOf(file: PdfFile, dict: PdfDict): Promise<CMap | null> {
  const stream = await file.get(dict, 'ToUnicode');
  if (!isStream(stream)) return null;
  const map = parseCMap(await file.streamData(stream), file.limits.maxDepth);
  return map.hasText ? map : null;
}

async function numberOf(
  file: PdfFile,
  dict: PdfDict | null,
  key: string,
  fallback: number,
): Promise<number> {
  const value = await file.get(dict, key);
  return isNumber(value) ? value : fallback;
}

/** The glyph name of each code from the font's /Encoding, with /Differences applied. */
async function simpleEncoding(
  file: PdfFile,
  dict: PdfDict,
  symbolic: boolean,
  standard: boolean,
  type3: boolean,
): Promise<Encoding> {
  const encoding = await file.get(dict, 'Encoding');
  let base: Encoding | null = null;
  let differences: PdfDict | null = null;
  if (isName(encoding)) base = encodingByName(encoding.name);
  else if (isDict(encoding)) {
    const named = await file.get(encoding, 'BaseEncoding');
    if (isName(named)) base = encodingByName(named.name);
    differences = encoding;
  }
  // A non-symbolic font, or one of the standard text faces, has the standard encoding built in;
  // a symbolic font's built-in encoding lives in its program, which the reader does not open.
  base ??= type3 || (symbolic && !standard) ? [] : STANDARD_ENCODING;
  const out: (string | undefined)[] = Array.from({ length: 256 }, (_, code) => base[code]);
  if (differences) {
    const list = await file.get(differences, 'Differences');
    if (isArray(list)) {
      let code = 0;
      for (const item of list.items) {
        const resolved = await file.resolve(item);
        if (isNumber(resolved)) code = Math.trunc(resolved);
        else if (isName(resolved)) {
          if (code >= 0 && code < 256) out[code] = resolved.name;
          code += 1;
        }
      }
    }
  }
  return out;
}

async function simpleWidths(
  file: PdfFile,
  dict: PdfDict,
  descriptor: PdfDict | null,
): Promise<{ firstChar: number; widths: number[]; missing: number } | null> {
  const widths = await file.get(dict, 'Widths');
  if (!isArray(widths) || widths.items.length === 0) return null;
  const firstChar = await numberOf(file, dict, 'FirstChar', 0);
  const missing = await numberOf(file, descriptor, 'MissingWidth', 0);
  const values: number[] = [];
  for (const item of widths.items) {
    const value = await file.resolve(item);
    values.push(isNumber(value) ? value : missing);
  }
  return { firstChar: Math.trunc(firstChar), widths: values, missing };
}

async function loadSimple(
  file: PdfFile,
  dict: PdfDict,
  resourceName: string,
  subtype: string,
): Promise<LoadedFont> {
  const baseFontObject = await file.get(dict, 'BaseFont');
  const baseFont = isName(baseFontObject) ? baseFontObject.name : '';
  const name = baseFont === '' ? resourceName : stripSubset(baseFont);
  const descriptorObject = await file.get(dict, 'FontDescriptor');
  const descriptor = isDict(descriptorObject) ? descriptorObject : null;
  const flags = await numberOf(file, descriptor, 'Flags', 0);
  const symbolic = (flags & FLAG_SYMBOLIC) !== 0 && (flags & FLAG_NONSYMBOLIC) === 0;
  const standardName = standardFontFor(baseFont);
  const type3 = subtype === 'Type3';
  const encoding = await simpleEncoding(file, dict, symbolic, standardName !== null, type3);
  const toUnicode = await toUnicodeOf(file, dict);
  const explicit = await simpleWidths(file, dict, descriptor);
  const table: WidthTable | null = explicit ? null : standardWidths(baseFont);
  let matrixScale = 0.001;
  if (type3) {
    const matrix = await file.get(dict, 'FontMatrix');
    const a = isArray(matrix) ? await file.resolve(matrix.items[0] ?? null) : null;
    matrixScale = isNumber(a) ? a : 0.001;
  }
  const scale = (value: number): number => (type3 ? value * matrixScale : value / 1000);
  return {
    name,
    codes: (bytes) => Array.from(bytes, (code) => ({ code, length: 1 })),
    text: (code) => {
      const mapped = toUnicode?.text(code) ?? null;
      if (mapped !== null) return mapped;
      const glyph = encoding[code.code];
      return glyph === undefined ? null : glyphToText(glyph);
    },
    width: (code) => {
      if (explicit) {
        const index = code.code - explicit.firstChar;
        const value = explicit.widths[index];
        return scale(value ?? explicit.missing);
      }
      if (table) {
        const glyph = encoding[code.code];
        const value = glyph === undefined ? null : table.width(glyph);
        return scale(value ?? 0);
      }
      return 0;
    },
    isWordSpace: (code) => code.length === 1 && code.code === 32,
  };
}

/** The /W array of a CID font: `c [w1 w2 ...]` and `cfirst clast w` forms, into a map by CID. */
async function cidWidths(file: PdfFile, descendant: PdfDict): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const w = await file.get(descendant, 'W');
  if (!isArray(w)) return out;
  const items: (number | number[] | null)[] = [];
  for (const item of w.items) {
    const resolved = await file.resolve(item);
    if (isNumber(resolved)) items.push(resolved);
    else if (isArray(resolved)) {
      const list: number[] = [];
      for (const inner of resolved.items) {
        const value = await file.resolve(inner);
        list.push(isNumber(value) ? value : 0);
      }
      items.push(list);
    } else items.push(null);
  }
  let i = 0;
  while (i < items.length) {
    const first = items[i];
    if (typeof first !== 'number') {
      i += 1;
      continue;
    }
    const second = items[i + 1];
    if (Array.isArray(second)) {
      second.forEach((width, k) => out.set(Math.trunc(first) + k, width));
      i += 2;
    } else if (typeof second === 'number' && typeof items[i + 2] === 'number') {
      const last = Math.trunc(second);
      const width = items[i + 2] as number;
      const start = Math.trunc(first);
      if (last >= start && last - start <= 65_535) {
        for (let cid = start; cid <= last; cid += 1) out.set(cid, width);
      }
      i += 3;
    } else i += 1;
  }
  return out;
}

async function loadType0(file: PdfFile, dict: PdfDict, resourceName: string): Promise<LoadedFont> {
  const baseFontObject = await file.get(dict, 'BaseFont');
  const baseFont = isName(baseFontObject) ? baseFontObject.name : '';
  const name = baseFont === '' ? resourceName : stripSubset(baseFont);
  const descendants = await file.get(dict, 'DescendantFonts');
  const descendantObject = isArray(descendants)
    ? await file.resolve(descendants.items[0] ?? null)
    : null;
  const descendant = isDict(descendantObject) ? descendantObject : null;
  const encodingObject = await file.get(dict, 'Encoding');
  let encoding: CMap | null = null;
  if (isName(encodingObject)) {
    if (encodingObject.name === 'Identity-H' || encodingObject.name === 'Identity-V')
      encoding = identityCMap();
  } else if (isStream(encodingObject)) {
    encoding = parseCMap(await file.streamData(encodingObject), file.limits.maxDepth);
  }
  const toUnicode = await toUnicodeOf(file, dict);
  const widths = descendant ? await cidWidths(file, descendant) : new Map<number, number>();
  const defaultWidth = await numberOf(file, descendant, 'DW', 1000);
  // Codes are split by the encoding CMap when the reader has it, else by the ToUnicode map's
  // codespace (a predefined CMap other than Identity is not bundled), else two bytes at a time.
  const splitter = encoding ?? toUnicode ?? identityCMap();
  return {
    name,
    codes: (bytes) => splitter.split(bytes),
    text: (code) => toUnicode?.text(code) ?? null,
    width: (code) => {
      // Without a CID mapping the code itself is taken as the CID (true for Identity, the common case).
      const cid = encoding?.cid(code) ?? code.code;
      return (widths.get(cid) ?? defaultWidth) / 1000;
    },
    isWordSpace: (code) => code.length === 1 && code.code === 32,
  };
}

/** A font that decodes nothing and advances nothing: for a missing or damaged font resource. */
export function undecodableFont(name: string): LoadedFont {
  return {
    name,
    codes: (bytes) => Array.from(bytes, (code) => ({ code, length: 1 })),
    text: () => null,
    width: () => 0,
    isWordSpace: (code) => code.length === 1 && code.code === 32,
  };
}

/** Loads a font dictionary. Fonts are cached per dictionary object by the caller. */
export async function loadFont(
  file: PdfFile,
  dict: PdfDict,
  resourceName: string,
): Promise<LoadedFont> {
  const subtypeObject = await file.get(dict, 'Subtype');
  const subtype = isName(subtypeObject) ? subtypeObject.name : '';
  if (subtype === 'Type0') return loadType0(file, dict, resourceName);
  return loadSimple(file, dict, resourceName, subtype);
}
