import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
});
