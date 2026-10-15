import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { latin1Bytes } from './bytes.js';
import { PdfError } from './errors.js';
import {
  DEFAULT_DECODE_PARMS,
  applyFilter,
  applyPredictor,
  ascii85Decode,
  asciiHexDecode,
  isImageFilter,
  runLengthDecode,
  type DecodeParms,
} from './filters.js';
import { nodeInflate } from './node.js';

const parms = (over: Partial<DecodeParms>): DecodeParms => ({ ...DEFAULT_DECODE_PARMS, ...over });

async function refusal(run: () => unknown): Promise<PdfError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfError);
    return error as PdfError;
  }
  throw new Error('expected a PdfError');
}

describe('asciiHexDecode', () => {
  it('decodes pairs, skips white space, pads an odd digit and stops at >', () => {
    expect(asciiHexDecode(latin1Bytes('48 65\n6c6C 6F>ignored'))).toEqual(latin1Bytes('Hello'));
    expect(asciiHexDecode(latin1Bytes('4'))).toEqual(new Uint8Array([0x40]));
    expect(asciiHexDecode(latin1Bytes(''))).toEqual(new Uint8Array(0));
  });

  it('refuses a digit that is not hexadecimal', async () => {
    expect((await refusal(() => asciiHexDecode(latin1Bytes('4G')))).code).toBe('corrupt');
  });
});

describe('ascii85Decode', () => {
  it('decodes whole groups, a partial group, z and the <~ ~> markers', () => {
    expect(ascii85Decode(latin1Bytes('87cURD_*#4DfTZ)~>'))).toEqual(latin1Bytes('Hello, World'));
    expect(ascii85Decode(latin1Bytes('<~87cURD_*#4DfTZ)~>'))).toEqual(latin1Bytes('Hello, World'));
    expect(ascii85Decode(latin1Bytes('87cU\nRD_*#4DfTZ)'))).toEqual(latin1Bytes('Hello, World'));
    expect(ascii85Decode(latin1Bytes('z~>'))).toEqual(new Uint8Array([0, 0, 0, 0]));
    expect(ascii85Decode(latin1Bytes('~>'))).toEqual(new Uint8Array(0));
  });

  it('refuses a character outside the alphabet, a single trailing digit and an overflow', async () => {
    expect((await refusal(() => ascii85Decode(latin1Bytes('87cUv')))).code).toBe('corrupt');
    expect((await refusal(() => ascii85Decode(latin1Bytes('87cUR8')))).code).toBe('corrupt');
    expect((await refusal(() => ascii85Decode(latin1Bytes('uuuuu')))).code).toBe('corrupt');
  });
});

describe('runLengthDecode', () => {
  it('decodes literal and repeated runs and stops at 128', () => {
    const data = new Uint8Array([2, 0x61, 0x62, 0x63, 254, 0x7a, 128, 0x41]);
    expect(runLengthDecode(data)).toEqual(latin1Bytes('abczzz'));
  });

  it('refuses runs that end early', async () => {
    expect((await refusal(() => runLengthDecode(new Uint8Array([3, 0x61])))).code).toBe('corrupt');
    expect((await refusal(() => runLengthDecode(new Uint8Array([254])))).code).toBe('corrupt');
  });
});

