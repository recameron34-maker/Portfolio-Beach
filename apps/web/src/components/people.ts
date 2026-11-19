import { ROLE_WORDS } from '../lib/roles.js';
import type { Role } from '../lib/roles.js';

/** The roles a user holds, in words: "deal team", or "deal team, approver". */
export function roleWords(roles: readonly Role[]): string {
  return roles.map((r) => ROLE_WORDS[r]).join(', ');
}

/** A role group's heading: the role words with a capital, "Deal team". */
const groupLabel = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/** Where a user's first role sits in the order every list of roles follows (ROLE_WORDS). */
const ORDER = Object.keys(ROLE_WORDS);
const rank = (roles: readonly Role[]): number => {
  const first = roles[0];
  return first === undefined ? ORDER.length : ORDER.indexOf(first);
};

/**
 * Mock users in groups by the roles they hold, in the order ROLE_WORDS lists the roles, each group
 * keeping the order the API listed its users in. The sign-in picker and the user switcher share it.
 */
export function byRole<U extends { roles: readonly Role[] }>(
  users: readonly U[],
): { key: string; label: string; users: U[] }[] {
  const groups = new Map<string, { key: string; label: string; rank: number; users: U[] }>();
  for (const u of users) {
    const key = roleWords(u.roles);
    const group = groups.get(key);
    if (group === undefined)
      groups.set(key, { key, label: groupLabel(key), rank: rank(u.roles), users: [u] });
    else group.users.push(u);
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(({ key, label, users: members }) => ({ key, label, users: members }));
}

/** Up to two initials from a display name: "Ellis Petrova" is "EP". */
export function initialsOf(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return `${first}${last}`.toUpperCase();
}
