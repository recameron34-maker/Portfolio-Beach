/**
 * The file structure (ISO 32000-1 section 7.5): the header, the `startxref` pointer, classic
 * cross-reference tables with their trailers and /Prev chains, hybrid files (/XRefStm),
 * cross-reference streams (/W, /Index) and object streams (/Type /ObjStm). `PdfFile` opens a
 * file once and then fetches objects on demand through the table, decoding streams through the
 * injected inflater within the read limits.
 *
 * When the cross-reference data is damaged (no `startxref`, an offset that points at nothing, a
 * table that does not parse, an object that is not where the table says, no /Root), the reader
 * falls back to a linear scan of the file for `N G obj` and `trailer` occurrences, the last
 * occurrence of each object number winning, as every mainstream reader does. The fallback is
 * reported on the file (`reconstructed`) so a caller can log it; it never applies to encryption,
 * limits or unsupported features, which are refused outright.
 */
import {
  bytesAt,
  indexOfBytes,
  isDelimiter,
  isDigit,
  isWhitespace,
  lastIndexOfBytes,
  latin1,
} from './bytes.js';
import { PdfError } from './errors.js';
import { DEFAULT_DECODE_PARMS, applyFilter, type DecodeParms, type Inflate } from './filters.js';
import type { ReadLimits } from './limits.js';
import {
  Lexer,
  Parser,
  isArray,
  isDict,
  isName,
  isNumber,
  isRef,
  isStream,
  readObjectHeader,
  type PdfDict,
  type PdfObject,
  type PdfRef,
  type PdfStream,
} from './objects.js';

export type XrefEntry =
  | { kind: 'offset'; offset: number; gen: number }
  | { kind: 'compressed'; streamNum: number; index: number }
  | { kind: 'free' };

/** The first bytes of the file must hold this within the first 1024 bytes (section 7.5.2). */
const HEADER = '%PDF-';
const HEADER_WINDOW = 1024;

interface ObjectStreamIndex {
  data: Uint8Array;
  first: number;
  entries: { num: number; offset: number }[];
}

export class PdfFile {
  /** The trailer, merged across the chain: the newest section's keys win. */
  readonly trailer: PdfDict = { kind: 'dict', map: new Map() };
  /** The version from the header (`1.4`); the catalog may raise it (see `readPdf`). */
  headerVersion = '1.0';
  /** True when the cross-reference data was damaged and the file was indexed by a linear scan. */
  reconstructed = false;

  private readonly table = new Map<number, XrefEntry>();
  private readonly cache = new Map<number, PdfObject>();
  private readonly objectStreams = new Map<number, ObjectStreamIndex>();
  private readonly decoded = new WeakMap<PdfStream, Uint8Array>();
  private readonly resolving = new Set<number>();
  private totalStreamBytes = 0;
  private fetched = 0;

  private constructor(
    readonly bytes: Uint8Array,
    private readonly inflate: Inflate,
    readonly limits: ReadLimits,
  ) {}

  /** Opens a file: header, cross-reference data (or the fallback scan), trailer checks. */
  static async open(input: Uint8Array, inflate: Inflate, limits: ReadLimits): Promise<PdfFile> {
    if (input.length > limits.maxBytes) {
      throw new PdfError(
        `The file holds ${input.length} bytes, more than the ${limits.maxBytes} the reader accepts`,
        'too_large',
      );
    }
    const headerAt = indexOfBytes(input.subarray(0, HEADER_WINDOW + HEADER.length), HEADER);
    if (headerAt < 0) {
      throw new PdfError(
        'The file does not start with a PDF header, so it is not a PDF',
        'not_pdf',
      );
    }
    // Offsets count from the header, so bytes before it (some writers leave junk there) are dropped.
    const bytes = headerAt === 0 ? input : input.subarray(headerAt);
    const file = new PdfFile(bytes, inflate, limits);
    file.headerVersion = file.readVersion();
    await file.index();
    return file;
  }

  private readVersion(): string {
    const text = latin1(this.bytes.subarray(HEADER.length, HEADER.length + 8));
    const match = /^(\d+\.\d+)/.exec(text);
    return match?.[1] ?? '1.0';
  }

  private async index(): Promise<void> {
    let damaged = false;
    try {
      const start = this.findStartXref();
      if (start === null) damaged = true;
      else await this.readChain(start);
    } catch (error) {
      if (error instanceof PdfError && error.code === 'corrupt') damaged = true;
      else throw error;
    }
    if (!damaged && !isRef(this.trailer.map.get('Root') ?? null)) damaged = true;
    if (damaged) await this.reconstruct();
    this.checkTrailer();
  }

