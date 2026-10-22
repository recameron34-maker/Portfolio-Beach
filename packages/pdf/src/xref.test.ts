import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { concatBytes, encodeUtf8, latin1Bytes } from './bytes.js';
import { PdfError } from './errors.js';
import {
  appendUpdate,
  assemble,
  offsetOf,
  onePage,
  streamBody,
  type FixtureObject,
} from './fixtures.js';
import { READ_LIMITS, type ReadLimits } from './limits.js';
import { nodeInflate } from './node.js';
import { isDict, isStream, ref, type PdfObject } from './objects.js';
import { PdfFile } from './xref.js';

const deflate = (data: Uint8Array): Uint8Array => new Uint8Array(deflateSync(data));
const open = (bytes: Uint8Array, limits: Partial<ReadLimits> = {}) =>
  PdfFile.open(bytes, nodeInflate, { ...READ_LIMITS, ...limits });

async function refusal(run: () => Promise<unknown>): Promise<PdfError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfError);
    return error as PdfError;
  }
  throw new Error('expected a PdfError');
}

const dictValue = (object: PdfObject, key: string): PdfObject | undefined =>
  isDict(object) ? object.map.get(key) : isStream(object) ? object.dict.map.get(key) : undefined;

const BASE = onePage('BT /F1 12 Tf 72 700 Td (Hello) Tj ET', {
  objects: [{ num: 5, body: '<< /Title (First) >>' }],
});
const TRAILER = '/Root 1 0 R /Info 5 0 R';

