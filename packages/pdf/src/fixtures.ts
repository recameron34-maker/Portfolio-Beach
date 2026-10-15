/**
 * Builders for hand-made test files: objects assembled with a classic cross-reference table, a
 * cross-reference stream, or no cross-reference data at all, and incremental updates appended
 * with /Prev. Tests across the package use them; nothing at runtime does. No Node import, so the
 * file compiles with the rest of the package.
 */
import { concatBytes, encodeUtf8 } from './bytes.js';

export interface FixtureObject {
  num: number;
  /** The object body: a dictionary, or a dictionary followed by `stream ... endstream`. */
  body: string | Uint8Array;
}

/** A stream body with its /Length filled in. */
export function streamBody(entries: string, data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
  return concatBytes([
    encodeUtf8(`<< ${entries} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    encodeUtf8('\nendstream'),
  ]);
}

/** A page content stream of the operators given. */
export function content(operators: string): Uint8Array {
  return streamBody('', operators);
}

const pad10 = (n: number): string => n.toString().padStart(10, '0');

function objectBytes(object: FixtureObject): Uint8Array {
  const body = typeof object.body === 'string' ? encodeUtf8(object.body) : object.body;
  return concatBytes([encodeUtf8(`${object.num} 0 obj\n`), body, encodeUtf8('\nendobj\n')]);
}

export interface AssembleOptions {
  version?: string;
  /** Trailer entries other than /Size (`/Root 1 0 R /Info 5 0 R`). */
  trailer: string;
  /** How the objects are indexed: a classic table (default), a cross-reference stream, or nothing. */
  xref?: 'table' | 'stream' | 'none';
  /** Bytes placed before the header (junk some writers leave). */
  prefix?: Uint8Array;
  /** For `xref: 'stream'`: the object number of the stream (default: one past the highest). */
  xrefStreamNum?: number;
  /** For `xref: 'stream'`: encode the rows with the PNG up predictor and deflate them. */
  xrefStreamEncode?: { deflate: (data: Uint8Array) => Uint8Array; predictor: boolean };
  /** For `xref: 'table'`: write a wrong offset for this object number (to force the fallback scan). */
  wrongOffsetFor?: number;
  /** Write `startxref` pointing at this offset instead of the real one. */
  startxrefOverride?: number;
}

/** PNG "up" filtering of fixed-width rows (filter type byte 2 before each row). */
export function pngUpEncode(rows: readonly Uint8Array[], rowLength: number): Uint8Array {
  const out: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array(rowLength);
  for (const row of rows) {
    const encoded = new Uint8Array(rowLength + 1);
    encoded[0] = 2;
    for (let i = 0; i < rowLength; i += 1)
      encoded[i + 1] = ((row[i] ?? 0) - (previous[i] ?? 0)) & 0xff;
    out.push(encoded);
    previous = row;
  }
  return concatBytes(out);
}

/** Assembles a file from objects. Offsets are computed from the bytes as written. */
export function assemble(objects: readonly FixtureObject[], options: AssembleOptions): Uint8Array {
  const version = options.version ?? '1.4';
  const parts: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => {
    parts.push(bytes);
    offset += bytes.length;
  };
  if (options.prefix) push(options.prefix);
  const base = offset;
  push(encodeUtf8(`%PDF-${version}\n%âãÏÓ\n`));
  const offsets = new Map<number, number>();
  for (const object of objects) {
    offsets.set(object.num, offset - base);
    push(objectBytes(object));
  }
  const highest = Math.max(0, ...objects.map((o) => o.num));
  const mode = options.xref ?? 'table';
  let startxref = offset - base;
  if (mode === 'table') {
    const size = highest + 1;
    let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let num = 1; num < size; num += 1) {
      const at = offsets.get(num);
      if (at === undefined) table += '0000000000 00000 f \n';
      else table += `${pad10(options.wrongOffsetFor === num ? at + 7 : at)} 00000 n \n`;
    }
    push(encodeUtf8(`${table}trailer\n<< /Size ${size} ${options.trailer} >>\n`));
  } else if (mode === 'stream') {
    const num = options.xrefStreamNum ?? highest + 1;
    const size = Math.max(num, highest) + 1;
    const rows: Uint8Array[] = [];
    for (let n = 0; n < size; n += 1) {
      const row = new Uint8Array(6);
      const at = n === num ? offset - base : offsets.get(n);
      if (n === 0 || at === undefined) {
        row[0] = 0;
      } else {
        row[0] = 1;
        row[1] = (at >>> 24) & 0xff;
        row[2] = (at >>> 16) & 0xff;
        row[3] = (at >>> 8) & 0xff;
        row[4] = at & 0xff;
        row[5] = 0;
      }
      rows.push(row);
    }
    let data = concatBytes(rows);
    let entries = `/Type /XRef /Size ${size} /W [1 4 1] ${options.trailer}`;
    if (options.xrefStreamEncode) {
      if (options.xrefStreamEncode.predictor) {
        data = pngUpEncode(rows, 6);
        entries += ' /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 6 >>';
      } else entries += ' /Filter /FlateDecode';
      data = options.xrefStreamEncode.deflate(data);
    }
    startxref = offset - base;
    push(objectBytes({ num, body: streamBody(entries, data) }));
  } else {
    push(encodeUtf8(`trailer\n<< ${options.trailer} >>\n`));
  }
  if (mode !== 'none') {
    push(encodeUtf8(`startxref\n${options.startxrefOverride ?? startxref}\n%%EOF\n`));
  }
  return concatBytes(parts);
}

/**
 * Appends an incremental update: the objects given, a classic table listing only them, a
 * trailer with /Prev pointing at the previous `startxref`, and a new `startxref`.
 */
export function appendUpdate(
  base: Uint8Array,
  objects: readonly FixtureObject[],
  trailer: string,
  options: { xrefStm?: number } = {},
): Uint8Array {
  const text = Array.from(base, (b) => String.fromCharCode(b)).join('');
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  const prev = match ? Number(match[1]) : 0;
  const parts: Uint8Array[] = [base];
  let offset = base.length;
  const push = (bytes: Uint8Array): void => {
    parts.push(bytes);
    offset += bytes.length;
  };
  const offsets = new Map<number, number>();
  for (const object of objects) {
    offsets.set(object.num, offset);
    push(objectBytes(object));
  }
  const startxref = offset;
  let table = 'xref\n';
  for (const [num, at] of offsets) table += `${num} 1\n${pad10(at)} 00000 n \n`;
  const size = Math.max(...objects.map((o) => o.num)) + 1;
  const hybrid = options.xrefStm === undefined ? '' : ` /XRefStm ${options.xrefStm}`;
  push(
    encodeUtf8(
      `${table}trailer\n<< /Size ${size} /Prev ${prev}${hybrid} ${trailer} >>\nstartxref\n${startxref}\n%%EOF\n`,
    ),
  );
  return concatBytes(parts);
}

/** The offset of `N 0 obj` in a file, for tests that point /XRefStm or /Prev at an object. */
export function offsetOf(bytes: Uint8Array, num: number): number {
  const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  const at = text.indexOf(`\n${num} 0 obj`);
  if (at < 0) throw new Error(`object ${num} not found`);
  return at + 1;
}

/** A one-page document with the content given, as the objects a classic file holds. */
export function onePage(
  operators: string,
  extra: { fonts?: string; objects?: FixtureObject[] } = {},
): FixtureObject[] {
  const fonts = extra.fonts ?? '/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  return [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      num: 3,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << ${fonts} >> >> >>`,
    },
    { num: 4, body: content(operators) },
    ...(extra.objects ?? []),
  ];
}
