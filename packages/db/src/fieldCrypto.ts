import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Field-level encryption for the wire instruction register (docs/05 SEC-12.2, decision 0013).
 *
 * Bank details are encrypted at the application layer before they reach `mon.wire_instruction.
 * bank_details_enc` and are never stored in plaintext, logged or sent to a model (SEC-12.1). The
 * scheme is AES-256-GCM with a fresh 96-bit nonce per call; the stored value is
 * `base64(iv || tag || ciphertext)`, so one column carries everything the decrypt needs and any
 * change to a byte of it is detected by the tag.
 *
 * The key comes from the environment as `PB_FIELD_KEY_HEX` (64 hex characters). In production it
 * is loaded from Key Vault by the deployment; the prototype has no vault, so when the variable is
 * unset outside production the loader and the API fall back to DEV_FIELD_KEY, a fixed, documented
 * key that protects nothing and exists so synthetic datasets load without configuration. The
 * production guard in apps/api/src/composition.ts (SEC-17.6) refuses to start in production without
 * a real key; this module only reads and validates what it is given.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class FieldCipher {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== KEY_BYTES) throw new Error(`a field key is ${KEY_BYTES} bytes`);
    // A copy: the caller's buffer may be reused or wiped later.
    this.#key = Buffer.from(key);
  }

  /** Returns base64(iv || tag || ciphertext). A fresh random nonce every call. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  /** Throws when the value was not produced with this key or any byte of it changed. */
  decrypt(ciphertext: string): string {
    const bytes = Buffer.from(ciphertext, 'base64');
    if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext is too short');
    const iv = bytes.subarray(0, IV_BYTES);
    const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = bytes.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}

/**
 * Reads the field key from `PB_FIELD_KEY_HEX`. Null when the variable is unset or empty (the
 * caller decides whether a fallback is allowed); a set but malformed value is an error, never a
 * silent fallback to the prototype key.
 */
export function fieldKeyFromEnv(env: NodeJS.ProcessEnv): Uint8Array | null {
  const hex = env.PB_FIELD_KEY_HEX;
  if (hex === undefined || hex === '') return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error('PB_FIELD_KEY_HEX must be exactly 64 hex characters (a 32-byte key)');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * The prototype's fixed field key, used only when PB_FIELD_KEY_HEX is unset outside production.
 * It is public by design: synthetic bank details are not secrets. Its bytes are the ASCII of a
 * readable phrase so nobody mistakes it for a real key.
 */
export const DEV_FIELD_KEY: Uint8Array = new TextEncoder().encode(
  'portfolio-beach-dev-field-key-00',
);

/**
 * The bank details of a wire instruction, as the register stores them encrypted. Account and
 * routing identifiers are digits only (6 to 20) so a value that is not an identifier (a sentence
 * from a notice, a model's answer) is refused before anything is encrypted (SEC-12.1).
 */
export const bankDetails = z.object({
  bankName: z.string().min(1),
  accountName: z.string().min(1),
  accountNumber: z.string().regex(/^\d{6,20}$/),
  routingCode: z.string().regex(/^\d{6,20}$/),
  reference: z.string().min(1).optional(),
});
export type BankDetails = z.infer<typeof bankDetails>;

/** What every role but operations and the approver sees: the bank and the last four digits. */
export function maskBankDetails(d: BankDetails): string {
  return `${d.bankName} ****${d.accountNumber.slice(-4)}`;
}

/** Encrypts the details as one JSON document with a fixed key order (`bank_details_enc`). */
export function encryptBankDetails(cipher: FieldCipher, d: BankDetails): string {
  const ordered: BankDetails = {
    bankName: d.bankName,
    accountName: d.accountName,
    accountNumber: d.accountNumber,
    routingCode: d.routingCode,
    ...(d.reference === undefined ? {} : { reference: d.reference }),
  };
  return cipher.encrypt(JSON.stringify(ordered));
}

/** Decrypts `bank_details_enc` and validates the result against the schema. */
export function decryptBankDetails(cipher: FieldCipher, ciphertext: string): BankDetails {
  return bankDetails.parse(JSON.parse(cipher.decrypt(ciphertext)));
}
