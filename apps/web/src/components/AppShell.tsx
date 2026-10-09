import type { ReactNode } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Dropdown, Option } from '@fluentui/react-components';
import {
  ArrowSwap20Regular,
  BookOpen20Regular,
  Briefcase20Regular,
  ChartMultiple20Regular,
  DocumentTable20Regular,
  Flowchart20Regular,
  Folder20Regular,
  Handshake20Regular,
  Home20Regular,
  Pulse20Regular,
  Scales20Regular,
  Settings20Regular,
  Sparkle20Regular,
  TagMultiple20Regular,
} from '@fluentui/react-icons';
import { NAV_GROUPS } from '../app/nav.js';
import { meQuery, mockUsersQuery } from '../app/queries.js';
import { clearCredential, setCredential } from '../app/session.js';
import { ApiError } from '../api/client.js';
import { useSignOutOnRejectedCredential } from '../app/useSignOutOnRejectedCredential.js';
import { useTaxonomyLabels } from '../app/useTaxonomyLabels.js';
import { userLabel } from '../lib/roles.js';
import { PageSkeleton } from './ui.js';

/** Icons keyed by route so nav.ts (the docs/06 list) stays data only. */
const NAV_ICONS: Record<string, ReactNode> = {
  '/': <Home20Regular />,
  '/pipeline': <Flowchart20Regular />,
  '/portfolio': <Briefcase20Regular />,
  '/sponsors': <Handshake20Regular />,
  '/documents': <Folder20Regular />,
  '/valuations': <Scales20Regular />,
  '/capital-activity': <ArrowSwap20Regular />,
  '/reporting': <DocumentTable20Regular />,
  '/analytics': <ChartMultiple20Regular />,
  '/assistants': <Sparkle20Regular />,
  '/admin/flags': <Settings20Regular />,
  '/data/health': <Pulse20Regular />,
  '/data/dictionary': <BookOpen20Regular />,
  '/data/taxonomy': <TagMultiple20Regular />,
};

/** Data pages exist (docs/03 section 4) but were reachable only from Home; a secondary group lists them. */
const DATA_LINKS: { label: string; to: string }[] = [
  { label: 'Data Health', to: '/data/health' },
  { label: 'Data Dictionary', to: '/data/dictionary' },
  { label: 'Taxonomy', to: '/data/taxonomy' },
];

function NavItem({ to, label, exact }: { to: string; label: string; exact: boolean }): ReactNode {
  return (
    <Link
      to={to}
      className="pb-nav-item"
      activeOptions={{ exact }}
      activeProps={{ 'aria-current': 'page' }}
    >
      <span className="pb-nav-icon" aria-hidden="true">
        {NAV_ICONS[to]}
      </span>
      <span className="pb-nav-label">{label}</span>
    </Link>
  );
}

export function RoleSwitcher(): ReactNode {
  const me = useQuery(meQuery);
  const users = useQuery({ ...mockUsersQuery, enabled: me.data?.mockIdentity === true });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  if (me.data?.mockIdentity !== true || users.data === undefined) return null;
  const current = me.data.externalId;
  return (
    <Dropdown
      aria-label="Switch mock user"
      data-testid="role-switcher"
      className="pb-header-switcher"
      size="small"
      value={userLabel(me.data)}
      selectedOptions={[current]}
      onOptionSelect={(_e, data) => {
        const next = data.optionValue;
        if (next === undefined || next === current) return;
        setCredential(next);
        // Nothing the previous user could see may survive the switch, cached or on screen.
        queryClient.clear();
        void navigate({ to: '/' });
      }}
    >
      {users.data.users.map((u) => (
        <Option key={u.externalId} value={u.externalId} text={userLabel(u)}>
          {userLabel(u)}
        </Option>
      ))}
    </Dropdown>
  );
}

export function AppShell(): ReactNode {
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rejected = me.isError && me.error instanceof ApiError && me.error.status === 401;
  const labelsReady = useTaxonomyLabels();
  useSignOutOnRejectedCredential(rejected, () => {
    clearCredential();
    queryClient.clear();
    void navigate({ to: '/sign-in' });
  });
  return (
    <div className="pb-shell">
      <header className="pb-header">
        <Link to="/" className="pb-wordmark">
          Portfolio Beach
        </Link>
        <span className="pb-header-spacer" />
        {me.data !== undefined ? (
          <>
            <div className="pb-header-identity">
              <span className="pb-header-user" data-testid="current-user">
                {me.data.displayName}
              </span>
              <RoleSwitcher />
            </div>
            <Button
              size="small"
              appearance="transparent"
              className="pb-header-signout"
              onClick={() => {
                clearCredential();
                queryClient.clear();
                void navigate({ to: '/sign-in' });
              }}
            >
              Sign out
            </Button>
          </>
        ) : null}
      </header>
      {me.data?.mockIdentity === true ? (
        <div className="pb-mock-banner" role="status">
          <span className="pb-mock-tag">Prototype</span>
          <span>
            Mock identity and synthetic data only. No employer information is present anywhere in
            this system.
          </span>
        </div>
      ) : null}
      <nav className="pb-nav" aria-label="Main">
        <div className="pb-nav-group">
          {NAV_GROUPS.map((g) => (
            <NavItem key={g.to} to={g.to} label={g.label} exact={g.to === '/'} />
          ))}
        </div>
        <div className="pb-nav-group" aria-labelledby="pb-nav-data">
          <span id="pb-nav-data" className="pb-nav-group-label">
            Data
          </span>
          {DATA_LINKS.map((g) => (
            <NavItem key={g.to} to={g.to} label={g.label} exact={false} />
          ))}
        </div>
      </nav>
      <main className="pb-main">{labelsReady ? <Outlet /> : <PageSkeleton />}</main>
    </div>
  );
}