  private checkTrailer(): void {
    if (this.trailer.map.has('Encrypt') && this.trailer.map.get('Encrypt') !== null) {
      throw new PdfError(
        'The document is encrypted; the reader does not open encrypted documents',
        'encrypted',
      );
    }
    const size = this.trailer.map.get('Size');
    if (typeof size === 'number' && size > this.limits.maxObjects) {
      throw new PdfError(
        `The document declares ${size} objects, more than the ${this.limits.maxObjects} the reader accepts`,
        'too_large',
      );
    }
    if (!isRef(this.trailer.map.get('Root') ?? null)) {
      throw new PdfError('The document has no catalog (no /Root in its trailer)', 'corrupt');
    }
  }

  private findStartXref(): number | null {
    const at = lastIndexOfBytes(this.bytes, 'startxref');
    if (at < 0) return null;
    const lexer = new Lexer(this.bytes, at + 'startxref'.length);
    const token = lexer.next();
    if (token.kind !== 'number' || !Number.isInteger(token.value) || token.value < 0) return null;
    return token.value;
  }

  /** Walks the /Prev chain from `start`, newest section first, with /XRefStm hybrids in between. */
  private async readChain(start: number): Promise<void> {
    const visited = new Set<number>();
    const queue: number[] = [start];
    while (queue.length > 0) {
      const offset = queue.shift() ?? 0;
      if (visited.has(offset)) continue;
      visited.add(offset);
      if (offset >= this.bytes.length) {
        throw new PdfError('A cross-reference offset lies outside the file', 'corrupt');
      }
      const trailer = await this.readSection(offset);
      const hybrid = trailer.map.get('XRefStm');
      if (typeof hybrid === 'number' && Number.isInteger(hybrid)) queue.unshift(hybrid);
      const prev = trailer.map.get('Prev');
      if (typeof prev === 'number' && Number.isInteger(prev)) queue.push(prev);
      for (const [key, value] of trailer.map) {
        if (!this.trailer.map.has(key)) this.trailer.map.set(key, value);
      }
    }
  }

  private async readSection(offset: number): Promise<PdfDict> {
    const lexer = new Lexer(this.bytes, offset);
    lexer.skipWhitespace();
    if (bytesAt(this.bytes, lexer.pos, 'xref')) return this.readTable(lexer.pos + 4);
    const header = readObjectHeader(this.bytes, lexer.pos);
    if (header) {
      const parser = new Parser(this.bytes, this.parseOptions(), header.after);
      const object = parser.parse();
      if (isStream(object)) return this.readXrefStream(object);
    }
    throw new PdfError(
      'A cross-reference offset points at neither a table nor a stream',
      'corrupt',
    );
  }

  private setEntry(num: number, entry: XrefEntry): void {
    if (num > this.limits.maxObjects) {
      throw new PdfError(
        `The document numbers an object ${num}, past the ${this.limits.maxObjects} the reader accepts`,
        'too_large',
      );
    }
    if (!this.table.has(num)) {
      this.table.set(num, entry);
      if (this.table.size > this.limits.maxObjects) {
        throw new PdfError(
          `The document lists more than the ${this.limits.maxObjects} objects the reader accepts`,
          'too_large',
        );
      }
    }
  }

  private readTable(pos: number): PdfDict {
    const lexer = new Lexer(this.bytes, pos);
    for (;;) {
      let token = lexer.next();
      if (token.kind === 'keyword' && token.value === 'trailer') break;
      if (token.kind !== 'number' || !Number.isInteger(token.value) || token.value < 0) {
        throw new PdfError(
          'A cross-reference table subsection does not start with a number',
          'corrupt',
        );
      }
      const start = token.value;
      token = lexer.next();
      if (token.kind !== 'number' || !Number.isInteger(token.value) || token.value < 0) {
        throw new PdfError('A cross-reference table subsection has no entry count', 'corrupt');
      }
      const count = token.value;
      if (start + count > this.limits.maxObjects) {
        throw new PdfError(
          `The cross-reference table lists objects past the ${this.limits.maxObjects} the reader accepts`,
          'too_large',
        );
      }
      for (let n = 0; n < count; n += 1) {
        const saved = lexer.pos;
        const first = lexer.next();
        if (first.kind === 'keyword' && first.value === 'trailer') {
          // Fewer entries than the count said: the common readers accept this, so does this one.
          lexer.pos = saved;
          break;
        }
        const second = lexer.next();
        const type = lexer.next();
        if (
          first.kind !== 'number' ||
          second.kind !== 'number' ||
          type.kind !== 'keyword' ||
          (type.value !== 'n' && type.value !== 'f')
        ) {
          throw new PdfError(
            'A cross-reference table entry is not "offset generation n|f"',
            'corrupt',
          );
        }
        const num = start + n;
        if (type.value === 'n') {
          this.setEntry(num, { kind: 'offset', offset: first.value, gen: second.value });
        } else this.setEntry(num, { kind: 'free' });
      }
    }
    const parser = new Parser(this.bytes, this.parseOptions(), lexer.pos);
    const trailer = parser.parse();
    if (!isDict(trailer)) throw new PdfError('The trailer is not a dictionary', 'corrupt');
    return trailer;
  }

