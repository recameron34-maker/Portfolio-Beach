import { forgetIdempotencyKeys } from '../api/idempotency.js';

/**
 * Prototype sign-in state. The mock credential is the chosen external id; it lives in session
 * storage for the tab only (never local storage, SEC-4.5) and is replaced by MSAL after merge.
 * When storage is blocked (a sandboxed frame, private mode) an in-memory copy serves the page
 * session so sign-in still works; it is never persisted.
 */
const KEY = 'pb.credential';
let memory: string | null = null;

export function getCredential(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return memory;
  }
}

export function setCredential(credential: string): void {
  memory = credential;
  try {
    window.sessionStorage.setItem(KEY, credential);
  } catch {
    // Storage unavailable: the in-memory copy serves this page session.
  }
}

/** Signs out: the credential goes, and with it the keys held for requests that had no answer yet. */
export function clearCredential(): void {
  memory = null;
  forgetIdempotencyKeys();
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
