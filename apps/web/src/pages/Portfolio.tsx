import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Input, Label, Option, Switch } from '@fluentui/react-components';
import {
  ArrowDownload16Regular,
  ChevronLeft16Regular,
  ChevronRight16Regular,
  Search16Regular,
} from '@fluentui/react-icons';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import type { InvestmentSummary } from '@pb/contracts';
import { investmentsQuery } from '../app/queries.js';
import {
  Badge,
  Card,
  ErrorState,
  Field,
  PageHeader,
  SectionHeader,
  Toolbar,
} from '../components/ui.js';
import { gridThemes } from '../lib/grid.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  irrDisplay,
  labelOf,
  MISSING,
} from '../lib/format.js';

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
    cellClass: 'pb-num',
    valueFormatter: (p) => formatMoneyM(p.value as string | null),
  },
  {
    field: 'distributions',
    headerName: 'Distributed',
    width: 120,
    type: 'rightAligned',
    cellClass: 'pb-num',
    valueFormatter: (p) => formatMoneyM(p.value as string | null),
  },
  {
    field: 'nav',
    headerName: 'NAV',
    width: 120,
    type: 'rightAligned',
    cellClass: 'pb-num',
    valueFormatter: (p) => formatMoneyM(p.value as string | null),
  },
  {
    field: 'grossMoic',
    headerName: 'Gross MOIC',
    width: 120,
    type: 'rightAligned',
    cellClass: 'pb-num',
    valueFormatter: (p) => formatMoic(p.value as string | null),
  },
  {
    field: 'grossIrr',
    headerName: 'Gross IRR',
    width: 110,
    type: 'rightAligned',
    cellClass: 'pb-num',
    cellClassRules: {
      'pb-cell-nm': (p) => p.data?.irrFlag === 'short_period' || p.data?.irrFlag === 'multiple_irr',
    },
    valueFormatter: (p) => (p.data === undefined ? MISSING : irrDisplay(p.data)),
  },
  {
    field: 'isActive',
    headerName: 'Status',
    width: 110,
    cellRenderer: StatusCell,
  },
];

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
  const gridRef = useRef<AgGridReact<InvestmentSummary>>(null);
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
  const open = (id: string) => void navigate({ to: '/portfolio/$id', params: { id } });
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
      <Card>
        <SectionHeader>Positions</SectionHeader>
        <Toolbar
          end={
            <>
              <Switch
                label="Compact rows"
                checked={compact}
                onChange={(_e, d) => setCompact(d.checked)}
              />
              <Button
                size="small"
                appearance="subtle"
                icon={<ArrowDownload16Regular />}
                onClick={() =>
                  gridRef.current?.api.exportDataAsCsv({ fileName: 'portfolio-synthetic.csv' })
                }
              >
                Export CSV
              </Button>
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
            </>
          }
        >
          <Field>
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
          </Field>
          <Field>
            <Label htmlFor="quick-filter">Search</Label>
            <Input
              id="quick-filter"
              contentBefore={<Search16Regular />}
              placeholder="Company, sponsor, vehicle"
              value={quick}
              onChange={(_e, d) => setQuick(d.value)}
            />
          </Field>
          <Switch
            label="Active only"
            checked={activeOnly}
            onChange={(_e, d) => {
              setActiveOnly(d.checked);
              setCursors([]);
            }}
          />
        </Toolbar>
        <div className="pb-grid" data-testid="portfolio-grid">
          <AgGridReact<InvestmentSummary>
            ref={gridRef}
            theme={compact ? gridThemes.compact : gridThemes.comfortable}
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
              if (
                e.event instanceof KeyboardEvent &&
                e.event.key === 'Enter' &&
                e.data !== undefined
              )
                open(e.data.id);
            }}
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