  private async readXrefStream(stream: PdfStream): Promise<PdfDict> {
    const { map } = stream.dict;
    const widths = map.get('W');
    if (!isArray(widths) || widths.items.length < 3) {
      throw new PdfError('A cross-reference stream has no /W widths', 'corrupt');
    }
    const w = widths.items.map((item) => {
      if (!isNumber(item) || !Number.isInteger(item) || item < 0 || item > 8) {
        throw new PdfError('A cross-reference stream has a /W width that is not 0 to 8', 'corrupt');
      }
      return item;
    });
    const size = map.get('Size');
    const indexObject = map.get('Index');
    let index: number[];
    if (isArray(indexObject)) {
      index = indexObject.items.map((item) => {
        if (!isNumber(item) || !Number.isInteger(item) || item < 0) {
          throw new PdfError(
            'A cross-reference stream has an /Index that is not whole numbers',
            'corrupt',
          );
        }
        return item;
      });
      if (index.length % 2 !== 0) {
        throw new PdfError(
          'A cross-reference stream has an /Index with an odd number of values',
          'corrupt',
        );
      }
    } else if (typeof size === 'number' && Number.isInteger(size) && size >= 0) index = [0, size];
    else throw new PdfError('A cross-reference stream has neither /Index nor /Size', 'corrupt');
    const data = await this.streamData(stream);
    const rowLength = (w[0] ?? 0) + (w[1] ?? 0) + (w[2] ?? 0);
    if (rowLength === 0)
      throw new PdfError('A cross-reference stream has zero-width entries', 'corrupt');
    let pos = 0;
    const readField = (width: number, fallback: number): number => {
      if (width === 0) return fallback;
      let value = 0;
      for (let k = 0; k < width; k += 1) {
        value = value * 256 + (data[pos] ?? 0);
        pos += 1;
      }
      if (!Number.isSafeInteger(value)) {
        throw new PdfError(
          'A cross-reference stream entry holds a value past the safe integer range',
          'corrupt',
        );
      }
      return value;
    };
    for (let i = 0; i < index.length; i += 2) {
      const start = index[i] ?? 0;
      const count = index[i + 1] ?? 0;
      if (start + count > this.limits.maxObjects) {
        throw new PdfError(
          `The cross-reference stream lists objects past the ${this.limits.maxObjects} the reader accepts`,
          'too_large',
        );
      }
      for (let n = 0; n < count; n += 1) {
        if (pos + rowLength > data.length) {
          throw new PdfError(
            'A cross-reference stream ends before its /Index says it does',
            'corrupt',
          );
        }
        const type = readField(w[0] ?? 0, 1);
        const second = readField(w[1] ?? 0, 0);
        const third = readField(w[2] ?? 0, 0);
        const num = start + n;
        if (type === 1) this.setEntry(num, { kind: 'offset', offset: second, gen: third });
        else if (type === 2)
          this.setEntry(num, { kind: 'compressed', streamNum: second, index: third });
        else if (type === 0) this.setEntry(num, { kind: 'free' });
        // Other types are reserved by the specification and read as null references.
      }
    }
    return stream.dict;
  }

