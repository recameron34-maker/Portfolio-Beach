import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
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