describe('PdfFile.open', () => {
  it('reads the header version, a classic table and the trailer', async () => {
    const file = await open(assemble(BASE, { trailer: TRAILER, version: '1.7' }));
    expect(file.headerVersion).toBe('1.7');
    expect(file.reconstructed).toBe(false);
    expect(file.trailer.map.get('Root')).toEqual(ref(1, 0));
    expect(file.trailer.map.get('Size')).toBe(6);
    const catalog = await file.fetch(ref(1, 0));
    expect(dictValue(catalog, 'Type')).toEqual({ kind: 'name', name: 'Catalog' });
    expect(await file.get(isDict(catalog) ? catalog : null, 'Pages')).toMatchObject({
      kind: 'dict',
    });
    expect(await file.fetch(ref(0, 65535))).toBeNull();
    expect(await file.fetch(ref(99, 0))).toBeNull();
    expect(file.has(5)).toBe(true);
    expect(file.has(99)).toBe(false);
  });

  it('accepts junk before the header and counts offsets from the header', async () => {
    const prefix = encodeUtf8('junk bytes before the header\n');
    const file = await open(assemble(BASE, { trailer: TRAILER, prefix }));
    expect(file.reconstructed).toBe(false);
    expect(dictValue(await file.fetch(ref(5, 0)), 'Title')).toEqual({
      kind: 'string',
      bytes: encodeUtf8('First'),
    });
  });

  it('refuses bytes with no header within the first kilobyte', async () => {
    expect((await refusal(() => open(encodeUtf8('not a pdf at all')))).code).toBe('not_pdf');
    const late = concatBytes([new Uint8Array(1100), assemble(BASE, { trailer: TRAILER })]);
    expect((await refusal(() => open(late))).code).toBe('not_pdf');
    expect((await refusal(() => open(new Uint8Array(0)))).code).toBe('not_pdf');
  });

  it('refuses a file past maxBytes at the boundary', async () => {
    const bytes = assemble(BASE, { trailer: TRAILER });
    expect((await refusal(() => open(bytes, { maxBytes: bytes.length - 1 }))).code).toBe(
      'too_large',
    );
    await expect(open(bytes, { maxBytes: bytes.length })).resolves.toBeInstanceOf(PdfFile);
  });

  it('refuses an encrypted document', async () => {
    const objects = [
      ...BASE,
      { num: 6, body: '<< /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -1 >>' },
    ];
    const error = await refusal(() =>
      open(assemble(objects, { trailer: `${TRAILER} /Encrypt 6 0 R` })),
    );
    expect(error.code).toBe('encrypted');
    // The fallback scan sees the /Encrypt too.
    const broken = assemble(objects, {
      trailer: `${TRAILER} /Encrypt 6 0 R`,
      startxrefOverride: 5,
    });
    expect((await refusal(() => open(broken))).code).toBe('encrypted');
  });

  it('follows a /Prev chain, the newest section winning', async () => {
    const base = assemble(BASE, { trailer: TRAILER });
    const updated = appendUpdate(base, [{ num: 5, body: '<< /Title (Second) >>' }], TRAILER);
    const file = await open(updated);
    expect(file.reconstructed).toBe(false);
    expect(dictValue(await file.fetch(ref(5, 0)), 'Title')).toEqual({
      kind: 'string',
      bytes: encodeUtf8('Second'),
    });
    expect(dictValue(await file.fetch(ref(1, 0)), 'Type')).toEqual({
      kind: 'name',
      name: 'Catalog',
    });
  });

  it('stops on a /Prev loop and on a /Prev outside the file', async () => {
    const base = assemble(BASE, { trailer: TRAILER });
    const text = Array.from(base, (b) => String.fromCharCode(b)).join('');
    const start = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
    const looped = latin1Bytes(text.replace('/Size 6', `/Size 6 /Prev ${start}`));
    const file = await open(looped);
    expect(file.reconstructed).toBe(false);
    const outside = latin1Bytes(text.replace('/Size 6', '/Size 6 /Prev 999999'));
    // Damaged cross-reference data falls back to the scan rather than failing.
    const scanned = await open(outside);
    expect(scanned.reconstructed).toBe(true);
    expect(dictValue(await scanned.fetch(ref(1, 0)), 'Type')).toEqual({
      kind: 'name',
      name: 'Catalog',
    });
  });

  it('reads a cross-reference stream with /W widths, /Index and free entries', async () => {
    const bytes = assemble(BASE, { trailer: TRAILER, xref: 'stream' });
    const file = await open(bytes);
    expect(file.reconstructed).toBe(false);
    expect(file.trailer.map.get('Root')).toEqual(ref(1, 0));
    expect(await file.fetch(ref(0, 0))).toBeNull();
    expect(dictValue(await file.fetch(ref(5, 0)), 'Title')).toEqual({
      kind: 'string',
      bytes: encodeUtf8('First'),
    });
    const objects: FixtureObject[] = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 7, body: '<< /Title (Seven) >>' },
    ];
    // /Index with two subsections and 2-byte offsets.
    const ordered = assemble(objects, { trailer: '/Root 1 0 R', xref: 'none' });
    const text = Array.from(ordered, (b) => String.fromCharCode(b)).join('');
    const off = (n: number): number => text.indexOf(`\n${n} 0 obj`) + 1;
    const rows = [1, 2, 7].map((n) => new Uint8Array([1, off(n) >> 8, off(n) & 0xff]));
    const body = streamBody(
      '/Type /XRef /Size 9 /W [1 2 0] /Index [1 2 7 1] /Root 1 0 R',
      concatBytes(rows),
    );
    const withStream = concatBytes([
      latin1Bytes(text.replace(/trailer[^]*$/, '')),
      encodeUtf8('8 0 obj\n'),
      body,
      encodeUtf8('\nendobj\nstartxref\n'),
    ]);
    const startxref =
      withStream.length -
      encodeUtf8('8 0 obj\n').length -
      body.length -
      encodeUtf8('\nendobj\nstartxref\n').length;
    const full = concatBytes([withStream, encodeUtf8(`${startxref}\n%%EOF\n`)]);
    const indexed = await open(full);
    expect(indexed.reconstructed).toBe(false);
    expect(dictValue(await indexed.fetch(ref(7, 0)), 'Title')).toEqual({
      kind: 'string',
      bytes: encodeUtf8('Seven'),
    });
    expect(await indexed.fetch(ref(3, 0))).toBeNull();
  });

  it('reads a deflated cross-reference stream with a PNG predictor', async () => {
    for (const predictor of [false, true]) {
      const bytes = assemble(BASE, {
        trailer: TRAILER,
        xref: 'stream',
        xrefStreamEncode: { deflate, predictor },
      });
      const file = await open(bytes);
      expect(file.reconstructed).toBe(false);
      expect(dictValue(await file.fetch(ref(5, 0)), 'Title')).toEqual({
        kind: 'string',
        bytes: encodeUtf8('First'),
      });
    }
  });

  it('reads a hybrid file whose trailer names an /XRefStm', async () => {
    // The base is indexed by a stream; the update's table lists only the catalog and points at the stream.
    const base = assemble(BASE, { trailer: TRAILER, xref: 'stream' });
    const xrefStm = offsetOf(base, 6);
    const updated = appendUpdate(
      base,
      [{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R /Lang (en) >>' }],
      TRAILER,
      { xrefStm },
    );
    const file = await open(updated);
    expect(file.reconstructed).toBe(false);
    expect(dictValue(await file.fetch(ref(1, 0)), 'Lang')).toEqual({
      kind: 'string',
      bytes: encodeUtf8('en'),
    });
    expect(dictValue(await file.fetch(ref(5, 0)), 'Title')).toEqual({
      kind: 'string',
      bytes: encodeUtf8('First'),
    });
  });

  it('refuses a cross-reference stream whose widths, index or data are wrong', async () => {
    const make = (entries: string, data: Uint8Array): Uint8Array => {
      const objects: FixtureObject[] = [{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' }];
      const head = assemble(objects, { trailer: '/Root 1 0 R', xref: 'none' });
      const text = Array.from(head, (b) => String.fromCharCode(b)).join('');
      const prefix = latin1Bytes(text.replace(/trailer[^]*$/, ''));
      const body = streamBody(entries, data);
      return concatBytes([
        prefix,
        encodeUtf8('2 0 obj\n'),
        body,
        encodeUtf8(`\nendobj\nstartxref\n${prefix.length}\n%%EOF\n`),
      ]);
    };
    // Each damaged stream falls back to the scan, which still finds the catalog.
    for (const [entries, data] of [
      ['/Type /XRef /Size 3 /Root 1 0 R', new Uint8Array([1, 0, 0])],
      ['/Type /XRef /Size 3 /W [1 9 1] /Root 1 0 R', new Uint8Array([1, 0, 0])],
      ['/Type /XRef /Size 3 /W [1 1 1] /Index [0] /Root 1 0 R', new Uint8Array([1, 0, 0])],
      ['/Type /XRef /Size 3 /W [1 1 1] /Index [0 2] /Root 1 0 R', new Uint8Array([1, 0, 0])],
      ['/Type /XRef /Size 3 /W [0 0 0] /Root 1 0 R', new Uint8Array([1, 0, 0])],
      ['/Type /XRef /W [1 1 1] /Root 1 0 R', new Uint8Array([1, 0, 0])],
    ] as const) {
      const file = await open(make(entries, data));
      expect(file.reconstructed).toBe(true);
      expect(file.trailer.map.get('Root')).toEqual(ref(1, 0));
    }
  });

  it('reads objects out of an object stream', async () => {
    const inner =
      '<< /Type /Catalog /Pages 2 0 R >> << /Type /Pages /Kids [] /Count 0 >> << /Title (Inside) >>';
    const header = `1 0 2 ${'<< /Type /Catalog /Pages 2 0 R >> '.length} 5 ${'<< /Type /Catalog /Pages 2 0 R >> << /Type /Pages /Kids [] /Count 0 >> '.length}\n`;
    const data = encodeUtf8(header + inner);
    const objects: FixtureObject[] = [
      {
        num: 3,
        body: streamBody(
          `/Type /ObjStm /N 3 /First ${header.length} /Filter /FlateDecode`,
          deflate(data),
        ),
      },
    ];
    // A cross-reference stream with type 2 entries for 1, 2 and 5.
    const head = assemble(objects, { trailer: '/Root 1 0 R', xref: 'none' });
    const text = Array.from(head, (b) => String.fromCharCode(b)).join('');
    const prefix = latin1Bytes(text.replace(/trailer[^]*$/, ''));
    const at3 = text.indexOf('\n3 0 obj') + 1;
    const rows = concatBytes([
      new Uint8Array([0, 0, 0]),
      new Uint8Array([2, 3, 0]),
      new Uint8Array([2, 3, 1]),
      new Uint8Array([1, at3, 0]),
      new Uint8Array([1, prefix.length, 0]),
      new Uint8Array([2, 3, 2]),
    ]);
    const body = streamBody('/Type /XRef /Size 6 /W [1 1 1] /Root 1 0 R /Info 5 0 R', rows);
    const file = await open(
      concatBytes([
        prefix,
        encodeUtf8('4 0 obj\n'),
        body,
        encodeUtf8(`\nendobj\nstartxref\n${prefix.length}\n%%EOF\n`),
      ]),
    );
    expect(file.reconstructed).toBe(false);
    expect(dictValue(await file.fetch(ref(1, 0)), 'Type')).toEqual({
      kind: 'name',
      name: 'Catalog',
    });
    expect(dictValue(await file.fetch(ref(5, 0)), 'Title')).toEqual({
      kind: 'string',
      bytes: encodeUtf8('Inside'),
    });
    expect(await file.resolve(ref(5, 0))).toBe(await file.fetch(ref(5, 0)));
  });

  it('refuses an object stream with a damaged header or a missing object', async () => {
    const build = (entries: string, data: string, rows: Uint8Array): Uint8Array => {
      const objects: FixtureObject[] = [{ num: 3, body: streamBody(entries, encodeUtf8(data)) }];
      const head = assemble(objects, { trailer: '/Root 1 0 R', xref: 'none' });
      const text = Array.from(head, (b) => String.fromCharCode(b)).join('');
      const prefix = latin1Bytes(text.replace(/trailer[^]*$/, ''));
      const at3 = text.indexOf('\n3 0 obj') + 1;
      const full = concatBytes([
        new Uint8Array([0, 0, 0]),
        rows,
        new Uint8Array([0, 0, 0]),
        new Uint8Array([1, at3, 0]),
        new Uint8Array([1, prefix.length, 0]),
      ]);
      const body = streamBody('/Type /XRef /Size 5 /W [1 1 1] /Root 1 0 R', full);
      return concatBytes([
        prefix,
        encodeUtf8('4 0 obj\n'),
        body,
        encodeUtf8(`\nendobj\nstartxref\n${prefix.length}\n%%EOF\n`),
      ]);
    };
    const damagedHeader = build(
      '/Type /ObjStm /N 1 /First 4',
      'x 0 << /Type /Catalog >>',
      new Uint8Array([2, 3, 0]),
    );
    const file = await open(damagedHeader);
    expect((await refusal(() => file.fetch(ref(1, 0)))).code).toBe('corrupt');
    const missing = build(
      '/Type /ObjStm /N 1 /First 4',
      '9 0 << /Type /Catalog >>',
      new Uint8Array([2, 3, 0]),
    );
    const file2 = await open(missing);
    expect((await refusal(() => file2.fetch(ref(1, 0)))).code).toBe('corrupt');
    const noN = build(
      '/Type /ObjStm /First 4',
      '1 0 << /Type /Catalog >>',
      new Uint8Array([2, 3, 0]),
    );
    const file3 = await open(noN);
    expect((await refusal(() => file3.fetch(ref(1, 0)))).code).toBe('corrupt');
    const longHeader = build(
      '/Type /ObjStm /N 1 /First 1',
      '1 0 << /Type /Catalog >>',
      new Uint8Array([2, 3, 0]),
    );
    const file4 = await open(longHeader);
    expect((await refusal(() => file4.fetch(ref(1, 0)))).code).toBe('corrupt');
  });

  it('falls back to a linear scan when startxref is missing, wrong, or an offset lies', async () => {
    const none = assemble(BASE, { trailer: TRAILER, xref: 'none' });
    const scanned = await open(none);
    expect(scanned.reconstructed).toBe(true);
    expect(dictValue(await scanned.fetch(ref(5, 0)), 'Title')).toEqual({
      kind: 'string',
      bytes: encodeUtf8('First'),
    });
    const wrong = await open(assemble(BASE, { trailer: TRAILER, startxrefOverride: 3 }));
    expect(wrong.reconstructed).toBe(true);
    const lying = await open(assemble(BASE, { trailer: TRAILER, wrongOffsetFor: 5 }));
    expect(lying.reconstructed).toBe(false);
    expect(dictValue(await lying.fetch(ref(5, 0)), 'Title')).toEqual({
      kind: 'string',
      bytes: encodeUtf8('First'),
    });
    expect(lying.reconstructed).toBe(true);
  });

  it('finds the catalog without a trailer: by a cross-reference stream or by /Type /Catalog', async () => {
    const stream = assemble(BASE, { trailer: TRAILER, xref: 'stream' });
    const text = Array.from(stream, (b) => String.fromCharCode(b)).join('');
    const noStart = latin1Bytes(text.replace(/startxref[^]*$/, ''));
    const file = await open(noStart);
    expect(file.reconstructed).toBe(true);
    expect(file.trailer.map.get('Root')).toEqual(ref(1, 0));
    expect(file.trailer.map.get('Info')).toEqual(ref(5, 0));
    const bare = assemble(BASE, { trailer: '', xref: 'none' });
    const bareText = Array.from(bare, (b) => String.fromCharCode(b)).join('');
    const noTrailer = await open(latin1Bytes(bareText.replace(/trailer[^]*$/, '')));
    expect(noTrailer.reconstructed).toBe(true);
    expect(noTrailer.trailer.map.get('Root')).toEqual(ref(1, 0));
  });

  it('registers objects inside object streams during the scan, direct objects winning', async () => {
    const inner = '<< /Type /Catalog /Pages 2 0 R >> << /Type /Pages /Kids [] /Count 0 >>';
    const header = `1 0 2 ${'<< /Type /Catalog /Pages 2 0 R >> '.length}\n`;
    const objects: FixtureObject[] = [
      { num: 3, body: streamBody(`/Type /ObjStm /N 2 /First ${header.length}`, header + inner) },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 /Direct true >>' },
    ];
    const file = await open(assemble(objects, { trailer: '/Root 1 0 R', xref: 'none' }));
    expect(file.reconstructed).toBe(true);
    expect(dictValue(await file.fetch(ref(1, 0)), 'Type')).toEqual({
      kind: 'name',
      name: 'Catalog',
    });
    expect(dictValue(await file.fetch(ref(2, 0)), 'Direct')).toBe(true);
  });

  it('refuses a file with no catalog at all', async () => {
    const objects: FixtureObject[] = [{ num: 5, body: '<< /Title (Nothing else) >>' }];
    expect((await refusal(() => open(assemble(objects, { trailer: '', xref: 'none' })))).code).toBe(
      'corrupt',
    );
    const rootless = assemble(BASE, { trailer: '/Info 5 0 R' });
    // No /Root in a valid table: the scan finds the catalog by its /Type.
    const file = await open(rootless);
    expect(file.reconstructed).toBe(true);
    expect(file.trailer.map.get('Root')).toEqual(ref(1, 0));
  });

  it('refuses more objects than maxObjects, at the boundary, in every index form', async () => {
    const bytes = assemble(BASE, { trailer: TRAILER });
    expect((await refusal(() => open(bytes, { maxObjects: 5 }))).code).toBe('too_large');
    await expect(open(bytes, { maxObjects: 6 })).resolves.toBeInstanceOf(PdfFile);
    const stream = assemble(BASE, { trailer: TRAILER, xref: 'stream' });
    expect((await refusal(() => open(stream, { maxObjects: 6 }))).code).toBe('too_large');
    await expect(open(stream, { maxObjects: 7 })).resolves.toBeInstanceOf(PdfFile);
    const none = assemble(BASE, { trailer: TRAILER, xref: 'none' });
    expect((await refusal(() => open(none, { maxObjects: 4 }))).code).toBe('too_large');
    await expect(open(none, { maxObjects: 5 })).resolves.toBeInstanceOf(PdfFile);
    const big = assemble([...BASE, { num: 500, body: '<< >>' }], { trailer: TRAILER });
    expect((await refusal(() => open(big, { maxObjects: 400 }))).code).toBe('too_large');
  });

  it('indexes a damaged file in linear time: nested strings, streams with no endstream, one far endstream (PDF-4)', async () => {
    const count = 20_000;
    const streams = Array.from({ length: count }, (_, k) => `${k + 1} 0 obj<<>>stream\n`).join('');
    const shapes = ['trailer('.repeat(count) + ')'.repeat(count), streams, `${streams}endstream`];
    for (const shape of shapes) {
      const started = performance.now();
      // No catalog anywhere, so a refusal; reached without parsing the file again at every occurrence.
      expect((await refusal(() => open(latin1Bytes(`%PDF-1.4\n${shape}\n`)))).code).toBe('corrupt');
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });

  it('refuses a damaged file whose repair would parse the bytes over and over (PDF-4)', async () => {
    // Every "trailer" opens a string that never closes, so each occurrence parses to the end.
    const bytes = latin1Bytes(`%PDF-1.4\n${'trailer('.repeat(20_000)}\n`);
    const started = performance.now();
    expect((await refusal(() => open(bytes))).code).toBe('too_large');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('refuses a damaged classic table that the scan cannot repair', async () => {
    const bytes = assemble(BASE, { trailer: TRAILER });
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    const file = await open(latin1Bytes(text.replace('0 6\n', 'x 6\n')));
    expect(file.reconstructed).toBe(true);
    const short = await open(latin1Bytes(text.replace('0 6\n', '0 9\n')));
    expect(short.reconstructed).toBe(false);
    const badEntry = await open(latin1Bytes(text.replace(' 00000 n \n', ' 00000 q \n')));
    expect(badEntry.reconstructed).toBe(true);
    const noDict = await open(latin1Bytes(text.replace('trailer\n<<', 'trailer\n[')));
    expect(noDict.reconstructed).toBe(true);
    expect(noDict.trailer.map.get('Root')).toEqual(ref(1, 0));
  });

  it('resolves an indirect stream /Length held in a direct object', async () => {
    const objects: FixtureObject[] = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 3, body: '<< /Length 4 0 R >>\nstream\nhello\nendstream' },
      { num: 4, body: '5' },
    ];
    const file = await open(assemble(objects, { trailer: '/Root 1 0 R' }));
    const stream = await file.fetch(ref(3, 0));
    expect(isStream(stream) && Array.from(stream.raw)).toEqual(Array.from(encodeUtf8('hello')));
    expect(await file.fetch(ref(4, 0))).toBe(5);
  });

  it('decodes stream data through the filter chain within the limits', async () => {
    const plain = encodeUtf8('x'.repeat(200));
    const objects: FixtureObject[] = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      {
        num: 3,
        body: streamBody(
          '/Filter [/ASCIIHexDecode /FlateDecode] /DecodeParms [null null]',
          Array.from(deflate(plain), (b) => b.toString(16).padStart(2, '0')).join('') + '>',
        ),
      },
      { num: 4, body: streamBody('/Filter /FlateDecode', deflate(plain)) },
      { num: 5, body: streamBody('/Filter 7', encodeUtf8('x')) },
      { num: 6, body: streamBody('/Filter [7]', encodeUtf8('x')) },
      { num: 7, body: streamBody('/Filter /DCTDecode', encodeUtf8('x')) },
    ];
    // Three reads of the 200-byte stream fit the total exactly; the cached bytes count each time.
    const file = await open(assemble(objects, { trailer: '/Root 1 0 R' }), {
      maxStreamBytes: 200,
      maxTotalStreamBytes: 600,
    });
    const chained = await file.fetch(ref(3, 0));
    if (!isStream(chained)) throw new Error('expected a stream');
    expect(await file.streamData(chained)).toEqual(plain);
    expect(await file.streamData(chained)).toBe(await file.streamData(chained));
    const second = await file.fetch(ref(4, 0));
    if (!isStream(second)) throw new Error('expected a stream');
    expect((await refusal(() => file.streamData(second))).code).toBe('too_large');
    const other = await open(assemble(objects, { trailer: '/Root 1 0 R' }), {
      maxStreamBytes: 199,
    });
    const tooBig = await other.fetch(ref(4, 0));
    if (!isStream(tooBig)) throw new Error('expected a stream');
    expect((await refusal(() => other.streamData(tooBig))).code).toBe('too_large');
    for (const num of [5, 6]) {
      const bad = await other.fetch(ref(num, 0));
      if (!isStream(bad)) throw new Error('expected a stream');
      expect((await refusal(() => other.streamData(bad))).code).toBe('corrupt');
    }
    const image = await other.fetch(ref(7, 0));
    if (!isStream(image)) throw new Error('expected a stream');
    expect((await refusal(() => other.streamData(image))).code).toBe('unsupported');
    const raw = await other.fetch(ref(5, 0));
    if (!isStream(raw)) throw new Error('expected a stream');
    const tiny = await open(assemble(objects, { trailer: '/Root 1 0 R' }), { maxStreamBytes: 0 });
    const rawStream = await tiny.fetch(ref(4, 0));
    if (!isStream(rawStream)) throw new Error('expected a stream');
    expect((await refusal(() => tiny.streamData(rawStream))).code).toBe('too_large');
  });

  it('returns null for a reference that points at itself and for a reference chain that never lands', async () => {
    const objects: FixtureObject[] = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /Self 3 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 3, body: '3 0 R' },
      { num: 4, body: '5 0 R' },
      { num: 5, body: '4 0 R' },
    ];
    const file = await open(assemble(objects, { trailer: '/Root 1 0 R' }));
    expect(await file.resolve(ref(3, 0))).toBeNull();
    expect(await file.resolve(ref(4, 0))).toBeNull();
    expect(await file.get(null, 'X')).toBeNull();
  });

  it('refuses objects nested past maxDepth', async () => {
    const objects: FixtureObject[] = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 3, body: '['.repeat(10) + ']'.repeat(10) },
    ];
    const file = await open(assemble(objects, { trailer: '/Root 1 0 R' }), { maxDepth: 9 });
    expect((await refusal(() => file.fetch(ref(3, 0)))).code).toBe('too_large');
    const fine = await open(assemble(objects, { trailer: '/Root 1 0 R' }), { maxDepth: 10 });
    await expect(fine.fetch(ref(3, 0))).resolves.toMatchObject({ kind: 'array' });
  });
});
