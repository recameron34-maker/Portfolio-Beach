import { describe, expect, it } from 'vitest';
import {
  bankDetails,
  decryptBankDetails,
  DEV_FIELD_KEY,
  encryptBankDetails,
  FieldCipher,
  fieldKeyFromEnv,
  maskBankDetails,
} from './fieldCrypto.js';

const details = {
  bankName: 'Harbor Street Bank',
  accountName: 'Harborlight Fund IV',
  accountNumber: '4455667788',
  routingCode: '021000021',
  reference: 'HLF IV capital call 12',
};

/** Flips one byte of a base64 ciphertext at the given offset and re-encodes it. */
function tamper(ciphertext: string, offset: number): string {
  const bytes = Buffer.from(ciphertext, 'base64');
  const index = offset < 0 ? bytes.length + offset : offset;
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return bytes.toString('base64');
}

describe('field encryption (SEC-12.2, decision 0013)', () => {
  const cipher = new FieldCipher(DEV_FIELD_KEY);

  it('round-trips a value and never leaves the plaintext in the ciphertext', () => {
    const ciphertext = cipher.encrypt('4455667788');
    expect(cipher.decrypt(ciphertext)).toBe('4455667788');
    expect(ciphertext).not.toContain('4455667788');
    expect(Buffer.from(ciphertext, 'base64').toString('latin1')).not.toContain('4455667788');
  });

  it('uses a fresh nonce per call, so the same value never encrypts the same way twice', () => {
    const a = cipher.encrypt('same value');
    const b = cipher.encrypt('same value');
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe('same value');
    expect(cipher.decrypt(b)).toBe('same value');
  });

  it('round-trips an empty string and unicode', () => {
    expect(cipher.decrypt(cipher.encrypt(''))).toBe('');
    const text = 'Banque de l’Estuaire €';
    expect(cipher.decrypt(cipher.encrypt(text))).toBe(text);
  });

  it('detects tampering of the body, the tag and the nonce', () => {
    const ciphertext = cipher.encrypt(JSON.stringify(details));
    expect(() => cipher.decrypt(tamper(ciphertext, -1))).toThrow();
    expect(() => cipher.decrypt(tamper(ciphertext, 12))).toThrow();
    expect(() => cipher.decrypt(tamper(ciphertext, 0))).toThrow();
  });

  it('refuses a truncated or malformed ciphertext', () => {
    expect(() => cipher.decrypt('')).toThrow(/too short/);
    expect(() => cipher.decrypt('AAAA')).toThrow(/too short/);
  });

  it('cannot be decrypted with a different key', () => {
    const otherKey = new Uint8Array(32);
    otherKey.fill(7);
    const other = new FieldCipher(otherKey);
    const ciphertext = cipher.encrypt('4455667788');
    expect(() => other.decrypt(ciphertext)).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => new FieldCipher(new Uint8Array(16))).toThrow(/32 bytes/);
    expect(() => new FieldCipher(new Uint8Array(33))).toThrow(/32 bytes/);
    expect(DEV_FIELD_KEY.byteLength).toBe(32);
  });

  it('does not share the caller buffer: a later change to the key bytes leaves the cipher intact', () => {
    const key = new Uint8Array(32);
    key.fill(1);
    const c = new FieldCipher(key);
    const ciphertext = c.encrypt('x');
    key.fill(2);
    expect(c.decrypt(ciphertext)).toBe('x');
  });
});

describe('fieldKeyFromEnv', () => {
  it('returns null when PB_FIELD_KEY_HEX is unset or empty', () => {
    expect(fieldKeyFromEnv({})).toBeNull();
    expect(fieldKeyFromEnv({ PB_FIELD_KEY_HEX: '' })).toBeNull();
  });

  it('reads 64 hex characters into 32 bytes', () => {
    const hex = 'ab'.repeat(32);
    const key = fieldKeyFromEnv({ PB_FIELD_KEY_HEX: hex });
    expect(key).not.toBeNull();
    expect(key?.byteLength).toBe(32);
    expect(key?.[0]).toBe(0xab);
    expect(fieldKeyFromEnv({ PB_FIELD_KEY_HEX: hex.toUpperCase() })?.[31]).toBe(0xab);
  });

  it('fails loudly on a malformed key instead of falling back to the prototype key', () => {
    expect(() => fieldKeyFromEnv({ PB_FIELD_KEY_HEX: 'ab'.repeat(31) })).toThrow(/64 hex/);
    expect(() => fieldKeyFromEnv({ PB_FIELD_KEY_HEX: 'zz'.repeat(32) })).toThrow(/64 hex/);
  });
});

describe('bank details', () => {
  it('masks everything but the bank name and the last four digits', () => {
    const masked = maskBankDetails(details);
    expect(masked).toBe('Harbor Street Bank ****7788');
    expect(masked).not.toContain('021000021');
    expect(masked).not.toContain('445566');
    expect(masked).not.toContain(details.accountName);
  });

  it('accepts digit-only account and routing identifiers of 6 to 20 characters', () => {
    expect(bankDetails.safeParse(details).success).toBe(true);
    expect(bankDetails.safeParse({ ...details, reference: undefined }).success).toBe(true);
    expect(bankDetails.safeParse({ ...details, accountNumber: '12345' }).success).toBe(false);
    expect(bankDetails.safeParse({ ...details, accountNumber: '1'.repeat(21) }).success).toBe(
      false,
    );
    expect(bankDetails.safeParse({ ...details, routingCode: 'ABC123456' }).success).toBe(false);
    expect(bankDetails.safeParse({ ...details, bankName: '' }).success).toBe(false);
    expect(bankDetails.safeParse({ ...details, accountName: '' }).success).toBe(false);
  });

  it('encrypts the details as one JSON document and reads them back validated', () => {
    const cipher = new FieldCipher(DEV_FIELD_KEY);
    const ciphertext = encryptBankDetails(cipher, details);
    expect(decryptBankDetails(cipher, ciphertext)).toEqual(details);
    const withoutReference = { ...details, reference: undefined };
    expect(decryptBankDetails(cipher, encryptBankDetails(cipher, withoutReference))).toEqual({
      bankName: details.bankName,
      accountName: details.accountName,
      accountNumber: details.accountNumber,
      routingCode: details.routingCode,
    });
    // A ciphertext of something that is not bank details is refused by the schema, not returned.
    expect(() => decryptBankDetails(cipher, cipher.encrypt('{"bankName":"x"}'))).toThrow();
  });
});
