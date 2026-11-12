/**
 * Stream filters (ISO 32000-1 section 7.4): FlateDecode through the injected inflater, the
 * predictors of its /DecodeParms (TIFF predictor 2, PNG predictors 10 to 15), ASCIIHexDecode,
 * ASCII85Decode and RunLengthDecode. Every other filter is refused by name: LZWDecode (patent
 * history and no need), the image filters (DCTDecode, JPXDecode, JBIG2Decode, CCITTFaxDecode,
 * which only images carry; the reader never decodes an image stream) and Crypt.
 */
import { hexValue, isWhitespace } from './bytes.js';
import { PdfError } from './errors.js';

/**
 * Inflates one zlib-wrapped deflate stream (RFC 1950, which is what FlateDecode holds).
 * `maxOutputBytes` is the most the caller will accept: an implementation that can cap its output
 * (Node's zlib) throws a `PdfError` with code `too_large` past it; the reader checks the length
 * afterwards in any case. May be synchronous or return a promise.
 */
export type Inflate = (
  data: Uint8Array,
  maxOutputBytes: number,
) => Uint8Array | Promise<Uint8Array>;

export interface DecodeParms {
  predictor: number;
  colors: number;
  bitsPerComponent: number;
  columns: number;
}

export const DEFAULT_DECODE_PARMS: Readonly<DecodeParms> = Object.freeze({
  predictor: 1,
  colors: 1,
  bitsPerComponent: 8,
  columns: 1,
});

const IMAGE_FILTERS = new Set([
  'DCTDecode',
  'DCT',
  'JPXDecode',
  'JBIG2Decode',
  'CCITTFaxDecode',
  'CCF',
]);

/** Whether a filter name is one the reader never decodes because only images carry it. */
export function isImageFilter(filter: string): boolean {
  return IMAGE_FILTERS.has(filter);
}

/**
 * The output of a decoder, capped at `max` bytes: the decoders write into it as they go and it
 * refuses (`too_large`) the moment the output would pass the cap, so a small stream that expands
 * many times over (RunLength, ASCII85 "z" groups) never fills memory before the limit is seen.
 * The buffer grows by doubling, never past the cap.
 */
class ByteSink {
  private buffer: Uint8Array;
  private length = 0;

  constructor(
    private readonly max: number,
    initial: number,
    private readonly filter: string,
  ) {
    this.buffer = new Uint8Array(Math.max(0, Math.floor(Math.min(max, initial))));
  }

