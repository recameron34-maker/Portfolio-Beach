import type { ReactNode } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Dropdown, Option } from '@fluentui/react-components';
import {
  ArrowImport20Regular,
  ArrowSwap20Regular,
  BookOpen20Regular,
  Briefcase20Regular,
  CalendarWeekStart20Regular,
  ChartMultiple20Regular,
  DocumentTable20Regular,
  Eye20Regular,
  Flowchart20Regular,
  Folder20Regular,
  Handshake20Regular,
  Home20Regular,
  Pulse20Regular,
  Scales20Regular,
  Settings20Regular,
  Sparkle20Regular,
  TagMultiple20Regular,
  Warning20Regular,
} from '@fluentui/react-icons';
import { meQuery, mockUsersQuery } from '../app/queries.js';
import { clearCredential, setCredential } from '../app/session.js';
import { ApiError } from '../api/client.js';
import { useSignOutOnRejectedCredential } from '../app/useSignOutOnRejectedCredential.js';
import { useTaxonomyLabels } from '../app/useTaxonomyLabels.js';
import { focusOf, navFor } from '../lib/role-focus.js';
import type { NavLink } from '../lib/role-focus.js';
import { RoleFocusContext } from '../lib/role-focus-context.js';
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
  '/data/intake': <ArrowImport20Regular />,
  '/data/weekly': <CalendarWeekStart20Regular />,
  '/data/lookthrough': <Eye20Regular />,
  '/data/exceptions': <Warning20Regular />,
};

function NavItem({ link }: { link: NavLink }): ReactNode {
  return (
    <Link
      to={link.href}
      className="pb-nav-item"
      activeOptions={{ exact: link.to === '/' }}
      activeProps={{ 'aria-current': 'page' }}
    >
      <span className="pb-nav-icon" aria-hidden="true">
        {NAV_ICONS[link.to]}
      </span>
      <span className="pb-nav-label">{link.label}</span>
    </Link>
  );
}

/** One group of the main navigation, under its name when it has one. */
function NavGroup({
  id,
  label,
  links,
}: {
  id: string;
  label: string | null;
  links: readonly NavLink[];
}): ReactNode {
  if (links.length === 0) return null;
  return (
    <div
      className="pb-nav-group"
      {...(label === null ? {} : { role: 'group', 'aria-labelledby': id })}
    >
      {label === null ? null : (
        <span id={id} className="pb-nav-group-label">
          {label}
        </span>
      )}
      {links.map((link) => (
        <NavItem key={link.to} link={link} />
      ))}
    </div>
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
        // Nothing the previous user could see may survive the switch, cached or on screen: every
        // query drops its data, and the ones on screen fetch again as the new user (clear() would
        // leave the mounted queries detached, still showing the old answers).
        queryClient.getMutationCache().clear();
        void queryClient.resetQueries();
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
  // The role's own areas come first, under its name; every other area stays, after them.
  const focus = focusOf(me.data?.roles);
  const nav = navFor(focus);
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
        <NavGroup id="pb-nav-focus" label={nav.area} links={nav.focus} />
        <NavGroup id="pb-nav-more" label="More" links={nav.more} />
        <NavGroup id="pb-nav-data" label="Data" links={nav.data} />
      </nav>
      <main className="pb-main">
        <RoleFocusContext.Provider value={focus}>
          {labelsReady ? <Outlet /> : <PageSkeleton />}
        </RoleFocusContext.Provider>
      </main>
    </div>
  );
}
