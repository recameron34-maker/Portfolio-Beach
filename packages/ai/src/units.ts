/*
 * The field kinds and units every schema, prompt and validator shares (the brief's fixed names,
 * stg.extracted_value.unit). Money units are the ones packages/calc toDollars converts.
 */

export const FIELD_KINDS = ['date', 'money', 'percent', 'count'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const MONEY_UNITS = ['USD', 'USD_K', 'USD_M', 'USD_B'] as const;
export const UNITS = ['USD', 'USD_K', 'USD_M', 'USD_B', 'PCT', 'COUNT', 'DATE'] as const;
export type Unit = (typeof UNITS)[number];

/** The units a value of each kind may carry; anything else is EXT-UNIT-01. */
export const UNITS_BY_KIND: Readonly<Record<FieldKind, readonly Unit[]>> = {
  date: ['DATE'],
  money: MONEY_UNITS,
  percent: ['PCT'],
  count: ['COUNT'],
};