  /**
   * The fallback: every `N G obj` in the file (the last occurrence of a number wins), every
   * `trailer` dictionary (later keys win), and when no trailer names a catalog, the /Root of any
   * cross-reference stream or the first object of /Type /Catalog. Objects inside object streams
   * are registered where no direct object of that number exists.
   */
  private async reconstruct(): Promise<void> {
    this.reconstructed = true;
    this.table.clear();
    this.cache.clear();
    this.objectStreams.clear();
    const { bytes } = this;
    const found = new Map<number, number>();
    const trailer = new Map<string, PdfObject>();
    let pos = 0;
    for (;;) {
      const at = indexOfBytes(bytes, 'obj', pos);
      if (at < 0) break;
      pos = at + 3;
      const after = bytes[at + 3] ?? 0x20;
      if (!isWhitespace(after) && !isDelimiter(after)) continue;
      const header = objectHeaderBefore(bytes, at);
      if (header === null) continue;
      found.set(header.num, header.offset);
      if (found.size > this.limits.maxObjects) {
        throw new PdfError(
          `The document holds more than the ${this.limits.maxObjects} objects the reader accepts`,
          'too_large',
        );
      }
    }
    pos = 0;
    for (;;) {
      const at = indexOfBytes(bytes, 'trailer', pos);
      if (at < 0) break;
      pos = at + 7;
      try {
        const object = new Parser(bytes, this.parseOptions(), at + 7).parse();
        if (isDict(object)) for (const [key, value] of object.map) trailer.set(key, value);
      } catch (error) {
        if (error instanceof PdfError && error.code === 'corrupt') continue;
        throw error;
      }
    }
    for (const [num, offset] of found) {
      this.table.set(num, { kind: 'offset', offset, gen: 0 });
    }
    // Object streams and cross-reference streams: a sweep over every object, errors skipped.
    const streams: number[] = [];
    let catalog: PdfRef | null = null;
    for (const [num, offset] of found) {
      const header = readObjectHeader(bytes, offset);
      if (!header) continue;
      let object: PdfObject | undefined;
      try {
        object = new Parser(bytes, this.parseOptions(), header.after).parse();
      } catch (error) {
        if (error instanceof PdfError && error.code === 'corrupt') continue;
        throw error;
      }
      if (object === undefined) continue;
      const map = isStream(object) ? object.dict.map : isDict(object) ? object.map : null;
      if (!map) continue;
      const type = map.get('Type');
      if (isStream(object) && isName(type ?? null, 'ObjStm')) streams.push(num);
      else if (isStream(object) && isName(type ?? null, 'XRef')) {
        for (const key of ['Root', 'Info', 'Encrypt', 'ID']) {
          const value = map.get(key);
          if (value !== undefined && !trailer.has(key)) trailer.set(key, value);
        }
      } else if (isName(type ?? null, 'Catalog') && catalog === null) {
        catalog = { kind: 'ref', num, gen: header.gen };
      }
    }
    for (const num of streams) {
      let indexed: ObjectStreamIndex;
      try {
        indexed = await this.objectStream(num);
      } catch (error) {
        if (error instanceof PdfError && error.code === 'corrupt') continue;
        throw error;
      }
      indexed.entries.forEach((entry, index) => {
        if (!found.has(entry.num)) {
          this.table.set(entry.num, { kind: 'compressed', streamNum: num, index });
        }
      });
      if (this.table.size > this.limits.maxObjects) {
        throw new PdfError(
          `The document holds more than the ${this.limits.maxObjects} objects the reader accepts`,
          'too_large',
        );
      }
    }
    this.trailer.map.clear();
    for (const [key, value] of trailer) this.trailer.map.set(key, value);
    const root = this.trailer.map.get('Root');
    if (!isRef(root ?? null) || !this.table.has((root as PdfRef).num)) {
      if (catalog) this.trailer.map.set('Root', catalog);
      else this.trailer.map.delete('Root');
    }
  }

  private parseOptions(): {
    maxDepth: number;
    allowRefs: true;
    resolveLength: (r: PdfRef) => number | null;
  } {
    return {
      maxDepth: this.limits.maxDepth,
      allowRefs: true,
      resolveLength: (r) => this.lengthOf(r),
    };
  }

  /** A stream /Length held in a direct object, read without touching the async path; else null. */
  private lengthOf(r: PdfRef): number | null {
    const cached = this.cache.get(r.num);
    if (cached !== undefined) return typeof cached === 'number' ? cached : null;
    const entry = this.table.get(r.num);
    if (entry?.kind !== 'offset') return null;
    const header = readObjectHeader(this.bytes, entry.offset);
    if (header?.num !== r.num) return null;
    const lexer = new Lexer(this.bytes, header.after);
    const token = lexer.next();
    if (token.kind !== 'number' || !Number.isInteger(token.value) || token.value < 0) return null;
    return token.value;
  }