  private reserve(count: number): void {
    const needed = this.length + count;
    if (needed > this.max) {
      throw new PdfError(
        `A ${this.filter} stream decodes to more than the ${this.max} bytes the reader accepts`,
        'too_large',
      );
    }
    if (needed > this.buffer.length) {
      const grown = new Uint8Array(Math.min(this.max, Math.max(needed, this.buffer.length * 2)));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
  }

  push(byte: number): void {
    this.reserve(1);
    this.buffer[this.length] = byte;
    this.length += 1;
  }

  fill(byte: number, count: number): void {
    this.reserve(count);
    this.buffer.fill(byte, this.length, this.length + count);
    this.length += count;
  }

  copy(source: Uint8Array, from: number, count: number): void {
    this.reserve(count);
    this.buffer.set(source.subarray(from, from + count), this.length);
    this.length += count;
  }

  bytes(): Uint8Array {
    return this.buffer.length === this.length ? this.buffer : this.buffer.slice(0, this.length);
  }
}

/** Decodes ASCIIHexDecode data; refuses (`too_large`) output past `maxOutputBytes`. */
export function asciiHexDecode(data: Uint8Array, maxOutputBytes: number): Uint8Array {
  const out = new ByteSink(maxOutputBytes, (data.length + 1) >>> 1, 'ASCIIHexDecode');
  let pending = -1;
  for (const b of data) {
    if (b === 0x3e) break;
    if (isWhitespace(b)) continue;
    const v = hexValue(b);
    if (v < 0) {
      throw new PdfError(
        `An ASCIIHexDecode stream holds "${String.fromCharCode(b)}", which is not a hexadecimal digit`,
        'corrupt',
      );
    }
    if (pending < 0) pending = v;
    else {
      out.push(pending * 16 + v);
      pending = -1;
    }
  }
  if (pending >= 0) out.push(pending * 16);
  return out.bytes();
}

/** Decodes ASCII85Decode data; refuses (`too_large`) output past `maxOutputBytes`. */
export function ascii85Decode(data: Uint8Array, maxOutputBytes: number): Uint8Array {
  const out = new ByteSink(maxOutputBytes, data.length, 'ASCII85Decode');
  let start = 0;
  while (start < data.length && isWhitespace(data[start] ?? 0)) start += 1;
  if (data[start] === 0x3c && data[start + 1] === 0x7e) start += 2;
  const group: number[] = [];
  const flush = (count: number): void => {
    // A partial final group is padded with "u" (84) and the padding bytes dropped.
    const padded = [...group];
    while (padded.length < 5) padded.push(84);
    let value = 0;
    for (const digit of padded) value = value * 85 + digit;
    if (value > 0xffffffff) {
      throw new PdfError('An ASCII85Decode stream holds a group past the 32-bit range', 'corrupt');
    }
    const bytes = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    for (let k = 0; k < count - 1; k += 1) out.push(bytes[k] ?? 0);
    group.length = 0;
  };
  for (let i = start; i < data.length; i += 1) {
    const b = data[i] ?? 0;
    if (isWhitespace(b)) continue;
    if (b === 0x7e) break;
    if (b === 0x7a && group.length === 0) {
      out.fill(0, 4);
      continue;
    }
    if (b < 0x21 || b > 0x75) {
      throw new PdfError(
        `An ASCII85Decode stream holds "${String.fromCharCode(b)}", which is outside its alphabet`,
        'corrupt',
      );
    }
    group.push(b - 33);
    if (group.length === 5) flush(5);
  }
  if (group.length === 1) {
    throw new PdfError(
      'An ASCII85Decode stream ends with a single digit, which encodes nothing',
      'corrupt',
    );
  }
  if (group.length > 1) flush(group.length);
  return out.bytes();
}

/** Decodes RunLengthDecode data; refuses (`too_large`) output past `maxOutputBytes`. */
export function runLengthDecode(data: Uint8Array, maxOutputBytes: number): Uint8Array {
  const out = new ByteSink(maxOutputBytes, data.length, 'RunLengthDecode');
  let i = 0;
  while (i < data.length) {
    const length = data[i] ?? 0;
    i += 1;
    if (length === 128) break;
    if (length < 128) {
      if (i + length + 1 > data.length) {
        throw new PdfError('A RunLengthDecode stream ends inside a literal run', 'corrupt');
      }
      out.copy(data, i, length + 1);
      i += length + 1;
    } else {
      if (i >= data.length) {
        throw new PdfError('A RunLengthDecode stream ends inside a repeated run', 'corrupt');
      }
      const byte = data[i] ?? 0;
      i += 1;
      out.fill(byte, 257 - length);
    }
  }
  return out.bytes();
}

/**
 * Undoes a predictor (ISO 32000-1 table 8): TIFF predictor 2 (horizontal differencing, 8 bits
 * per component) or the PNG predictors 10 to 15, where every row starts with its filter type
 * byte (0 none, 1 sub, 2 up, 3 average, 4 Paeth; PNG specification section 9) whatever the
 * /Predictor value said, as the specification requires.
 */
export function applyPredictor(data: Uint8Array, parms: DecodeParms): Uint8Array {
  const { predictor, colors, bitsPerComponent, columns } = parms;
  if (predictor <= 1) return data;
  if (!Number.isInteger(colors) || colors < 1 || colors > 64) {
    throw new PdfError(
      `A predictor with ${colors} colors is not one the reader accepts`,
      'corrupt',
    );
  }
  if (![1, 2, 4, 8, 16].includes(bitsPerComponent)) {
    throw new PdfError(
      `A predictor with ${bitsPerComponent} bits per component is not one the reader accepts`,
      'corrupt',
    );
  }
  if (!Number.isInteger(columns) || columns < 1 || columns > 1 << 24) {
    throw new PdfError(
      `A predictor with ${columns} columns is not one the reader accepts`,
      'corrupt',
    );
  }
  const bpp = Math.ceil((colors * bitsPerComponent) / 8);
  const rowLength = Math.ceil((colors * bitsPerComponent * columns) / 8);
  if (predictor === 2) {
    if (bitsPerComponent !== 8) {
      throw new PdfError(
        `A TIFF predictor with ${bitsPerComponent} bits per component is not supported by the reader`,
        'unsupported',
      );
    }
    if (data.length % rowLength !== 0) {
      throw new PdfError('A TIFF-predicted stream does not hold whole rows', 'corrupt');
    }
    const out = new Uint8Array(data);
    for (let row = 0; row < out.length; row += rowLength) {
      for (let i = bpp; i < rowLength; i += 1) {
        out[row + i] = ((out[row + i] ?? 0) + (out[row + i - bpp] ?? 0)) & 0xff;
      }
    }
    return out;
  }
  if (predictor < 10 || predictor > 15) {
    throw new PdfError(`Predictor ${predictor} is not one the reader knows`, 'unsupported');
  }
  if (data.length % (rowLength + 1) !== 0) {
    throw new PdfError('A PNG-predicted stream does not hold whole rows', 'corrupt');
  }
  const rows = data.length / (rowLength + 1);
  const out = new Uint8Array(rows * rowLength);
  let previous = new Uint8Array(rowLength);
  for (let r = 0; r < rows; r += 1) {
    const type = data[r * (rowLength + 1)] ?? 0;
    const src = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const row = out.subarray(r * rowLength, (r + 1) * rowLength);
    for (let i = 0; i < rowLength; i += 1) {
      const raw = src[i] ?? 0;
      const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
      let value: number;
      switch (type) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + Math.floor((left + up) / 2);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          value = raw + predicted;
          break;
        }
        default:
          throw new PdfError(
            `A PNG-predicted stream holds row filter type ${type}, which does not exist`,
            'corrupt',
          );
      }
      row[i] = value & 0xff;
    }
    previous = row;
  }
  return out;
}

