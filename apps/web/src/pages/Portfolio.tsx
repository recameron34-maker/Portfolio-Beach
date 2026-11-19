import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Dropdown,
  Input,
  Label,
  Option,
  Switch,
  ToggleButton,
} from '@fluentui/react-components';
import {
  ArrowDownload16Regular,
  ChevronLeft16Regular,
  ChevronRight16Regular,
  Search16Regular,
  TextDensity16Regular,
} from '@fluentui/react-icons';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridApi, ICellRendererParams, ValueGetterParams } from 'ag-grid-community';
import type { InvestmentSummary } from '@pb/contracts';
import { PORTFOLIO_TABS } from '../app/nav.js';
import { investmentsQuery } from '../app/queries.js';
import { derived, tokens } from '../app/theme.js';
import { Badge, ErrorState, PageHeader, TabNav } from '../components/ui.js';
import { gridThemes } from '../lib/grid.js';
import { useNarrowScreen } from '../lib/media.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  irrDisplay,
  labelOf,
  MISSING,
  plural,
} from '../lib/format.js';

const DEAL_TYPES = [
  { value: '', label: 'All deal types' },
  { value: 'deal_type.co_invest_equity', label: 'Co-investment (equity)' },
  { value: 'deal_type.cv_single_asset', label: 'CV single asset' },
  { value: 'deal_type.cv_multi_asset', label: 'CV multi asset' },
  { value: 'deal_type.private_credit', label: 'Private credit' },
];

type DecimalField = 'invested' | 'distributions' | 'nav' | 'grossMoic' | 'grossIrr';

/** Decimal strings compared as numbers; a figure that is not calculable sorts last either way. */
function compareDecimals(
  a: string | null,
  b: string | null,
  _nodeA: unknown,
  _nodeB: unknown,
  isDescending: boolean,
): number {
  if (a === null || b === null) {
    if (a === b) return 0;
    // The grid negates the result for a descending sort, so the sign flips to keep nulls last.
    return (a === null ? 1 : -1) * (isDescending ? -1 : 1);
  }
  return Number(a) - Number(b);
}

/** The number filter reads the decimal string as a number; a null stays out of every range. */
function decimalFilterValue(p: ValueGetterParams<InvestmentSummary>): number | null {
  const field = p.colDef.field as DecimalField | undefined;
  const value = field === undefined ? undefined : p.data?.[field];
  return value === null || value === undefined ? null : Number(value);
}

/**
 * The grid in the app's quiet table look (docs/06 section 2): an unfilled header in muted ink over
 * a stronger rule, no rules between columns and no frame, and a table's 8px at the sides of each
 * cell (the grid reaches 8px past its section, as a table does). The shared themes of lib/grid.ts
 * stay as they are; this page sets its look on top of them.
 */
const quietGrid = {
  headerBackgroundColor: tokens.ui.bg,
  headerTextColor: derived.mutedStrong,
  headerFontWeight: 600,
  headerColumnBorder: false,
  headerColumnResizeHandleColor: tokens.ui.border,
  headerRowBorder: { color: derived.borderStrong },
  pinnedColumnBorder: { color: derived.hairline },
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  cellHorizontalPadding: 8,
  accentColor: tokens.brand.accent,
} as const;
const themes = {
  comfortable: gridThemes.comfortable.withParams(quietGrid),
  compact: gridThemes.compact.withParams(quietGrid),
};

const decimalColumn: Pick<
  ColDef<InvestmentSummary>,
  'type' | 'cellClass' | 'comparator' | 'filter' | 'filterValueGetter'
> = {
  type: 'rightAligned',
  // The type's own class names a right-aligned cell; a cellClass given here replaces it, so both.
  cellClass: ['ag-right-aligned-cell', 'pb-num'],
  comparator: compareDecimals,
  filter: 'agNumberColumnFilter',
  filterValueGetter: decimalFilterValue,
};

/**
 * Identity first and pinned, then the figures, then the state, then the details: every column the
 * grid has always had, in the order a row is read. Long names clip with their whole text in a
 * tooltip. On a phone only the number stays pinned and the company is narrower, so the first
 * figure column fits whole beside it.
 */
