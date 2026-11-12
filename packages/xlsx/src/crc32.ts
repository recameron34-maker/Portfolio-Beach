/** CRC-32 (IEEE 802.3, the zip checksum) over bytes, as an unsigned 32-bit integer. */

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = ((TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
