import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { concatBytes, encodeUtf8, latin1Bytes } from './bytes.js';
import { PdfError } from './errors.js';
import { assemble, content, onePage, streamBody, type FixtureObject } from './fixtures.js';
import type { ReadLimits } from './limits.js';
import { nodeInflate } from './node.js';
import { readPdf, type PdfDocument } from './read.js';
import { writePdf } from './write.js';

const deflate = (data: Uint8Array): Uint8Array => new Uint8Array(deflateSync(data));
const read = (bytes: Uint8Array, limits: Partial<ReadLimits> = {}): Promise<PdfDocument> =>
  readPdf(bytes, { inflate: nodeInflate, limits });
const one = (operators: string, extra?: Parameters<typeof onePage>[1]): Uint8Array =>
  assemble(onePage(operators, extra), { trailer: '/Root 1 0 R' });

async function refusal(run: () => Promise<unknown>): Promise<PdfError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfError);
    return error as PdfError;
  }
  throw new Error('expected a PdfError');
}

const text = (document: PdfDocument, page = 0): string => document.pages[page]?.text ?? '';

describe('readPdf', () => {
  it('reads a one-page file: version, size, runs, lines and text', async () => {
    const document = await read(one('BT /F1 12 Tf 72 700 Td (Hello) Tj 0 -20 Td (World) Tj ET'));
    expect(document).toMatchObject({
      version: '1.4',
      pageCount: 1,
      reconstructed: false,
      info: {},
    });
    const [page] = document.pages;
    expect(page).toMatchObject({ number: 1, width: 612, height: 792, rotate: 0 });
    expect(page?.runs.map((r) => [r.text, r.x, r.y, r.size, r.font])).toEqual([
      ['Hello', 72, 700, 12, 'Helvetica'],
      ['World', 72, 680, 12, 'Helvetica'],
    ]);
    expect(page?.lines).toEqual([
      { y: 700, text: 'Hello' },
      { y: 680, text: 'World' },
    ]);
    expect(page?.text).toBe('Hello\nWorld');
  });

  it('inherits Resources, MediaBox and Rotate down the page tree and normalizes the rotation', async () => {
    const objects: FixtureObject[] = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      {
        num: 2,
        body: '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 200 100] /Rotate 450 /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >> >>',
      },
      { num: 3, body: '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R] /Count 1 /Rotate -90 >>' },
      { num: 4, body: '<< /Type /Page /Parent 3 0 R /Contents 6 0 R >>' },
      { num: 5, body: '<< /Type /Page /Parent 2 0 R /Contents 6 0 R /MediaBox [10 20 110 70] >>' },
      { num: 6, body: content('BT /F1 10 Tf 20 30 Td (x) Tj ET') },
    ];
    const document = await read(assemble(objects, { trailer: '/Root 1 0 R' }));
    expect(document.pageCount).toBe(2);
    expect(document.pages[0]).toMatchObject({ width: 200, height: 100, rotate: 270 });
    expect(document.pages[0]?.runs[0]).toMatchObject({ x: 20, y: 30, font: 'Courier' });
    expect(document.pages[1]).toMatchObject({ width: 100, height: 50, rotate: 90 });
    // The media box origin moves to (0, 0).
    expect(document.pages[1]?.runs[0]).toMatchObject({ x: 10, y: 10 });
  });

  it('takes US letter for a missing or damaged media box and a page node without /Type', async () => {
    const objects: FixtureObject[] = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Kids [3 0 R 4 0 R] /Count 2 >>' },
      { num: 3, body: '<< /Contents 5 0 R /MediaBox [0 0 0 100] >>' },
      { num: 4, body: '<< /Type /Page /Contents 5 0 R /MediaBox [0 0 (a) 100] /Rotate (x) >>' },
      { num: 5, body: content('') },
    ];
    const document = await read(assemble(objects, { trailer: '/Root 1 0 R' }));
    expect(document.pages.map((p) => [p.width, p.height, p.rotate])).toEqual([
      [612, 792, 0],
      [612, 792, 0],
    ]);
  });

  it('joins an array of content streams and skips entries that are not streams', async () => {
    const objects = onePage('').map((o) =>
      o.num === 3
        ? {
            ...o,
            body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 9 0 R 5 0 R] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
          }
        : o.num === 4
          ? { ...o, body: content('BT /F1 12 Tf 72 700 Td (first) Tj ET') }
          : o,
    );
    objects.push({ num: 5, body: content('BT /F1 12 Tf 72 680 Td (second) Tj ET') });
    objects.push({ num: 9, body: '<< /Not /AStream >>' });
    const document = await read(assemble(objects, { trailer: '/Root 1 0 R' }));
    expect(text(document)).toBe('first\nsecond');
  });

  it('reads a page with no contents and a catalog that raises the version', async () => {
    const objects: FixtureObject[] = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /Version /1.7 >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R >>' },
    ];
    const document = await read(assemble(objects, { trailer: '/Root 1 0 R' }));
    expect(document.version).toBe('1.7');
    expect(document.pages[0]).toMatchObject({ runs: [], lines: [], text: '' });
    const lower = objects.map((o) =>
      o.num === 1 ? { ...o, body: '<< /Type /Catalog /Pages 2 0 R /Version /1.2 >>' } : o,
    );
    expect((await read(assemble(lower, { trailer: '/Root 1 0 R' }))).version).toBe('1.4');
  });

  it('reads the information dictionary as text, UTF-16 and dates as stored', async () => {
    const objects = [
      ...onePage(''),
      {
        num: 5,
        body: '<< /Title <FEFF005200E900730075006D00E9> /Author (Synthetic) /CreationDate (D:20260630120000Z) /Producer 7 /ModDate (later) >>',
      },
    ];
    const document = await read(assemble(objects, { trailer: '/Root 1 0 R /Info 5 0 R' }));
    expect(document.info).toEqual({
      title: 'R\u00e9sum\u00e9',
      author: 'Synthetic',
      creationDate: 'D:20260630120000Z',
      modDate: 'later',
    });
  });

  it('decodes a simple font through /Differences, undecodable glyph names kept undecodable', async () => {
    const fonts =
      '/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [65 /eacute /Euro 1 /g5] >> >>';
    const document = await read(
      one('BT /F1 12 Tf 72 700 Td (AB) Tj 0 -20 Td (C\\001) Tj ET', { fonts }),
    );
    expect(document.pages[0]?.runs[0]).toMatchObject({ text: 'é€' });
    expect(document.pages[0]?.runs[1]).toMatchObject({ text: '', undecodable: true });
    expect(text(document)).toBe('é€\n');
  });

  it('decodes a Type0 font through its ToUnicode map, bfrange arrays included', async () => {
    const cmap = streamBody(
      '',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0001> <0048> endbfchar 1 beginbfrange <0002> <0003> [<0069> <00210021>] endbfrange',
    );
    const fonts =
      '/F1 << /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Synthetic /Encoding /Identity-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /DW 600 /W [1 [700]] >>] /ToUnicode 9 0 R >>';
    const document = await read(
      one('BT /F1 10 Tf 72 700 Td <000100020003> Tj <0004> Tj ET', {
        fonts,
        objects: [{ num: 9, body: cmap }],
      }),
    );
    const [run, missing] = document.pages[0]?.runs ?? [];
    expect(run).toMatchObject({ text: 'Hi!!', font: 'Synthetic' });
    expect(run?.width).toBeCloseTo(7 + 6 + 6, 6);
    expect(missing).toMatchObject({ text: '', undecodable: true });
  });

  it('reads TJ kerning arrays into lines with spaces only at word gaps', async () => {
    const document = await read(one('BT /F1 10 Tf 72 700 Td [(Rev) -20 (enue) -2000 (LTM)] TJ ET'));
    expect(document.pages[0]?.runs.map((r) => r.text)).toEqual(['Rev', 'enue', 'LTM']);
    expect(text(document)).toBe('Revenue LTM');
  });

  it('resolves nested q and cm so positions are page coordinates', async () => {
    const document = await read(
      one('q 1 0 0 1 100 100 cm q 0.5 0 0 0.5 0 0 cm BT /F1 20 Tf 40 40 Td (a) Tj ET Q Q'),
    );
    expect(document.pages[0]?.runs[0]).toMatchObject({ x: 120, y: 120, size: 10, text: 'a' });
  });

  it('reads a file indexed by a cross-reference stream with a predictor and object streams', async () => {
    const stream = assemble(onePage('BT /F1 12 Tf 72 700 Td (Streamed) Tj ET'), {
      trailer: '/Root 1 0 R',
      xref: 'stream',
      xrefStreamEncode: { deflate, predictor: true },
    });
    expect(text(await read(stream))).toBe('Streamed');
  });

  it('reads content streams through FlateDecode with predictors and the ASCII filters', async () => {
    const operators = 'BT /F1 12 Tf 72 700 Td (Filtered) Tj ET';
    const plain = encodeUtf8(operators);
    const hex = Array.from(plain, (b) => b.toString(16).padStart(2, '0')).join('') + '>';
    const variants: [string, Uint8Array | string][] = [
      ['/Filter /FlateDecode', deflate(plain)],
      ['/Filter /ASCIIHexDecode', hex],
      [
        '/Filter [/ASCIIHexDecode /FlateDecode]',
        Array.from(deflate(plain), (b) => b.toString(16).padStart(2, '0')).join('') + '>',
      ],
      ['/Filter /FlateDecode /DecodeParms << /Predictor 2 /Colors 1 /Columns 1 >>', deflate(plain)],
    ];
    for (const [entries, data] of variants) {
      const objects = onePage('').map((o) =>
        o.num === 4 ? { num: 4, body: streamBody(entries, data) } : o,
      );
      expect(text(await read(assemble(objects, { trailer: '/Root 1 0 R' }))), entries).toBe(
        'Filtered',
      );
    }
  });

  it('reports the fallback scan on a damaged file and still reads the text', async () => {
    const bytes = assemble(onePage('BT /F1 12 Tf 72 700 Td (Recovered) Tj ET'), {
      trailer: '/Root 1 0 R',
      startxrefOverride: 10,
    });
    const document = await read(bytes);
    expect(document.reconstructed).toBe(true);
    expect(text(document)).toBe('Recovered');
  });

  it('reads a long run of stray delimiters in a content stream and in a file object (PDF-3)', async () => {
    const content = await read(one(`${')'.repeat(100_000)} BT /F1 12 Tf 72 700 Td (Hi) Tj ET`));
    expect(text(content)).toBe('Hi');
    const junk = assemble(onePage('BT /F1 12 Tf 72 700 Td (Hi) Tj ET'), {
      trailer: `/Root 1 0 R /Junk ${'> '.repeat(50_000)}5`,
    });
    const fileObject = await read(junk);
    expect(fileObject.reconstructed).toBe(false);
    expect(text(fileObject)).toBe('Hi');
  });

  it('round-trips documents the writer produces, runs identical', async () => {
    const input = {
      title: 'Round trip',
      pages: [
        {
          items: [
            {
              kind: 'text' as const,
              x: 72,
              y: 700.5,
              size: 12,
              font: 'Helvetica' as const,
              text: 'EBITDA (LTM): 12.3',
            },
            {
              kind: 'text' as const,
              x: 300,
              y: 700.5,
              size: 12,
              font: 'Helvetica-Bold' as const,
              text: 'USD m',
            },
            { kind: 'line' as const, x1: 72, y1: 690, x2: 400, y2: 690 },
          ],
        },
        {
          items: [
            {
              kind: 'text' as const,
              x: 72,
              y: 100,
              size: 8,
              font: 'Courier-Bold' as const,
              text: 'footnote ©',
            },
          ],
        },
      ],
    };
    const document = await read(writePdf(input));
    expect(
      document.pages.map((p) => p.runs.map((r) => [r.text, r.x, r.y, r.size, r.font])),
    ).toEqual([
      [
        ['EBITDA (LTM): 12.3', 72, 700.5, 12, 'Helvetica'],
        ['USD m', 300, 700.5, 12, 'Helvetica-Bold'],
      ],
      [['footnote ©', 72, 100, 8, 'Courier-Bold']],
    ]);
    expect(document.pages[0]?.text).toBe('EBITDA (LTM): 12.3 USD m');
    expect(document.info.title).toBe('Round trip');
  });

  describe('refusals', () => {
    it('not_pdf', async () => {
      expect((await refusal(() => read(encodeUtf8('hello')))).code).toBe('not_pdf');
    });

    it('invalid_input for bytes that are not a Uint8Array', async () => {
      expect((await refusal(() => readPdf('x' as never, { inflate: nodeInflate }))).code).toBe(
        'invalid_input',
      );
    });

    it('encrypted', async () => {
      const objects = [...onePage(''), { num: 5, body: '<< /Filter /Standard >>' }];
      expect(
        (await refusal(() => read(assemble(objects, { trailer: '/Root 1 0 R /Encrypt 5 0 R' }))))
          .code,
      ).toBe('encrypted');
    });

    it('unsupported: an LZW content stream, a Crypt filter, an image filter on a page', async () => {
      for (const filter of ['/LZWDecode', '/Crypt', '/JBIG2Decode', '/DCTDecode']) {
        const objects = onePage('').map((o) =>
          o.num === 4 ? { num: 4, body: streamBody(`/Filter ${filter}`, 'x') } : o,
        );
        expect(
          (await refusal(() => read(assemble(objects, { trailer: '/Root 1 0 R' })))).code,
          filter,
        ).toBe('unsupported');
      }
    });

    it('skips image XObjects whatever their filter', async () => {
      const objects = [
        ...onePage('/Im1 Do BT /F1 12 Tf (after) Tj ET').map((o) =>
          o.num === 3
            ? {
                ...o,
                body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
              }
            : o,
        ),
        {
          num: 5,
          body: streamBody(
            '/Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode',
            'x',
          ),
        },
      ];
      expect(text(await read(assemble(objects, { trailer: '/Root 1 0 R' })))).toBe('after');
    });

    it('corrupt: no catalog, a catalog that is not a dictionary, no page tree', async () => {
      const noCatalog = assemble([{ num: 5, body: '<< >>' }], { trailer: '/Root 9 0 R' });
      expect((await refusal(() => read(noCatalog))).code).toBe('corrupt');
      const notDict = assemble([{ num: 1, body: '[1 2]' }], { trailer: '/Root 1 0 R' });
      expect((await refusal(() => read(notDict))).code).toBe('corrupt');
      const noPages = assemble([{ num: 1, body: '<< /Type /Catalog >>' }], {
        trailer: '/Root 1 0 R',
      });
      expect((await refusal(() => read(noPages))).code).toBe('corrupt');
    });

    it('too_large: bytes, objects, pages, page tree depth, stream bytes, total stream bytes, operators', async () => {
      const bytes = one('BT /F1 12 Tf (a) Tj ET');
      expect((await refusal(() => read(bytes, { maxBytes: bytes.length - 1 }))).code).toBe(
        'too_large',
      );
      expect((await refusal(() => read(bytes, { maxObjects: 3 }))).code).toBe('too_large');
      expect((await refusal(() => read(bytes, { maxPages: 0 }))).code).toBe('too_large');
      await expect(read(bytes, { maxPages: 1 })).resolves.toMatchObject({ pageCount: 1 });
      // Pages, then an intermediate node, then the page: depth 3.
      const deep: FixtureObject[] = [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>' },
        { num: 4, body: '<< /Type /Page /Parent 3 0 R >>' },
      ];
      expect(
        (await refusal(() => read(assemble(deep, { trailer: '/Root 1 0 R' }), { maxDepth: 2 })))
          .code,
      ).toBe('too_large');
      await expect(
        read(assemble(deep, { trailer: '/Root 1 0 R' }), { maxDepth: 3 }),
      ).resolves.toMatchObject({ pageCount: 1 });
      const big = one(`BT /F1 12 Tf (${'a'.repeat(100)}) Tj ET`);
      expect((await refusal(() => read(big, { maxStreamBytes: 100 }))).code).toBe('too_large');
      await expect(read(big, { maxStreamBytes: 124 })).resolves.toMatchObject({ pageCount: 1 });
      expect((await refusal(() => read(big, { maxTotalStreamBytes: 120 }))).code).toBe('too_large');
      await expect(read(big, { maxTotalStreamBytes: 121 })).resolves.toMatchObject({
        pageCount: 1,
      });
      expect((await refusal(() => read(bytes, { maxOperators: 3 }))).code).toBe('too_large');
      await expect(read(bytes, { maxOperators: 4 })).resolves.toMatchObject({ pageCount: 1 });
    });

    it('stops on a page tree that points back at itself', async () => {
      const objects: FixtureObject[] = [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R 2 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R >>' },
      ];
      await expect(read(assemble(objects, { trailer: '/Root 1 0 R' }))).resolves.toMatchObject({
        pageCount: 1,
      });
    });
  });
});