/** The limits one stream decode works to. */
export interface StreamLimits {
  /** The most bytes one stream may hold once decoded. */
  maxStreamBytes: number;
}

/**
 * Applies one named filter. FlateDecode goes through the injected inflater with the stream limit
 * as its cap, and the result is checked against the limit in any case (an inflater without a cap
 * returns the whole output, which is then refused). The ASCII and run-length decoders refuse as
 * they decode, the moment their output would pass the limit.
 */
export async function applyFilter(
  filter: string,
  data: Uint8Array,
  parms: DecodeParms,
  inflate: Inflate,
  limits: StreamLimits,
): Promise<Uint8Array> {
  const flate = filter === 'FlateDecode' || filter === 'Fl';
  let out: Uint8Array;
  switch (filter) {
    case 'FlateDecode':
    case 'Fl': {
      try {
        out = await inflate(data, limits.maxStreamBytes);
      } catch (cause) {
        if (cause instanceof PdfError) throw cause;
        throw new PdfError('A FlateDecode stream could not be inflated', 'corrupt', { cause });
      }
      break;
    }
    case 'ASCIIHexDecode':
    case 'AHx':
      out = asciiHexDecode(data, limits.maxStreamBytes);
      break;
    case 'ASCII85Decode':
    case 'A85':
      out = ascii85Decode(data, limits.maxStreamBytes);
      break;
    case 'RunLengthDecode':
    case 'RL':
      out = runLengthDecode(data, limits.maxStreamBytes);
      break;
    case 'LZWDecode':
    case 'LZW':
      throw new PdfError(
        'The document uses LZW compression, which the reader does not support',
        'unsupported',
      );
    case 'Crypt':
      throw new PdfError(
        'The document uses a Crypt filter, which the reader does not support',
        'unsupported',
      );
    default:
      if (isImageFilter(filter)) {
        throw new PdfError(
          `A stream that is not an image uses the image filter ${filter}, which the reader does not decode`,
          'unsupported',
        );
      }
      throw new PdfError(
        `The document uses the filter ${filter}, which the reader does not know`,
        'unsupported',
      );
  }
  if (out.length > limits.maxStreamBytes) {
    throw new PdfError(
      `A stream decodes to ${out.length} bytes, more than the ${limits.maxStreamBytes} the reader accepts`,
      'too_large',
    );
  }
  if (flate) {
    out = applyPredictor(out, parms);
  }
  return out;
}
