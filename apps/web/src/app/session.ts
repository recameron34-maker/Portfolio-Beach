/**
 * Prototype sign-in state. The mock credential is the chosen external id; it lives in session
 * storage for the tab only (never local storage, SEC-4.5) and is replaced by MSAL after merge.
 */
const KEY = 'pb.credential';

export function getCredential(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setCredential(credential: string): void {
  try {
    window.sessionStorage.setItem(KEY, credential);
  } catch {
    // Storage can be unavailable (private mode); the user simply signs in again next time.
  }
}

export function clearCredential(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
