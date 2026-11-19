import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DATA_LINKS, NAV_GROUPS } from '../app/nav.js';
import { clearCredential, getCredential, setCredential } from '../app/session.js';
import { AppShell } from './AppShell.js';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children }: { children: unknown }) => <a>{children as never}</a>,
  Outlet: () => null,
}));

const problem = {
  type: 'https://portfolio-beach.example/problems/unauthenticated',
  title: 'Authentication required',
  status: 401,
  detail: 'Sign in to continue',
  request_id: 'test',
};

describe('app shell with a rejected credential', () => {
  beforeEach(() => {
    setCredential('nobody.known');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(problem), {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearCredential();
    navigate.mockReset();
  });

  it('clears the credential and returns to sign-in when the API answers 401', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AppShell />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/sign-in' }));
    expect(getCredential()).toBeNull();
  });
});

describe('the main navigation', () => {
  beforeEach(() => {
    setCredential('viewer.one');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    clearCredential();
    navigate.mockReset();
  });

  it('gives every link an icon, the Data group included', () => {
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AppShell />
      </QueryClientProvider>,
    );
    const nav = within(container).getByRole('navigation', { name: 'Main' });
    for (const link of [...NAV_GROUPS, ...DATA_LINKS]) {
      const item = within(nav).getByText(link.label).closest('a');
      expect(item, link.to).not.toBeNull();
      expect(item?.querySelector('.pb-nav-icon svg'), link.to).not.toBeNull();
    }
  });
});

describe('the main navigation for a role (config/role_focus.json)', () => {
  const signInAs = (role: string): void => {
    setCredential('someone.one');
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        url.includes('/api/v1/auth/me')
          ? new Response(
              JSON.stringify({
                userId: '00000000-0000-4000-8000-000000000001',
                externalId: 'someone.one',
                displayName: 'Someone One',
                roles: [role],
                clientIds: [],
                mockIdentity: true,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
      );
    });
  };
  const shell = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AppShell />
      </QueryClientProvider>,
    );
  const labelsOf = (group: HTMLElement): string[] =>
    [...group.querySelectorAll('.pb-nav-label')].map((el) => el.textContent ?? '');
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    clearCredential();
    navigate.mockReset();
  });

  it('puts the areas operations works in first, under its name, and keeps every other link', async () => {
    signInAs('operations');
    shell();
    const own = await screen.findByRole('group', { name: 'Operations' });
    expect(labelsOf(own)).toEqual([
      'Home',
      'Capital Activity',
      'Valuations',
      'Documents',
      'Portfolio',
      'Intake',
      'Exceptions',
      'Reporting',
    ]);
    expect(labelsOf(screen.getByRole('group', { name: 'More' }))).toEqual([
      'Pipeline',
      'Sponsors',
      'Analytics',
      'Assistants',
      'Admin',
    ]);
    const data = labelsOf(screen.getByRole('group', { name: 'Data' }));
    expect(data).not.toContain('Intake');
    expect(data).toContain('Data Dictionary');
    // Nothing is left out, and every link keeps its icon.
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const link of [...NAV_GROUPS, ...DATA_LINKS]) {
      const item = within(nav).getByText(link.label).closest('a');
      expect(item?.querySelector('.pb-nav-icon svg'), link.to).not.toBeNull();
    }
  });

  it('gives the deal team and investor relations their own order', async () => {
    signInAs('deal_team');
    const first = shell();
    expect(labelsOf(await screen.findByRole('group', { name: 'Deal team' }))).toEqual([
      'Home',
      'Pipeline',
      'Portfolio',
      'Sponsors',
      'Analytics',
      'Documents',
    ]);
    first.unmount();
    vi.restoreAllMocks();
    signInAs('investor_relations');
    shell();
    expect(labelsOf(await screen.findByRole('group', { name: 'Investor relations' }))).toEqual([
      'Home',
      'Reporting',
      'Portfolio',
      'Analytics',
      'Sponsors',
    ]);
  });
});