  /** Whether the table has an entry for the object number (free or not). */
  has(num: number): boolean {
    return this.table.has(num);
  }

  /** The object a reference points at, or null when it is free, missing or refers to itself. */
  async fetch(r: PdfRef): Promise<PdfObject> {
    const cached = this.cache.get(r.num);
    if (cached !== undefined) return cached;
    if (this.resolving.has(r.num)) return null;
    this.resolving.add(r.num);
    try {
      const value = await this.load(r);
      this.cache.set(r.num, value);
      return value;
    } finally {
      this.resolving.delete(r.num);
    }
  }

  private async load(r: PdfRef): Promise<PdfObject> {
    const entry = this.table.get(r.num);
    if (!entry || entry.kind === 'free') return null;
    this.fetched += 1;
    if (this.fetched > this.limits.maxObjects) {
      throw new PdfError(
        `The document holds more than the ${this.limits.maxObjects} objects the reader accepts`,
        'too_large',
      );
    }
    if (entry.kind === 'offset') {
      const header = readObjectHeader(this.bytes, entry.offset);
      if (header?.num !== r.num) {
        if (!this.reconstructed) {
          await this.reconstruct();
          this.checkTrailer();
          this.fetched -= 1;
          return this.load(r);
        }
        throw new PdfError(
          `Object ${r.num} is not where the cross-reference data says it is`,
          'corrupt',
        );
      }
      const parser = new Parser(this.bytes, this.parseOptions(), header.after);
      const object = parser.parse();
      if (object === undefined) return null;
      if (isStream(object) || isDict(object) || isArray(object)) return object;
      // A bare `endobj` after the header means an empty object.
      return typeof object === 'object' && object !== null && object.kind === 'op' ? null : object;
    }
    const indexed = await this.objectStream(entry.streamNum);
    let slot = indexed.entries[entry.index];
    if (slot?.num !== r.num) slot = indexed.entries.find((e) => e.num === r.num);
    if (!slot) {
      throw new PdfError(
        `Object ${r.num} is not in object stream ${entry.streamNum} as the cross-reference data says`,
        'corrupt',
      );
    }
    const parser = new Parser(indexed.data, this.parseOptions(), indexed.first + slot.offset);
    const object = parser.parse();
    if (
      object === undefined ||
      (typeof object === 'object' && object !== null && object.kind === 'op')
    ) {
      throw new PdfError(
        `Object ${r.num} in object stream ${entry.streamNum} is not an object`,
        'corrupt',
      );
    }
    return object;
  }

  private async objectStream(num: number): Promise<ObjectStreamIndex> {
    const known = this.objectStreams.get(num);
    if (known) return known;
    const stream = await this.fetch({ kind: 'ref', num, gen: 0 });
    if (!isStream(stream))
      throw new PdfError(
        `Object ${num} is not the object stream the cross-reference data says it is`,
        'corrupt',
      );
    const count = await this.resolve(stream.dict.map.get('N') ?? null);
    const first = await this.resolve(stream.dict.map.get('First') ?? null);
    if (
      !isNumber(count) ||
      !Number.isInteger(count) ||
      count < 0 ||
      !isNumber(first) ||
      !Number.isInteger(first) ||
      first < 0
    ) {
      throw new PdfError(`Object stream ${num} has no valid /N and /First`, 'corrupt');
    }
    const data = await this.streamData(stream);
    const lexer = new Lexer(data, 0);
    const entries: { num: number; offset: number }[] = [];
    for (let n = 0; n < count; n += 1) {
      const a = lexer.next();
      const b = lexer.next();
      if (
        a.kind !== 'number' ||
        b.kind !== 'number' ||
        !Number.isInteger(a.value) ||
        !Number.isInteger(b.value) ||
        a.value < 0 ||
        b.value < 0
      ) {
        throw new PdfError(`Object stream ${num} has a damaged header`, 'corrupt');
      }
      if (lexer.pos > first)
        throw new PdfError(`Object stream ${num} has a header longer than its /First`, 'corrupt');
      entries.push({ num: a.value, offset: b.value });
    }
    const indexed = { data, first, entries };
    this.objectStreams.set(num, indexed);
    return indexed;
  }

  /** Follows a reference (or a chain of them) to the object it points at; a direct object is returned as it is. */
  async resolve(object: PdfObject): Promise<PdfObject> {
    let current = object;
    for (let hops = 0; hops < 32 && isRef(current); hops += 1) current = await this.fetch(current);
    return isRef(current) ? null : current;
  }

