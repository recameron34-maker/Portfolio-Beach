import { ProductionGuardError } from '@pb/adapters';
import { DEV_FIELD_KEY, FieldCipher, fieldKeyFromEnv } from '@pb/db';

/*
 * The field cipher the wire instruction register encrypts bank details with (SEC-12.2, decision
 * 0013; packages/db/src/fieldCrypto.ts holds the scheme). The key is PB_FIELD_KEY_HEX, loaded
 * from Key Vault by the deployment: it is read here from the environment and never from the
 * typed config (config.ts carries no secret, SEC-4.6), and it is never logged. Outside
 * production an unset key falls back to DEV_FIELD_KEY, the documented prototype key, so synthetic
 * datasets load without configuration; in production an unset key is a mock component and the
 * process refuses to start (SEC-17.6), through the same guard error as a mock adapter. A set but
 * malformed key is refused everywhere.
 */

/** Injection token for the FieldCipher the composition built. */
export const FIELD_CIPHER = 'PB_FIELD_CIPHER';

/** What the production guard names when the key is unset in production. */
export const FIELD_KEY_OFFENDER = 'prototype field key (PB_FIELD_KEY_HEX unset)';

/**
 * The cipher for this process: the environment's key, or the prototype key outside production.
 * Throws ProductionGuardError in production without a key, and the loader's own error for a key
 * that is set but not 64 hex characters.
 */
export function fieldCipherFor(nodeEnv: string, env: NodeJS.ProcessEnv): FieldCipher {
  const key = fieldKeyFromEnv(env);
  if (key !== null) return new FieldCipher(key);
  if (nodeEnv === 'production') throw new ProductionGuardError([FIELD_KEY_OFFENDER]);
  return new FieldCipher(DEV_FIELD_KEY);
}
