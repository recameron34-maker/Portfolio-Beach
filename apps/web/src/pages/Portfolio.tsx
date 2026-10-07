import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Label, Option, Spinner, Switch } from '@fluentui/react-components';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import type { ColDef, RowClickedEvent } from 'ag-grid-community';
import type { InvestmentSummary } from '@pb/contracts';
import { investmentsQuery } from '../app/queries.js';
import { tokens } from '../app/theme.js';
import { Card, ErrorState, SectionHeader } from '../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  irrDisplay,
  labelOf,
  MISSING,
} from '../lib/format.js';

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({
  accentColor: tokens.brand.accent,
  headerBackgroundColor: tokens.brand.primary,
  headerTextColor: tokens.ui.bg,
  borderColor: tokens.ui.border,
  foregroundColor: tokens.ui.text,
  backgroundColor: tokens.ui.bg,
  fontFamily: 'inherit',
});

const DEAL_TYPES = [
  { value: '', label: 'All deal types' },
  { value: 'deal_type.co_invest_equity', label: 'Co-investment (equity)' },
  { value: 'deal_type.cv_single_asset', label: 'CV single asset' },
  { value: 'deal_type.cv_multi_asset', label: 'CV multi asset' },
  { value: 'deal_type.private_credit', label: 'Private credit' },
];

const columns: ColDef<InvestmentSummary>[] = [
  { field: 'investmentNumber', headerName: 'Inv #', width: 110, pinned: 'left' },
  { field: 'companyName', headerName: 'Company', flex: 1.4, minWidth: 180 },
  { field: 'sponsorName', headerName: 'Sponsor', flex: 1.2, minWidth: 160 },
  { field: 'vehicleName', headerName: 'Vehicle', flex: 1.2, minWidth: 160 },
  {
    field: 'dealType',
    headerName: 'Deal type',
    width: 150,
    valueFormatter: (p) => labelOf(p.value as string),
  },
  {
    field: 'entryDate',
    headerName: 'Entry',
    width: 120,
    valueFormatter: (p) => formatDate(p.value as string),
  },
  {
    field: 'invested',
    headerName: 'Invested',
    width: 120,
    type: 'rightAligned',
    valueFormatter: (p) => formatMoneyM(p.value as string | null),
  },
  {
    field: 'distributions',
    headerName: 'Distributed',
    width: 120,
    type: 'rightAligned',
    valueFormatter: (p) => formatMoneyM(p.value as string | null),
  },
  {
    field: 'nav',
    headerName: 'NAV',
    width: 120,
    type: 'rightAligned',
    valueFormatter: (p) => formatMoneyM(p.value as string | null),
  },
  {
    field: 'grossMoic',
    headerName: 'Gross MOIC',
    width: 120,
    type: 'rightAligned',
    valueFormatter: (p) => formatMoic(p.value as string | null),
  },
  {
    field: 'grossIrr',
    headerName: 'Gross IRR',
    width: 110,
    type: 'rightAligned',
    valueFormatter: (p) => (p.data === undefined ? MISSING : irrDisplay(p.data)),
  },
  {
    field: 'isActive',
    headerName: 'Status',
    width: 100,
    valueFormatter: (p) => ((p.value as boolean) ? 'Active' : 'Realized'),
  },
];

export function PortfolioPage(): ReactNode {
  const [dealType, setDealType] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [cursors, setCursors] = useState<string[]>([]);
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
  if (page.isError) return <ErrorState title="Portfolio unavailable" detail={page.error.message} />;
  const onRowClicked = (e: RowClickedEvent<InvestmentSummary>) => {
    if (e.data !== undefined) void navigate({ to: '/portfolio/$id', params: { id: e.data.id } });
  };
  return (
    <>
      <div className="pb-banner">
        <h1>Portfolio</h1>
        {page.data !== undefined ? (
          <span className="pb-meta">
            As of {formatDate(page.data.asOf)}. Click a row for the one-pager.
          </span>
        ) : null}
      </div>
      <Card>
        <SectionHeader>Positions</SectionHeader>
        <div className="pb-toolbar">
          <div>
            <Label htmlFor="deal-type">Deal type</Label>
            <Dropdown
              id="deal-type"
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
          <span className="pb-header-spacer" />
          <Button
            size="small"
            disabled={cursors.length === 0}
            onClick={() => setCursors((c) => c.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            size="small"
            disabled={page.data?.nextCursor === null || page.data === undefined}
            onClick={() => setCursors((c) => [...c, page.data?.nextCursor ?? ''])}
          >
            Next
          </Button>
        </div>
        {page.isPending ? <Spinner label="Loading positions" /> : null}
        <div className="pb-grid" data-testid="portfolio-grid">
          <AgGridReact<InvestmentSummary>
            theme={gridTheme}
            rowData={page.data?.items ?? []}
            columnDefs={columns}
            defaultColDef={{ sortable: true, resizable: true, filter: false }}
            getRowId={(p) => p.data.id}
            onRowClicked={onRowClicked}
            domLayout="normal"
            animateRows={false}
            suppressCellFocus={false}
          />
        </div>
        <p className="pb-meta" data-testid="portfolio-count">
          {page.data === undefined ? '' : `${page.data.items.length} positions shown`}
        </p>
      </Card>
    </>
  );
}