describe('applyPredictor', () => {
  it('returns the data unchanged for predictor 1', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(applyPredictor(data, parms({ predictor: 1 }))).toBe(data);
  });

  it('undoes TIFF predictor 2 with 8-bit components', () => {
    const encoded = new Uint8Array([10, 5, 5, 20, 1, 1]);
    expect(applyPredictor(encoded, parms({ predictor: 2, columns: 3 }))).toEqual(
      new Uint8Array([10, 15, 20, 20, 21, 22]),
    );
    const rgb = new Uint8Array([1, 2, 3, 1, 1, 1]);
    expect(applyPredictor(rgb, parms({ predictor: 2, colors: 3, columns: 2 }))).toEqual(
      new Uint8Array([1, 2, 3, 2, 3, 4]),
    );
  });

  it('undoes every PNG row filter, whatever the predictor value from 10 to 15', () => {
    // Rows of 3 bytes, each prefixed by its filter type.
    const encoded = new Uint8Array([
      0,
      1,
      2,
      3, // none: 1 2 3
      1,
      1,
      1,
      1, // sub: 1 2 3
      2,
      1,
      1,
      1, // up: 2 3 4
      3,
      2,
      2,
      2, // average: floor((left+up)/2)+raw: 3, 5, 6
      4,
      1,
      1,
      1, // paeth
    ]);
    const expected = [1, 2, 3, 1, 2, 3, 2, 3, 4, 3, 5, 6];
    const decoded = applyPredictor(encoded, parms({ predictor: 12, columns: 3 }));
    expect(Array.from(decoded.subarray(0, 12))).toEqual(expected);
    // Paeth row over previous (3, 5, 6): first byte left=0 up=3 upLeft=0 -> p=3, pa=3 pb=0 pc=3 -> up: 4
    expect(decoded[12]).toBe(4);
    for (const predictor of [10, 11, 13, 14, 15]) {
      expect(applyPredictor(encoded, parms({ predictor, columns: 3 }))).toEqual(decoded);
    }
  });

  it('handles 16-bit and sub-byte components through the byte width', () => {
    const encoded = new Uint8Array([1, 0, 1, 0, 1]);
    expect(
      applyPredictor(encoded, parms({ predictor: 11, bitsPerComponent: 16, columns: 2 })),
    ).toEqual(new Uint8Array([0, 1, 0, 2]));
    const bits = new Uint8Array([1, 0x0f, 0x01]);
    expect(
      applyPredictor(bits, parms({ predictor: 11, bitsPerComponent: 1, columns: 16 })),
    ).toEqual(new Uint8Array([0x0f, 0x10]));
  });

  it('refuses partial rows, unknown row filters, bad parameters and unknown predictors', async () => {
    expect(
      (
        await refusal(() =>
          applyPredictor(new Uint8Array([0, 1]), parms({ predictor: 12, columns: 2 })),
        )
      ).code,
    ).toBe('corrupt');
    expect(
      (await refusal(() => applyPredictor(new Uint8Array([5, 1]), parms({ predictor: 12 })))).code,
    ).toBe('corrupt');
    expect(
      (
        await refusal(() =>
          applyPredictor(new Uint8Array([1, 2, 3]), parms({ predictor: 2, columns: 2 })),
        )
      ).code,
    ).toBe('corrupt');
    expect(
      (
        await refusal(() =>
          applyPredictor(new Uint8Array([1]), parms({ predictor: 2, bitsPerComponent: 16 })),
        )
      ).code,
    ).toBe('unsupported');
    expect(
      (await refusal(() => applyPredictor(new Uint8Array([1]), parms({ predictor: 3 })))).code,
    ).toBe('unsupported');
    expect(
      (
        await refusal(() =>
          applyPredictor(new Uint8Array([1]), parms({ predictor: 12, colors: 0 })),
        )
      ).code,
    ).toBe('corrupt');
    expect(
      (
        await refusal(() =>
          applyPredictor(new Uint8Array([1]), parms({ predictor: 12, bitsPerComponent: 3 })),
        )
      ).code,
    ).toBe('corrupt');
    expect(
      (
        await refusal(() =>
          applyPredictor(new Uint8Array([1]), parms({ predictor: 12, columns: 0 })),
        )
      ).code,
    ).toBe('corrupt');
  });
});

