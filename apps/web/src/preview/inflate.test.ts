import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PdfError, readPdf, writePdf } from '@pb/pdf';
import { browserInflate, browserInflateRaw, bytesOfBase64 } from './inflate.js';

/**
 * The browser inflaters over the platform's DecompressionStream: zlib-wrapped deflate for a PDF's
 * FlateDecode streams, raw deflate for a workbook's entries, each refusing output past its cap.
 */
const text = new TextEncoder().encode('BT /F1 12 Tf 72 720 Td (hello) Tj ET '.repeat(40));

describe('browserInflate for @pb/pdf', () => {
  it('inflates a zlib-wrapped stream and refuses one past the cap or one it cannot read', async () => {
    const deflated = new Uint8Array(deflateSync(text));
    expect([...(await browserInflate(deflated, text.length))]).toEqual([...text]);
    await expect(browserInflate(deflated, text.length - 1)).rejects.toMatchObject({
      code: 'too_large',
    });
    const garbage = browserInflate(new Uint8Array([1, 2, 3, 4, 5]), 1000);
    await expect(garbage).rejects.toBeInstanceOf(PdfError);
    await expect(garbage).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('reads a written PDF through readPdf with the browser inflater, runs and lines included', async () => {
    const bytes = writePdf({
      title: 'Synthetic test',
      pages: [
        {
          items: [
            {
              kind: 'text',
              x: 72,
              y: 720,
              size: 12,
              font: 'Helvetica',
              text: 'LTM revenue 125.40',
            },
          ],
        },
      ],
    });
    const doc = await readPdf(bytes, { inflate: browserInflate });
    expect(doc.pageCount).toBe(1);
    expect(doc.info.title).toBe('Synthetic test');
    expect(doc.pages[0]?.lines.map((l) => l.text)).toEqual(['LTM revenue 125.40']);
    expect(doc.pages[0]?.runs[0]).toMatchObject({ x: 72, y: 720, size: 12 });
  });
});

describe('browserInflateRaw for @pb/xlsx', () => {
  it('inflates a raw deflate entry up to the size the archive declares', async () => {
    const deflated = new Uint8Array(deflateRawSync(text));
    expect([...(await browserInflateRaw(deflated, text.length))]).toEqual([...text]);
    await expect(browserInflateRaw(deflated, 10)).rejects.toThrow(
      'The entry inflates past the size the archive declares',
    );
    expect(bytesOfBase64('aGk=')).toEqual(new Uint8Array([104, 105]));
  });
});
