import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
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
  startFormFor,
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
 * A released package links back here to start its corrected version: the address names it, and
 * the form opens with its client, quarter and basis.
 */
export function PackagesPage(): ReactNode {
  const me = useQuery(meQuery);
  const q = useQuery({ ...reportPackagesQuery(), placeholderData: keepPreviousData });
  const log = useActionLog();
  // The address may name a released package whose corrected version is being started.
  const search = useSearch({ from: '/app/reporting/packages' });
  const [starting, setStarting] = useState(false);
  // Closed by the person: the form the address asked for does not open a second time.
  const [closed, setClosed] = useState(false);
  const [clientId, setClientId] = useState('');
  const [state, setState] = useState<ReportPackageState | ''>('');
  const roles = me.data?.roles ?? [];
  const canStart = roles.some((r) => START_ROLES.includes(r));
  // The form of a corrected version, for a reader who may start one; null for anyone else, and
  // for a package that is not on the list or not released.
  const correcting = canStart && !closed ? startFormFor(q.data?.items ?? [], search.correct) : null;
  const formOpen = starting || correcting !== null;
  // The form takes the place of the button that opens it. When the form closes the button is
  // back and takes focus, so cancelling does not drop a keyboard user to the top of the page.
  const startButton = useRef<HTMLButtonElement | null>(null);
  const formWasOpen = useRef(false);
  useEffect(() => {
    if (formWasOpen.current && !formOpen) startButton.current?.focus();
    formWasOpen.current = formOpen;
  }, [formOpen]);
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
  const closeForm = (): void => {
    setStarting(false);
    setClosed(true);
  };
  return (
    <>
      {header}
      <ActionStatus latest={log.latest} testId="package-action-status" />
      {formOpen ? (
        <StartPackageForm
          packages={items}
          {...(starting || correcting === null ? {} : { initial: correcting })}
          onLog={log}
          onDone={closeForm}
        />
      ) : null}
      <Card testId="packages-card">
        <Toolbar
          end={
            // While the form is open its own button starts the package: a second one here would
            // only be a disabled twin. A reader who may not start a package reads why beside the
            // button, not only in its title.
            formOpen ? undefined : (
              <span className="pb-pkg-start">
                {blocked === null ? null : (
                  <span className="pb-pkg-start-reason" id={blockedId}>
                    {blocked}
                  </span>
                )}
                <Button
                  // Fluent's Button infers its ref element from a slot union: a typed callback.
                  ref={(el: HTMLButtonElement | null) => {
                    startButton.current = el;
                  }}
                  size="small"
                  appearance="primary"
                  icon={<Add16Regular />}
                  disabled={!canStart}
                  {...(blocked === null ? {} : { title: blocked, 'aria-describedby': blockedId })}
                  onClick={() => setStarting(true)}
                >
                  Start package
                </Button>
              </span>
            )
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
        {/* With no package at all the empty state has said it. */}
        {items.length === 0 ? null : (
          <p className="pb-meta" data-testid="package-count">
            {plural(rows.length, 'package')} shown; {plural(inProgress, 'package')} not yet
            released.
          </p>
        )}
      </Card>
      <ActionLogCard entries={log.entries} />
    </>
  );
}
