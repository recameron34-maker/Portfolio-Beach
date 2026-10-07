import { afterEach, describe, expect, it } from 'vitest';
import { clearCredential, getCredential, setCredential } from './session.js';

const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');

function blockStorage(): void {
  const blocked = {
    getItem: () => {
      throw new Error('storage blocked');
    },
    setItem: () => {
      throw new Error('storage blocked');
    },
    removeItem: () => {
      throw new Error('storage blocked');
    },
  };
  Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => blocked });
}

afterEach(() => {
  if (original) Object.defineProperty(window, 'sessionStorage', original);
  else Reflect.deleteProperty(window, 'sessionStorage');
  clearCredential();
});

describe('session credential', () => {
  it('keeps the credential in session storage when it is available', () => {
    setCredential('viewer.one');
    expect(window.sessionStorage.getItem('pb.credential')).toBe('viewer.one');
    expect(getCredential()).toBe('viewer.one');
    clearCredential();
    expect(getCredential()).toBeNull();
    expect(window.sessionStorage.getItem('pb.credential')).toBeNull();
  });

  it('serves the page session from memory when storage is blocked', () => {
    blockStorage();
    expect(getCredential()).toBeNull();
    setCredential('deal.three');
    expect(getCredential()).toBe('deal.three');
    clearCredential();
    expect(getCredential()).toBeNull();
  });
});
