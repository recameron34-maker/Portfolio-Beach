/**
 * Byte helpers shared by the zip and XML layers. UTF-8 goes through the TextEncoder and
 * TextDecoder globals, which Node and every browser provide, so nothing here imports a runtime.
 */
import { WorkbookError } from './errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decodes UTF-8 strictly: a byte sequence that is not UTF-8 refuses rather than guesses. */
export function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return decoder.decode(bytes);
  } catch (cause) {
    throw new WorkbookError(`${what} is not UTF-8 text`, 'malformed', { cause });
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A little-endian view over exactly the bytes given, whatever buffer they sit in. */
export function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