describe('switching the mock user', () => {
  const users = [
    {
      userId: '20000000-0000-4000-8000-000000000001',
      externalId: 'viewer.one',
      displayName: 'Finley Oyelaran',
      roles: ['viewer'],
    },
    {
      userId: '20000000-0000-4000-8000-000000000002',
      externalId: 'admin.one',
      displayName: 'Rowan Iyer',
      roles: ['platform_admin'],
    },
  ];
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  /** Answers as whoever the request's bearer credential names, like the API and the preview shim. */
  const answer = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const credential = String(new Headers(init?.headers).get('authorization') ?? '').replace(
      'Bearer ',
      '',
    );
    const user = users.find((u) => u.externalId === credential);
    if (path.includes('/auth/mock-users'))
      return Promise.resolve(
        json({
          users: users.map(({ externalId, displayName, roles }) => ({
            externalId,
            displayName,
            roles,
          })),
        }),
      );
    if (path.includes('/auth/me') && user !== undefined)
      return Promise.resolve(json({ ...user, clientIds: [], mockIdentity: true }));
    if (path.includes('/taxonomy')) return Promise.resolve(json({ domains: [] }));
    return Promise.resolve(new Response('{}', { status: 404 }));
  };
  beforeEach(() => {
    setCredential('viewer.one');
    vi.spyOn(globalThis, 'fetch').mockImplementation(answer);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    clearCredential();
    navigate.mockReset();
  });

  it('shows the new user in the header once their identity is read, and goes home', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AppShell />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('current-user')).toHaveTextContent('Finley Oyelaran');
    await userEvent.click(await screen.findByRole('combobox', { name: 'Switch mock user' }));
    await userEvent.click(await screen.findByRole('option', { name: /Rowan Iyer/ }));
    await waitFor(() => expect(screen.getByTestId('current-user')).toHaveTextContent('Rowan Iyer'));
    expect(getCredential()).toBe('admin.one');
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });

  it('shows the role in words and lists the users under their roles', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AppShell />
      </QueryClientProvider>,
    );
    const switcher = await screen.findByRole('combobox', { name: 'Switch mock user' });
    expect(switcher).toHaveTextContent('viewer');
    await userEvent.click(switcher);
    const admins = await screen.findByRole('group', { name: 'Platform admin' });
    expect(within(admins).getByRole('option', { name: 'Rowan Iyer' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Viewer' })).getByRole('option', {
        name: 'Finley Oyelaran',
      }),
    ).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the frame around every page', () => {
  const me = {
    userId: '20000000-0000-4000-8000-000000000003',
    externalId: 'ops.one',
    displayName: 'Avery Mbeki',
    roles: ['operations'],
    clientIds: [],
    mockIdentity: true,
  };
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const shell = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AppShell />
      </QueryClientProvider>,
    );
  /** A phone-width screen: the media helpers read (max-width: 760px). */
  const narrowScreen = (): void => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  };
  beforeEach(() => {
    setCredential('ops.one');
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/auth/me')) return Promise.resolve(json(me));
      if (url.includes('/auth/mock-users'))
        return Promise.resolve(
          json({
            users: [{ externalId: 'ops.one', displayName: 'Avery Mbeki', roles: ['operations'] }],
          }),
        );
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearCredential();
    navigate.mockReset();
  });

  it('starts with a link that takes the keyboard to the page', async () => {
    shell();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main');
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
    await userEvent.click(skip);
    expect(main).toHaveFocus();
  });

  it('states the data rule once, in the bar, with the user and the wordmark', async () => {
    shell();
    expect(await screen.findByTestId('current-user')).toHaveTextContent('Avery Mbeki');
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Prototype');
    expect(status).toHaveTextContent(
      'Mock identity and synthetic data only. No employer information is present anywhere in this system.',
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
    expect(screen.getAllByText('Portfolio Beach')).toHaveLength(1);
  });

  it('on a phone asks for the switcher users with the page, before the drawer opens', async () => {
    narrowScreen();
    shell();
    expect(await screen.findByTestId('current-user')).toHaveTextContent('Avery Mbeki');
    const asked = (): boolean =>
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some(([input]) =>
          (typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).includes('/auth/mock-users'),
        );
    await waitFor(() => expect(asked()).toBe(true));
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('on a phone keeps the data rule in the bar and opens the navigation in a drawer', async () => {
    narrowScreen();
    shell();
    // The bar: the menu, the marker with the whole sentence inside it, the user and Sign out.
    expect(await screen.findByTestId('current-user')).toHaveTextContent('Avery Mbeki');
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Prototype');
    expect(status).toHaveTextContent('synthetic data only');
    expect(status).toHaveAttribute('title', expect.stringContaining('synthetic data only'));
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    // No navigation until the drawer opens; then one, and still one status.
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(within(drawer).getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(drawer).toHaveTextContent('synthetic data only');
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(within(drawer).queryByRole('status')).toBeNull();
    expect(screen.getAllByTestId('current-user')).toHaveLength(1);
    expect(
      await within(drawer).findByRole('combobox', { name: 'Switch mock user' }),
    ).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close navigation' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull());
  });
});
