import { useEffect } from 'react';

/** A credential the API no longer accepts means signed out: clear it and return to the picker. */
export function useSignOutOnRejectedCredential(isRejected: boolean, signOut: () => void): void {
  useEffect(() => {
    if (isRejected) signOut();
  }, [isRejected, signOut]);
}