const columnsFor = (narrow: boolean): ColDef<InvestmentSummary>[] => [
  { field: 'investmentNumber', headerName: 'Inv #', width: 88, pinned: 'left' },
  // A pinned column keeps its width (the grid flexes only the unpinned ones).
  {
    field: 'companyName',
    headerName: 'Company',
    pinned: narrow ? null : 'left',
    width: narrow ? 150 : 220,
    minWidth: narrow ? 140 : 200,
    tooltipField: 'companyName',
  },
  {
    field: 'invested',
    headerName: 'Invested',
    width: 104,
    ...decimalColumn,
    valueFormatter: (p) => formatMoneyM(p.value as string | null),
  },
  {
    field: 'distributions',
    headerName: 'Distributed',
    width: 108,
    ...decimalColumn,
    valueFormatter: (p) => formatMoneyM(p.value as string | null),
  },
  {
    field: 'nav',
    headerName: 'NAV',
    width: 100,
    ...decimalColumn,
    valueFormatter: (p) => formatMoneyM(p.value as string | null),
  },
  {
    field: 'grossMoic',
    headerName: 'Gross MOIC',
    width: 108,
    ...decimalColumn,
    valueFormatter: (p) => formatMoic(p.value as string | null),
  },
  {
    field: 'grossIrr',
    headerName: 'Gross IRR',
    width: 100,
    ...decimalColumn,
    cellClassRules: {
      'pb-cell-nm': (p) => p.data?.irrFlag === 'short_period' || p.data?.irrFlag === 'multiple_irr',
    },
    valueFormatter: (p) => (p.data === undefined ? MISSING : irrDisplay(p.data)),
  },
  {
    field: 'isActive',
    headerName: 'Status',
    width: 96,
    cellRenderer: StatusCell,
  },
  {
    field: 'vehicleName',
    headerName: 'Vehicle',
    flex: 1,
    minWidth: 170,
    tooltipField: 'vehicleName',
  },
  {
    field: 'sponsorName',
    headerName: 'Sponsor',
    flex: 1,
    minWidth: 170,
    tooltipField: 'sponsorName',
  },
  {
    field: 'dealType',
    headerName: 'Deal type',
    width: 164,
    valueFormatter: (p) => labelOf(p.value as string),
    tooltipValueGetter: (p) => labelOf(p.value as string),
  },
  {
    field: 'entryDate',
    headerName: 'Entry',
    width: 116,
    valueFormatter: (p) => formatDate(p.value as string),
  },
];

/** The export keeps the columns in the order the file has always had, whatever the grid shows. */
const EXPORT_COLUMNS: (keyof InvestmentSummary)[] = [
  'investmentNumber',
  'companyName',
  'sponsorName',
  'vehicleName',
  'dealType',
  'entryDate',
  'invested',
  'distributions',
  'nav',
  'grossMoic',
  'grossIrr',
  'isActive',
];

/** "12 positions shown", or "3 of 12 positions shown" while a filter hides some of the page. */
function shownLabel(displayed: number | null, loaded: number): string {
  const shown = displayed ?? loaded;
  return shown === loaded
    ? `${plural(loaded, 'position')} shown`
    : `${shown} of ${plural(loaded, 'position')} shown`;
}

/**
 * Marks the grid's frame while columns lie beyond its right edge, so the stylesheet shades that
 * edge as a table's frame does: the scrolled range against the width of the unpinned columns.
 */
function markMoreAfter(frame: HTMLElement | null, api: GridApi<InvestmentSummary>): void {
  if (frame === null) return;
  const { right } = api.getHorizontalPixelRange();
  const width = api.getDisplayedCenterColumns().reduce((sum, c) => sum + c.getActualWidth(), 0);
  frame.toggleAttribute('data-more-after', right < width - 1);
}

function StatusCell(p: ICellRendererParams<InvestmentSummary, boolean>): ReactNode {
  return p.value === true ? (
    <Badge tone="brand">Active</Badge>
  ) : (
    <Badge tone="neutral">Realized</Badge>
  );
}

