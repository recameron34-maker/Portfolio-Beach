import type { ReactNode } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Dropdown, Option } from '@fluentui/react-components';
import { NAV_GROUPS } from '../app/nav.js';
import { meQuery, mockUsersQuery } from '../app/queries.js';
import { clearCredential, setCredential } from '../app/session.js';

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
      size="small"
      value={`${me.data.displayName} (${me.data.roles.join(', ')})`}
      selectedOptions={[current]}
      onOptionSelect={(_e, data) => {
        const next = data.optionValue;
        if (next === undefined || next === current) return;
        setCredential(next);
        void queryClient.invalidateQueries().then(() => navigate({ to: '/' }));
      }}
    >
      {users.data.users.map((u) => (
        <Option
          key={u.externalId}
          value={u.externalId}
          text={`${u.displayName} (${u.roles.join(', ')})`}
        >
          {u.displayName} ({u.roles.join(', ')})
        </Option>
      ))}
    </Dropdown>
  );
}

export function AppShell(): ReactNode {
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <div className="pb-shell">
      <header className="pb-header">
        <Link to="/" className="pb-wordmark">
          Portfolio Beach
        </Link>
        <span className="pb-header-spacer" />
        {me.data !== undefined ? (
          <>
            <span data-testid="current-user">{me.data.displayName}</span>
            <RoleSwitcher />
            <Button
              size="small"
              appearance="secondary"
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
          Prototype: mock identity and synthetic data only. No employer information is present
          anywhere in this system.
        </div>
      ) : null}
      <nav className="pb-nav" aria-label="Main">
        {NAV_GROUPS.map((g) => (
          <Link
            key={g.to}
            to={g.to}
            activeOptions={{ exact: g.to === '/' }}
            activeProps={{ 'aria-current': 'page' }}
          >
            {g.label}
          </Link>
        ))}
      </nav>
      <main className="pb-main">
        <Outlet />
      </main>
    </div>
  );
}