describe('applyFilter', () => {
  const limits = { maxStreamBytes: 1000 };

  it('inflates FlateDecode through the injected inflater and applies the predictor', async () => {
    const plain = latin1Bytes('deflate me');
    const deflated = new Uint8Array(deflateSync(plain));
    expect(
      await applyFilter('FlateDecode', deflated, DEFAULT_DECODE_PARMS, nodeInflate, limits),
    ).toEqual(plain);
    expect(await applyFilter('Fl', deflated, DEFAULT_DECODE_PARMS, nodeInflate, limits)).toEqual(
      plain,
    );
    const predicted = new Uint8Array(deflateSync(new Uint8Array([2, 1, 1, 2, 1, 1])));
    expect(
      await applyFilter(
        'FlateDecode',
        predicted,
        parms({ predictor: 12, columns: 2 }),
        nodeInflate,
        limits,
      ),
    ).toEqual(new Uint8Array([1, 1, 2, 2]));
  });

  it('runs the ASCII and run-length filters by their long and short names', async () => {
    for (const [long, short, data] of [
      ['ASCIIHexDecode', 'AHx', latin1Bytes('6869>')],
      ['ASCII85Decode', 'A85', latin1Bytes('BP@~>')],
      ['RunLengthDecode', 'RL', new Uint8Array([1, 0x68, 0x69, 128])],
    ] as const) {
      expect(await applyFilter(long, data, DEFAULT_DECODE_PARMS, nodeInflate, limits)).toEqual(
        latin1Bytes('hi'),
      );
      expect(await applyFilter(short, data, DEFAULT_DECODE_PARMS, nodeInflate, limits)).toEqual(
        latin1Bytes('hi'),
      );
    }
  });

  it('refuses output past the stream limit, at the boundary', async () => {
    const data = latin1Bytes('x'.repeat(1001));
    const deflated = new Uint8Array(deflateSync(data));
    expect(
      (
        await refusal(() =>
          applyFilter('FlateDecode', deflated, DEFAULT_DECODE_PARMS, nodeInflate, limits),
        )
      ).code,
    ).toBe('too_large');
    const exact = new Uint8Array(deflateSync(latin1Bytes('x'.repeat(1000))));
    expect(
      (await applyFilter('FlateDecode', exact, DEFAULT_DECODE_PARMS, nodeInflate, limits)).length,
    ).toBe(1000);
    // An inflater that does not cap its output is still refused by the length check.
    const uncapped = (): Uint8Array => data;
    expect(
      (
        await refusal(() =>
          applyFilter('FlateDecode', deflated, DEFAULT_DECODE_PARMS, uncapped, limits),
        )
      ).code,
    ).toBe('too_large');
    const hex = latin1Bytes('41'.repeat(1001));
    expect(
      (
        await refusal(() =>
          applyFilter('ASCIIHexDecode', hex, DEFAULT_DECODE_PARMS, nodeInflate, limits),
        )
      ).code,
    ).toBe('too_large');
  });

  it('maps an inflater failure to corrupt and keeps a PdfError it throws', async () => {
    expect(
      (
        await refusal(() =>
          applyFilter(
            'FlateDecode',
            latin1Bytes('nope'),
            DEFAULT_DECODE_PARMS,
            nodeInflate,
            limits,
          ),
        )
      ).code,
    ).toBe('corrupt');
    const refusing = (): Uint8Array => {
      throw new PdfError('cap', 'too_large');
    };
    expect(
      (
        await refusal(() =>
          applyFilter('FlateDecode', latin1Bytes('x'), DEFAULT_DECODE_PARMS, refusing, limits),
        )
      ).code,
    ).toBe('too_large');
    const failing = (): Uint8Array => {
      throw new Error('boom');
    };
    expect(
      (
        await refusal(() =>
          applyFilter('FlateDecode', latin1Bytes('x'), DEFAULT_DECODE_PARMS, failing, limits),
        )
      ).code,
    ).toBe('corrupt');
  });

  it('refuses LZW, Crypt, image filters and unknown filters by name', async () => {
    for (const filter of [
      'LZWDecode',
      'LZW',
      'Crypt',
      'DCTDecode',
      'JPXDecode',
      'JBIG2Decode',
      'CCITTFaxDecode',
      'Mystery',
    ]) {
      const error = await refusal(() =>
        applyFilter(filter, latin1Bytes('x'), DEFAULT_DECODE_PARMS, nodeInflate, limits),
      );
      expect(error.code).toBe('unsupported');
    }
    expect(isImageFilter('DCTDecode')).toBe(true);
    expect(isImageFilter('FlateDecode')).toBe(false);
  });
});