export function PortfolioPage(): ReactNode {
  const [dealType, setDealType] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [cursors, setCursors] = useState<string[]>([]);
  const [quick, setQuick] = useState('');
  const [compact, setCompact] = useState(false);
  // Rows the grid shows after its own quick filter and column filters, from the grid itself.
  const [displayed, setDisplayed] = useState<number | null>(null);
  const gridRef = useRef<AgGridReact<InvestmentSummary>>(null);
  const gridFrame = useRef<HTMLDivElement>(null);
  const edges = (e: { api: GridApi<InvestmentSummary> }): void =>
    markMoreAfter(gridFrame.current, e.api);
  const navigate = useNavigate();
  const filters = useMemo(
    () => ({
      dealType: dealType === '' ? undefined : dealType,
      active: activeOnly ? ('true' as const) : undefined,
      cursor: cursors[cursors.length - 1],
      limit: 100,
    }),
    [dealType, activeOnly, cursors],
  );
  const page = useQuery(investmentsQuery(filters));
  const narrow = useNarrowScreen();
  const columns = useMemo(() => columnsFor(narrow), [narrow]);
  if (page.isError) return <ErrorState title="Portfolio unavailable" detail={page.error.message} />;
  const open = (id: string) => void navigate({ to: '/portfolio/$id', params: { id } });
  const morePages = cursors.length > 0 || (page.data?.nextCursor ?? null) !== null;
  return (
    <>
      <PageHeader
        title="Portfolio"
        meta={
          page.data !== undefined ? (
            <>As of {formatDate(page.data.asOf)}. Open a row for the one-pager.</>
          ) : undefined
        }
      />
      <TabNav label="Portfolio" items={PORTFOLIO_TABS} />
      {/* One row of controls over the grid; the tab names the page, so no section title. */}
      <div className="pb-grid-toolbar">
        <div className="pb-grid-search">
          <Label htmlFor="quick-filter" className="pb-visually-hidden">
            Search
          </Label>
          <Input
            id="quick-filter"
            contentBefore={<Search16Regular />}
            placeholder="Company, sponsor, vehicle"
            value={quick}
            onChange={(_e, d) => setQuick(d.value)}
          />
        </div>
        <div className="pb-grid-field">
          <Label htmlFor="deal-type">Deal type</Label>
          <Dropdown
            id="deal-type"
            className="pb-grid-deal-type"
            value={DEAL_TYPES.find((d) => d.value === dealType)?.label ?? 'All deal types'}
            selectedOptions={[dealType]}
            onOptionSelect={(_e, d) => {
              setDealType(d.optionValue ?? '');
              setCursors([]);
            }}
          >
            {DEAL_TYPES.map((d) => (
              <Option key={d.value} value={d.value}>
                {d.label}
              </Option>
            ))}
          </Dropdown>
        </div>
        <Switch
          label="Active only"
          checked={activeOnly}
          onChange={(_e, d) => {
            setActiveOnly(d.checked);
            setCursors([]);
          }}
        />
        <div className="pb-grid-toolbar-end">
          <p className="pb-meta" data-testid="portfolio-count">
            {page.data === undefined ? '' : shownLabel(displayed, page.data.items.length)}
          </p>
          <ToggleButton
            size="small"
            appearance="subtle"
            checked={compact}
            icon={<TextDensity16Regular />}
            onClick={() => setCompact((c) => !c)}
          >
            Compact rows
          </ToggleButton>
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowDownload16Regular />}
            onClick={() =>
              gridRef.current?.api.exportDataAsCsv({
                fileName: 'portfolio-synthetic.csv',
                columnKeys: EXPORT_COLUMNS,
              })
            }
          >
            Export CSV
          </Button>
        </div>
      </div>
      <div className="pb-grid" data-testid="portfolio-grid" ref={gridFrame}>
        <AgGridReact<InvestmentSummary>
          ref={gridRef}
          theme={compact ? themes.compact : themes.comfortable}
          rowData={page.data?.items ?? []}
          loading={page.isPending}
          quickFilterText={quick}
          columnDefs={columns}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          getRowId={(p) => p.data.id}
          onRowClicked={(e) => {
            if (e.data !== undefined) open(e.data.id);
          }}
          onCellKeyDown={(e) => {
            if (e.event instanceof KeyboardEvent && e.event.key === 'Enter' && e.data !== undefined)
              open(e.data.id);
          }}
          onModelUpdated={(e) => setDisplayed(e.api.getDisplayedRowCount())}
          onFirstDataRendered={edges}
          onBodyScroll={edges}
          onGridSizeChanged={edges}
          onColumnResized={edges}
          onDisplayedColumnsChanged={edges}
          domLayout="normal"
          animateRows={false}
          suppressCellFocus={false}
        />
      </div>
      {morePages ? (
        <div className="pb-grid-pager">
          <Button
            size="small"
            appearance="subtle"
            icon={<ChevronLeft16Regular />}
            disabled={cursors.length === 0}
            onClick={() => setCursors((c) => c.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            size="small"
            appearance="subtle"
            icon={<ChevronRight16Regular />}
            iconPosition="after"
            disabled={page.data?.nextCursor === null || page.data === undefined}
            onClick={() => setCursors((c) => [...c, page.data?.nextCursor ?? ''])}
          >
            Next
          </Button>
        </div>
      ) : null}
    </>
  );
}
