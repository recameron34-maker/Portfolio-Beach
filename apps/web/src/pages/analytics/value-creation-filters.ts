import { valueCreationFilters } from '@pb/contracts';
import type { ValueCreationFilters, ValueCreationPosition } from '@pb/contracts';
import { labelOf } from '../../lib/format.js';

/*
 * The filters of the Value creation and Entry metrics tabs (docs/04 M13): one vehicle, sponsor,
 * sector, deal type, entry year or status. Their state lives in the URL search, so a filtered
 * view can be shared, and the same names go to the export. Nothing here computes a figure: the
 * rule that decides which rows pass is the contract's (matchesValueCreationFilters), and the
 * roll-up of the rows that pass is @pb/calc's (value-creation-view.ts).
 */

export type FilterKey = keyof ValueCreationFilters;

/** The filters in the order the bar shows them, with the words of their control. */
export const FILTERS: readonly { key: FilterKey; label: string; all: string }[] = [
  { key: 'vehicleId', label: 'Vehicle', all: 'All vehicles' },
  { key: 'sponsorId', label: 'Sponsor', all: 'All sponsors' },
  { key: 'sector', label: 'Sector', all: 'All sectors' },
  { key: 'dealType', label: 'Deal type', all: 'All deal types' },
  { key: 'entryYear', label: 'Entry year', all: 'All entry years' },
  { key: 'status', label: 'Status', all: 'Active and realized' },
];

/**
 * The filters a URL search carries. A value the contract does not accept is dropped, never an
 * error page. The router reads `?entryYear=2021` as a number, so a year is taken either way.
 */
export function parseValueCreationSearch(search: Record<string, unknown>): ValueCreationFilters {
  const filters: ValueCreationFilters = {};
  for (const { key } of FILTERS) {
    const raw = search[key];
    const text = typeof raw === 'number' ? String(raw) : raw;
    if (typeof text !== 'string' || text === '') continue;
    const parsed = valueCreationFilters.safeParse({ [key]: text });
    if (parsed.success) Object.assign(filters, parsed.data);
  }
  return filters;
}

/**
 * The filters as the URL search writes them: only the ones that are set, and the year as a
 * number so the address reads `entryYear=2021`.
 */
export function valueCreationSearch(
  filters: ValueCreationFilters,
): Record<string, string | number> {
  const search: Record<string, string | number> = {};
  for (const { key } of FILTERS) {
    const value = filters[key];
    if (value === undefined) continue;
    search[key] = key === 'entryYear' ? Number(value) : value;
  }
  return search;
}

/** The query string the export is asked with: the filters that are set, in the bar's order. */
export function filterQueryString(filters: ValueCreationFilters): string {
  const params = new URLSearchParams();
  for (const { key } of FILTERS) {
    const value = filters[key];
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export const hasFilters = (filters: ValueCreationFilters): boolean =>
  FILTERS.some(({ key }) => filters[key] !== undefined);

/** The filters with one changed; an empty value clears it. */
export function withFilter(
  filters: ValueCreationFilters,
  key: FilterKey,
  value: string,
): ValueCreationFilters {
  return parseValueCreationSearch({ ...filters, [key]: value });
}

export interface FilterOption {
  value: string;
  label: string;
}

const STATUS_WORDS: Record<ValueCreationPosition['status'], string> = {
  active: 'Active',
  realized: 'Realized',
};

/** A to Z whatever the case, by code point so every browser agrees on the order. */
function byLabel(a: FilterOption, b: FilterOption): number {
  const x = a.label.toLowerCase();
  const y = b.label.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

function distinct(options: readonly FilterOption[]): FilterOption[] {
  const seen = new Map<string, FilterOption>();
  for (const option of options) if (!seen.has(option.value)) seen.set(option.value, option);
  return [...seen.values()];
}

/**
 * What each filter offers: the values the caller's own positions hold, so no option leads
 * nowhere. Names sort A to Z, entry years newest first, active before realized. A position with
 * no sector on record is under no sector option.
 */
export function filterOptions(
  positions: readonly ValueCreationPosition[],
): Record<FilterKey, FilterOption[]> {
  return {
    vehicleId: distinct(
      positions.map((p) => ({ value: p.vehicleId, label: p.vehicleName })),
    ).sort(byLabel),
    sponsorId: distinct(
      positions.map((p) => ({ value: p.sponsorId, label: p.sponsorName })),
    ).sort(byLabel),
    sector: distinct(
      positions.flatMap((p) =>
        p.sector === null ? [] : [{ value: p.sector, label: labelOf(p.sector) }],
      ),
    ).sort(byLabel),
    dealType: distinct(
      positions.map((p) => ({ value: p.dealType, label: labelOf(p.dealType) })),
    ).sort(byLabel),
    entryYear: distinct(
      positions.map((p) => ({ value: String(p.entryYear), label: String(p.entryYear) })),
    ).sort((a, b) => Number(b.value) - Number(a.value)),
    status: (['active', 'realized'] as const)
      .filter((status) => positions.some((p) => p.status === status))
      .map((status) => ({ value: status, label: STATUS_WORDS[status] })),
  };
}
