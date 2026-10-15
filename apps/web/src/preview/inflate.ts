import type { InflateRaw } from '@pb/xlsx';

/**
 * The browser inflater for `readWorkbook` (@pb/xlsx): raw deflate through the platform's
 * DecompressionStream('deflate-raw'), as the package README shows, with the one guard the Node
 * inflater gets from zlib's maxOutputLength: an entry that inflates past the size the archive
 * declares is refused while it is still being read, so a small upload cannot fill memory.
 */
export const browserInflateRaw: InflateRaw = async (data, uncompressedSize) => {
  // The stream takes a view over a plain ArrayBuffer; a view over a shared buffer is copied first.
  const chunk: BufferSource =
    data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data);
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > uncompressedSize) {
      await reader.cancel();
      throw new Error('The entry inflates past the size the archive declares');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/** The bytes of a base64 text, as an upload body carries a workbook; throws on text that is not base64. */
export function bytesOfBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