  /** A dictionary entry, resolved. */
  async get(dictionary: PdfDict | null | undefined, key: string): Promise<PdfObject> {
    if (!dictionary) return null;
    return this.resolve(dictionary.map.get(key) ?? null);
  }

  /** The decoded bytes of a stream, within the stream and total limits; cached per stream. */
  async streamData(stream: PdfStream): Promise<Uint8Array> {
    const cached = this.decoded.get(stream);
    if (cached) return cached;
    const { maxStreamBytes, maxTotalStreamBytes } = this.limits;
    if (stream.raw.length > maxStreamBytes) {
      throw new PdfError(
        `A stream holds ${stream.raw.length} bytes, more than the ${maxStreamBytes} the reader accepts`,
        'too_large',
      );
    }
    const filters = await this.filtersOf(stream.dict);
    let data = stream.raw;
    for (const { filter, parms } of filters) {
      data = await applyFilter(filter, data, parms, this.inflate, { maxStreamBytes });
    }
    this.totalStreamBytes += data.length;
    if (this.totalStreamBytes > maxTotalStreamBytes) {
      throw new PdfError(
        `The streams of the document decode to more than the ${maxTotalStreamBytes} bytes the reader accepts together`,
        'too_large',
      );
    }
    this.decoded.set(stream, data);
    return data;
  }

  /** The filter chain of a stream with the decode parameters of each, resolved. */
  async filtersOf(dictionary: PdfDict): Promise<{ filter: string; parms: DecodeParms }[]> {
    const filter = await this.get(dictionary, 'Filter');
    const names: string[] = [];
    if (isName(filter)) names.push(filter.name);
    else if (isArray(filter)) {
      for (const item of filter.items) {
        const resolved = await this.resolve(item);
        if (isName(resolved)) names.push(resolved.name);
        else throw new PdfError('A stream names a filter that is not a name', 'corrupt');
      }
    } else if (filter !== null)
      throw new PdfError('A stream has a /Filter that is neither a name nor an array', 'corrupt');
    const parmsObject = await this.get(dictionary, 'DecodeParms');
    const parmsList: PdfObject[] = isArray(parmsObject) ? parmsObject.items : [parmsObject];
    const out: { filter: string; parms: DecodeParms }[] = [];
    for (let i = 0; i < names.length; i += 1) {
      const raw = await this.resolve(parmsList[i] ?? null);
      out.push({ filter: names[i] ?? '', parms: await this.decodeParms(isDict(raw) ? raw : null) });
    }
    return out;
  }

  private async decodeParms(dictionary: PdfDict | null): Promise<DecodeParms> {
    if (!dictionary) return DEFAULT_DECODE_PARMS;
    const number = async (key: string, fallback: number): Promise<number> => {
      const value = await this.get(dictionary, key);
      return isNumber(value) ? value : fallback;
    };
    return {
      predictor: await number('Predictor', 1),
      colors: await number('Colors', 1),
      bitsPerComponent: await number('BitsPerComponent', 8),
      columns: await number('Columns', 1),
    };
  }
}

/** Reads `N G ` backwards from the position of `obj`; null when what precedes is not a header. */
function objectHeaderBefore(
  bytes: Uint8Array,
  objAt: number,
): { num: number; gen: number; offset: number } | null {
  let i = objAt - 1;
  if (i < 0 || !isWhitespace(bytes[i] ?? 0)) return null;
  while (i >= 0 && isWhitespace(bytes[i] ?? 0)) i -= 1;
  const genEnd = i + 1;
  while (i >= 0 && isDigit(bytes[i] ?? 0)) i -= 1;
  const genStart = i + 1;
  if (genStart === genEnd) return null;
  if (i < 0 || !isWhitespace(bytes[i] ?? 0)) return null;
  while (i >= 0 && isWhitespace(bytes[i] ?? 0)) i -= 1;
  const numEnd = i + 1;
  while (i >= 0 && isDigit(bytes[i] ?? 0)) i -= 1;
  const numStart = i + 1;
  if (numStart === numEnd) return null;
  if (i >= 0 && !isWhitespace(bytes[i] ?? 0) && !isDelimiter(bytes[i] ?? 0)) return null;
  const num = Number(latin1(bytes.subarray(numStart, numEnd)));
  const gen = Number(latin1(bytes.subarray(genStart, genEnd)));
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(gen)) return null;
  return { num, gen, offset: numStart };
}
