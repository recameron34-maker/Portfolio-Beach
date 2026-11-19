/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript run by node with no build; the shapes are written as JSDoc */
/**
 * The licence deny list (decision 0016): which installed packages carry a licence the firm does
 * not take. It reads SPDX expressions the way they mean: "A OR B" lets the user take either, so
 * it is denied only when both sides are; "A AND B" applies both, so one denied side denies it.
 * What cannot be read as an expression is reported as unknown, never passed as fine.
 */

/**
 * "GPL-2.0, GPL-3.0" as the workflow writes it.
 * @param {string} text
 * @returns {string[]}
 */
export function parseDenyList(text) {
  return text
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/** A licence id without its version spelling: GPL-3.0-only, GPL-3.0-or-later and GPL-3.0+ are GPL-3.0. */
function baseId(id) {
  const lower = id.toLowerCase();
  for (const suffix of ['-or-later', '-only', '+'])
    if (lower.endsWith(suffix)) return lower.slice(0, -suffix.length);
  return lower;
}

const WORDS = new Set(['AND', 'OR', 'WITH']);
const NOT_A_LICENCE = new Set(['unknown', 'unlicensed', 'none', 'noassertion']);

/** Parentheses, the three operators and ids; null when anything else is in the text. */
function tokens(expression) {
  const out = [];
  for (const part of expression.replaceAll('(', ' ( ').replaceAll(')', ' ) ').split(' ')) {
    if (part === '') continue;
    if (part === '(' || part === ')' || WORDS.has(part)) out.push(part);
    else if (/^[A-Za-z0-9.+-]+$/.test(part)) out.push(part);
    else return null;
  }
  return out;
}

/**
 * 'denied' when the expression cannot be met without a listed licence, 'ok' when it can, and
 * 'unknown' when it is not an expression this reads (empty, "SEE LICENSE IN ...", cut short).
 * @param {string} expression
 * @param {readonly string[]} denyList
 * @returns {'denied' | 'ok' | 'unknown'}
 */
export function classify(expression, denyList) {
  const list = tokens(expression);
  if (list === null || list.length === 0) return 'unknown';
  const denied = new Set(denyList.map(baseId));
  let at = 0;
  let bad = false;
  const isId = (part) => part !== undefined && part !== '(' && part !== ')' && !WORDS.has(part);

  /** Each returns whether that part is denied; `bad` records a text that does not parse. */
  const factor = () => {
    const part = list[at];
    if (part === '(') {
      at += 1;
      const inner = choice();
      if (list[at] !== ')') bad = true;
      at += 1;
      return inner;
    }
    if (!isId(part) || NOT_A_LICENCE.has(part.toLowerCase())) {
      bad = true;
      at += 1;
      return false;
    }
    at += 1;
    if (list[at] === 'WITH') {
      // The exception's name follows; it does not take the licence off the list.
      if (!isId(list[at + 1])) bad = true;
      at += 2;
    }
    return denied.has(baseId(part));
  };
  const sum = () => {
    let any = factor();
    while (list[at] === 'AND') {
      at += 1;
      any = factor() || any;
    }
    return any;
  };
  const choice = () => {
    let all = sum();
    while (list[at] === 'OR') {
      at += 1;
      all = sum() && all;
    }
    return all;
  };

  const result = choice();
  if (bad || at !== list.length) return 'unknown';
  return result ? 'denied' : 'ok';
}

/** @typedef {{ name: string, versions: string[], license: string }} Finding */

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * From `pnpm licenses list --json` (licence text to the packages under it): how many packages
 * were read, and those whose licence is denied or unknown, by name.
 * @param {Record<string, { name: string, versions: string[] }[]>} listing
 * @param {readonly string[]} denyList
 * @returns {{ packages: number, denied: Finding[], unknown: Finding[] }}
 */
export function findings(listing, denyList) {
  const denied = [];
  const unknown = [];
  let packages = 0;
  for (const [license, group] of Object.entries(listing)) {
    packages += group.length;
    const verdict = classify(license, denyList);
    if (verdict === 'ok') continue;
    const rows = group.map((p) => ({ name: p.name, versions: [...p.versions].sort(), license }));
    (verdict === 'denied' ? denied : unknown).push(...rows);
  }
  return { packages, denied: denied.sort(byName), unknown: unknown.sort(byName) };
}
