/**
 * Data classification registry (docs/05 SEC-2.1). Every business table has a default class and
 * any column that differs is listed explicitly. `pnpm check:classification` fails CI when a table
 * or column exists in the database without a class here, or when an entry here names something
 * that no longer exists.
 */
export type DataClass =
  'restricted_mnpi' | 'restricted_payment' | 'confidential_personal' | 'internal' | 'public';

export interface TableClassification {
  /** Class for every column unless overridden. */
  default: DataClass;
  columns?: Record<string, DataClass>;
  /** Retention policy reference (SEC-6.5); 'books_and_records' means the firm's books-and-records period. */
  retention: 'books_and_records' | 'operational_2y' | 'session' | 'permanent';
}

/** Columns that are always internal metadata, whatever the table's class. */
export const METADATA_COLUMNS: readonly string[] = [
  'id',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'row_version',
  'deleted_at',
  'currency',
  'status',
  'state',
  'calc_version',
  'prompt_version',
  'model_id',
  'extraction_run_id',
  'source_document_id',
  'source_page',
  'source_locator',
];

export const CLASSIFICATION: Record<string, TableClassification> = {
  'core.app_user': {
    default: 'confidential_personal',
    retention: 'books_and_records',
    columns: { is_active: 'internal' },
  },
  'core.taxonomy_term': { default: 'internal', retention: 'permanent' },
  'core.sponsor': {
    default: 'internal',
    retention: 'books_and_records',
    columns: { tier: 'restricted_mnpi', description: 'restricted_mnpi' },
  },
  'core.sponsor_fund': {
    default: 'internal',
    retention: 'books_and_records',
    columns: {
      size_target: 'restricted_mnpi',
      size_hard_cap: 'restricted_mnpi',
      size_final: 'restricted_mnpi',
    },
  },
  'core.fund_alias': { default: 'internal', retention: 'books_and_records' },
  'core.portfolio_company': {
    default: 'restricted_mnpi',
    retention: 'books_and_records',
    columns: { name: 'internal', canonical_name: 'internal' },
  },
  'core.fund_holding': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'core.vehicle': { default: 'internal', retention: 'books_and_records' },
  'core.investment': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'core.client': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'core.commitment': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'core.lp_commitment': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'core.match_guard': { default: 'internal', retention: 'permanent' },
  'core.wall': { default: 'internal', retention: 'books_and_records' },
  'core.wall_member': { default: 'confidential_personal', retention: 'books_and_records' },
  'core.walled_record': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'mon.quarterly_performance': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'mon.credit_terms': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'mon.credit_performance': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'mon.valuation': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'mon.valuation_approval': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'mon.capital_notice': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'mon.cash_flow': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'mon.realization_outlook': { default: 'restricted_mnpi', retention: 'books_and_records' },
  'ops.schema_migration': { default: 'internal', retention: 'permanent' },
  'ops.feature_flag': { default: 'internal', retention: 'permanent' },
  'ops.task': {
    default: 'internal',
    retention: 'operational_2y',
    columns: { title: 'restricted_mnpi' },
  },
  'ops.data_exception': {
    default: 'internal',
    retention: 'operational_2y',
    columns: {
      expected: 'restricted_mnpi',
      actual: 'restricted_mnpi',
      candidates: 'restricted_mnpi',
    },
  },
  'ops.job': { default: 'internal', retention: 'operational_2y' },
  'ops.systems_issue': { default: 'internal', retention: 'operational_2y' },
  'ops.outbox': {
    default: 'internal',
    retention: 'operational_2y',
    columns: { payload: 'restricted_mnpi' },
  },
  'stg.intake_file': { default: 'internal', retention: 'operational_2y' },
  'stg.intake_row': { default: 'restricted_mnpi', retention: 'operational_2y' },
  'stg.valuation': { default: 'restricted_mnpi', retention: 'operational_2y' },
  'audit.event': {
    default: 'internal',
    retention: 'permanent',
    columns: { details: 'restricted_mnpi', actor_id: 'confidential_personal' },
  },
};

export interface ColumnRef {
  schema: string;
  table: string;
  column: string;
}

/** Resolves a column's class, treating <table>_history as its parent table. */
export function classify(ref: ColumnRef): DataClass | null {
  const base = ref.table.endsWith('_history') ? ref.table.slice(0, -'_history'.length) : ref.table;
  const entry = CLASSIFICATION[`${ref.schema}.${base}`];
  if (entry === undefined) return null;
  if (ref.table.endsWith('_history')) {
    // History rows carry the parent's full image: the parent's default class applies.
    return ref.column === 'row_image' ? entry.default : 'internal';
  }
  if (METADATA_COLUMNS.includes(ref.column)) return 'internal';
  return entry.columns?.[ref.column] ?? entry.default;
}

export interface ClassificationReport {
  ok: boolean;
  unclassified: string[];
  stale: string[];
  columnCount: number;
}

/** Checks every database column against the registry; both directions must agree. */
export function checkClassification(columns: readonly ColumnRef[]): ClassificationReport {
  const unclassified: string[] = [];
  const present = new Set(columns.map((c) => `${c.schema}.${c.table}`));
  const presentColumns = new Set(columns.map((c) => `${c.schema}.${c.table}.${c.column}`));
  for (const c of columns) {
    if (classify(c) === null) unclassified.push(`${c.schema}.${c.table}.${c.column}`);
  }
  const stale: string[] = [];
  for (const [key, entry] of Object.entries(CLASSIFICATION)) {
    if (!present.has(key)) stale.push(key);
    for (const col of Object.keys(entry.columns ?? {})) {
      if (!presentColumns.has(`${key}.${col}`)) stale.push(`${key}.${col}`);
    }
  }
  return {
    ok: unclassified.length === 0 && stale.length === 0,
    unclassified,
    stale,
    columnCount: columns.length,
  };
}

export const BUSINESS_SCHEMAS = [
  'core',
  'deal',
  'mon',
  'doc',
  'rel',
  'rpt',
  'ops',
  'stg',
  'audit',
] as const;

export const LIST_COLUMNS_SQL = `
  select table_schema as schema, table_name as table, column_name as column
  from information_schema.columns
  where table_schema in (${BUSINESS_SCHEMAS.map((s) => `'${s}'`).join(', ')})
  order by table_schema, table_name, ordinal_position`;
