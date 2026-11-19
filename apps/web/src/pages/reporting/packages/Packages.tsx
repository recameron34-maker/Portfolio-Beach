import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Label, Option } from '@fluentui/react-components';
import { Add16Regular } from '@fluentui/react-icons';
import type { ReportPackageRow, ReportPackageState } from '@pb/contracts';
import { REPORTING_TABS } from '../../../app/nav.js';
import { meQuery } from '../../../app/queries.js';
import { UnavailableState } from '../../../components/UnavailableState.js';
import { ActionLogCard, ActionStatus } from '../../../components/WorkflowActions.js';
import {
  Badge,
  Card,
  EmptyLine,
  EmptyState,
  Field,
  PageHeader,
  PageSkeleton,
  TableWrap,
  TabNav,
  Toolbar,
} from '../../../components/ui.js';
import { formatQuarter, plural } from '../../../lib/format.js';
import { humanizeState, packageTone } from '../../../lib/states.js';
import { blockedTitle, useActionLog } from '../../../lib/workflow.js';
import { reportPackagesQuery } from './api.js';
import {
  BASIS_WORDS,
  checksSummary,
  clientChoices,
  filterPackages,
  isPackageState,
  LABEL_WORDS,
  PACKAGE_STATES,
  START_ROLES,
  WHO_READS_PACKAGES,
} from './packages.js';
import { StartPackageForm } from './StartPackageForm.js';
import './packages.css';

export function PackageStateBadge({ state }: { state: ReportPackageState }): ReactNode {
  return <Badge tone={packageTone(state)}>{humanizeState(state)}</Badge>;
}

/**
 * The packages as one table, in the order they came (newest period first): where each stands and
 * what its checks said first, then what it is, its version and who prepared it. Every row links to
 * its package.
 */
function PackageTable({ rows }: { rows: readonly ReportPackageRow[] }): ReactNode {
  return (
    <TableWrap label="Client packages">
      <table className="pb-table" aria-label="Client packages">
        <thead>
          <tr>
            <th>Client</th>
            <th>Quarter</th>
            <th>State</th>
            <th>Checks</th>
            <th>Basis</th>
            <th>Label</th>
            <th className="num">Version</th>
            <th>Prepared by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="pb-col-text">
                <Link to="/reporting/packages/$id" params={{ id: row.id }}>
                  {row.client.name}
                </Link>
              </td>
              <td className="pb-nowrap">{formatQuarter(row.periodEnd)}</td>
              <td className="pb-nowrap">
                <PackageStateBadge state={row.state} />
              </td>
              <td className="pb-nowrap">{checksSummary(row.qa)}</td>
              <td>{BASIS_WORDS[row.basis]}</td>
              <td>{LABEL_WORDS[row.label]}</td>
              <td className="num">{row.version}</td>
              <td className="pb-nowrap">{row.preparedBy.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * Reporting, Packages (docs/04 M14, docs/18 section 5): every package of the clients the reader
 * sees, newest period first, with where it stands at the release gate and what its checks said.
 * Investor relations start a package here; everything after that happens on the package's page.
 */
export function PackagesPage(): ReactNode {
  const me = useQuery(meQuery);
  const q = useQuery({ ...reportPackagesQuery(), placeholderData: keepPreviousData });
  const log = useActionLog();
  const [starting, setStarting] = useState(false);
  const [clientId, setClientId] = useState('');
  const [state, setState] = useState<ReportPackageState | ''>('');
  const roles = me.data?.roles ?? [];
  const canStart = roles.some((r) => START_ROLES.includes(r));
  // A reader who may not start a package sees the button and which role it needs.
  const blocked = blockedTitle({ allowed: canStart, roles: START_ROLES });
  const blockedId = useId();
  const header = (
    <>
      <PageHeader title="Client packages" meta="Newest quarter first" />
      <TabNav label="Reporting" items={REPORTING_TABS} />
    </>
  );
  if (q.isPending) {
    return (
      <>
        {header}
        <PageSkeleton rows={8} />
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        {header}
        <UnavailableState
          card
          error={q.error}
          subject="Client packages"
          forbidden={{
            title: 'Client packages: not visible to your role',
            detail: WHO_READS_PACKAGES,
          }}
          errorTitle="Client packages unavailable"
          testId="packages-unavailable"
        />
      </>
    );
  }
  const items = q.data.items;
  const clients = clientChoices(items);
  const rows = filterPackages(items, { clientId, state });
  const inProgress = items.filter((row) => row.state !== 'Released').length;
  const clientName = clients.find((c) => c.id === clientId)?.name;
  return (
    <>
      {header}
      <ActionStatus latest={log.latest} testId="package-action-status" />
      {starting ? (
        <StartPackageForm packages={items} onLog={log} onDone={() => setStarting(false)} />
      ) : null}
      <Card testId="packages-card">
        <Toolbar
          end={
            // A reader who may not start a package reads why beside the button, not only in its title.
            <span className="pb-pkg-start">
              {blocked === null ? null : (
                <span className="pb-pkg-start-reason" id={blockedId}>
                  {blocked}
                </span>
              )}
              <Button
                size="small"
                appearance="primary"
                icon={<Add16Regular />}
                disabled={!canStart || starting}
                {...(blocked === null ? {} : { title: blocked, 'aria-describedby': blockedId })}
                onClick={() => setStarting(true)}
              >
                Start package
              </Button>
            </span>
          }
        >
          <Field>
            <Label htmlFor="package-client">Client</Label>
            <Dropdown
              id="package-client"
              className="pb-pkg-filter is-wide"
              value={clientName ?? 'All clients'}
              selectedOptions={[clientId]}
              onOptionSelect={(_e, d) => setClientId(d.optionValue ?? '')}
            >
              <Option value="">All clients</Option>
              {clients.map((c) => (
                <Option key={c.id} value={c.id}>
                  {c.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field>
            <Label htmlFor="package-state">State</Label>
            <Dropdown
              id="package-state"
              className="pb-pkg-filter"
              value={state === '' ? 'All states' : humanizeState(state)}
              selectedOptions={[state]}
              onOptionSelect={(_e, d) => {
                const value = d.optionValue ?? '';
                setState(isPackageState(value) ? value : '');
              }}
            >
              <Option value="">All states</Option>
              {PACKAGE_STATES.map((s) => (
                <Option key={s} value={s}>
                  {humanizeState(s)}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Toolbar>
        {items.length === 0 ? (
          <EmptyState
            title="No packages yet"
            detail="Investor relations start a package for a client, a quarter and a basis. It appears here as a draft."
            testId="packages-empty"
          />
        ) : rows.length === 0 ? (
          <EmptyLine
            title="No packages match"
            detail="Pick another client or state."
            testId="packages-empty"
          />
        ) : (
          <PackageTable rows={rows} />
        )}
        <p className="pb-meta" data-testid="package-count">
          {plural(rows.length, 'package')} shown; {plural(inProgress, 'package')} not yet released.
        </p>
      </Card>
      <ActionLogCard entries={log.entries} />
    </>
  );
}
