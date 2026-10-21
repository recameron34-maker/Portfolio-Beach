import { PdfError } from '@pb/pdf';
import type { Inflate } from '@pb/pdf';
import type { InflateRaw } from '@pb/xlsx';

/** The bytes of a view as a plain ArrayBuffer-backed chunk, which a stream accepts (a view over a shared buffer is copied first). */
function chunkOf(data: Uint8Array): BufferSource {
  return data.buffer instanceof ArrayBuffer
    ? (data as Uint8Array<ArrayBuffer>)
    : new Uint8Array(data);
}

/** Inflates one chunk through the platform's DecompressionStream of the format given, refusing output past the cap through `onCap`. */
async function inflateThrough(
  format: CompressionFormat,
  data: Uint8Array,
  maxOutputBytes: number,
  onCap: () => Error,
): Promise<Uint8Array> {
  const chunk = chunkOf(data);
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream(format)).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxOutputBytes) {
      await reader.cancel();
      throw onCap();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const piece of chunks) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

/**
 * The browser inflater for `readPdf` (@pb/pdf): a FlateDecode stream is zlib-wrapped deflate
 * (RFC 1950), which the platform's DecompressionStream('deflate') reads, with the cap the Node
 * inflater gets from zlib's maxOutputLength: output past `maxOutputBytes` is refused while the
 * stream is still being read (PdfError too_large), so a small bundled file cannot fill memory.
 * A stream the platform cannot decode is a corrupt one, as the Node inflater reports it.
 */
export const browserInflate: Inflate = async (data, maxOutputBytes) => {
  try {
    return await inflateThrough(
      'deflate',
      data,
      maxOutputBytes,
      () => new PdfError('a stream inflates past the limit', 'too_large'),
    );
  } catch (error) {
    if (error instanceof PdfError) throw error;
    throw new PdfError('a FlateDecode stream could not be inflated', 'corrupt', { cause: error });
  }
};

/**
 * The browser inflater for `readWorkbook` (@pb/xlsx): raw deflate through the platform's
 * DecompressionStream('deflate-raw'), as the package README shows, with the one guard the Node
 * inflater gets from zlib's maxOutputLength: an entry that inflates past the size the archive
 * declares is refused while it is still being read, so a small upload cannot fill memory.
 */
export const browserInflateRaw: InflateRaw = (data, uncompressedSize) =>
  inflateThrough(
    'deflate-raw',
    data,
    uncompressedSize,
    () => new Error('The entry inflates past the size the archive declares'),
  );

/** The bytes of a base64 text, as an upload body carries a workbook; throws on text that is not base64. */
export function bytesOfBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