describe('ASCII85Decode on a content stream', () => {
  it('reads operators encoded with ASCII85', async () => {
    // Encode with the reference algorithm, in the test, so the fixture is exact.
    const plain = encodeUtf8('BT /F1 12 Tf 72 700 Td (Eighty five) Tj ET');
    let encoded = '';
    for (let i = 0; i < plain.length; i += 4) {
      const chunk = plain.subarray(i, i + 4);
      const padded = concatBytes([chunk, new Uint8Array(4 - chunk.length)]);
      let value =
        (padded[0] ?? 0) * 2 ** 24 +
        ((padded[1] ?? 0) << 16) +
        ((padded[2] ?? 0) << 8) +
        (padded[3] ?? 0);
      const digits: string[] = [];
      for (let k = 0; k < 5; k += 1) {
        digits.unshift(String.fromCharCode((value % 85) + 33));
        value = Math.floor(value / 85);
      }
      encoded += digits.join('').slice(0, chunk.length + 1);
    }
    const objects = onePage('').map((o) =>
      o.num === 4 ? { num: 4, body: streamBody('/Filter /ASCII85Decode', `${encoded}~>`) } : o,
    );
    const document = await readPdf(assemble(objects, { trailer: '/Root 1 0 R' }), {
      inflate: nodeInflate,
    });
    expect(document.pages[0]?.text).toBe('Eighty five');
    expect(latin1Bytes(encoded).length).toBeGreaterThan(0);
  });
});
