import { Link } from '@tanstack/react-router';
import type { DataHealth } from '@pb/contracts';
import type { CheckRow } from '../components/ui.js';
import { plural } from '../lib/format.js';
import { withoutReferences } from '../lib/references.js';

/*
 * What the data and admin pages show in words: the data checks, a configuration name, a setting's
 * text, a readiness check. Display only: no request and no figure is worked out here.
 */

/**
 * The record's data checks in the order Data health lists them; Home shows the first three. Each
 * result is the count the API gives, and its tone only draws the dot: bad for an orphan, watch for
 * an open exception or a stale position, none on a zero or a count that is not a fault.
 */
export function dataCheckRows(h: DataHealth): CheckRow[] {
  return [
    {
      check: 'Orphan investments',
      tone: h.orphanInvestments > 0 ? 'bad' : undefined,
      result: String(h.orphanInvestments),
      detail: 'Investment > Vehicle > Fund > Sponsor must resolve',
    },
    {
      check: 'Open exceptions',
      tone: h.openExceptions > 0 ? 'watch' : undefined,
      result: String(h.openExceptions),
      action: (
        <Link to="/data/exceptions" search={{ state: 'open' }}>
          Open the queue
        </Link>
      ),
    },
    {
      check: 'Stale positions',
      tone: h.staleInvestments > 0 ? 'watch' : undefined,
      result: String(h.staleInvestments),
      detail: `No approved financials in ${plural(h.staleAfterDays, 'day')}`,
    },
    {
      check: 'Locked valuations, latest quarter',
      result: String(h.lockedValuationsLatestQuarter),
      detail: plural(h.activeInvestments, 'active position'),
    },
  ];
}

/** Each readiness check in words: the API names its checks by code, which a page never shows. */
const CHECK_WORDS: Readonly<Record<string, string>> = {
  database: 'Database',
  'identity.mock': 'Sign-in, mock identity',
  'documents.local_folder': 'Document store, local folder',
  'mail.fixtures': 'Mail capture, recorded messages',
  'accounting.local_folder': 'Accounting import, local folder',
  'drop.local_folder.weekly': 'Weekly values drop folder',
  'drop.local_folder.ops_drop': 'Operations workbook drop folder',
  'lookthrough.local_folder': 'Look-through provider, local folder',
  'lookthrough.fixtures': 'Look-through provider, recorded data',
  'ai.mock': 'AI model, mock client',
  'benchmarks.synthetic': 'Benchmarks, synthetic',
};

/** A check the list does not know yet still reads as words: "Mail.graph" is "Mail graph". */
export function checkWords(name: string): string {
  const known = CHECK_WORDS[name];
  if (known !== undefined) return known;
  const words = name.replace(/[._]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Words for the few names that splitting cannot spell. */
const NAME_WORDS: Readonly<Record<string, string>> = {
  coInvest: 'Co-invest',
};

/** Abbreviations kept as the business writes them. */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  ai: 'AI',
  cv: 'CV',
  ebitda: 'EBITDA',
  ev: 'EV',
  ic: 'IC',
  irr: 'IRR',
  lookthrough: 'look-through',
  lp: 'LP',
  moic: 'MOIC',
  nav: 'NAV',
  pdf: 'PDF',
  usd: 'USD',
};

/**
 * A configuration name in words: "rollForwardToleranceUsd" is "Roll forward tolerance (USD)",
 * "sponsor_tier.core" is "Sponsor tier core". The name itself is never shown (docs/06 section 6).
 */
export function nameWords(key: string): string {
  const whole = NAME_WORDS[key];
  if (whole !== undefined) return whole;
  const words = key
    .replace(/YoY/g, ' year over year ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1 ')
    .replace(/[_.]+/g, ' ')
    .trim()
    .split(/\s+/)
    // A word written in capitals (USD_K, IC) keeps them; others go to lower case.
    .map((w) => ABBREVIATIONS[w.toLowerCase()] ?? (w === w.toUpperCase() ? w : w.toLowerCase()))
    .map((w) => (w === 'pct' ? 'percent' : w));
  const unit = words.at(-1) === 'USD' && words.length > 1 ? words.pop() : undefined;
  const text = `${words.join(' ')}${unit === undefined ? '' : ` (${unit})`}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A path to a file of the build ("packages/calc/units.ts"), which a page never names. */
const FILE_PATH = /\b(?:packages|apps|config|docs|tools)\/[\w./-]+/;
const FILE_IN_BRACKETS = / ?\((?:packages|apps|config|docs|tools)\/[\w./-]+\)/g;

/**
 * A setting's text as a person reads it: without its references to the build guide, and without
 * any clause that names a file ("dollars as exact decimals; convert in packages/calc/units.ts" is
 * "dollars as exact decimals"). Display only: the API's value is unchanged.
 */
export function settingText(text: string): string {
  return withoutReferences(text)
    .replace(FILE_IN_BRACKETS, '')
    .split('; ')
    .filter((clause) => !FILE_PATH.test(clause))
    .join('; ');
}

function plainValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return settingText(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(plainValue).join(', ');
  return '';
}

const isGroup = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One line of the dictionary: a name in words at a depth, and its value (none for a group). */
interface DictLine {
  path: string;
  depth: number;
  name: string;
  value: string;
}

/** A term and everything under it, a line each; names starting with "_" are skipped at every level. */
export function dictionaryLines(key: string, value: unknown, depth = 0, path = key): DictLine[] {
  if (key.startsWith('_')) return [];
  if (!isGroup(value)) return [{ path, depth, name: nameWords(key), value: plainValue(value) }];
  return [
    { path, depth, name: nameWords(key), value: '' },
    ...Object.entries(value).flatMap(([k, v]) => dictionaryLines(k, v, depth + 1, `${path}.${k}`)),
  ];
}
