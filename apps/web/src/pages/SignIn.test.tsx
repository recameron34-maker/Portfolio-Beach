import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getCredential, clearCredential } from '../app/session.js';
import { SignInPage } from './SignIn.js';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

describe('mock sign-in (prototype)', () => {
  beforeEach(() => {
    clearCredential();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          users: [{ externalId: 'ops.one', displayName: 'Ops One', roles: ['operations'] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('stores the chosen user as the session credential and goes home', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SignInPage />
      </QueryClientProvider>,
    );
    const button = await screen.findByRole('button', { name: /Ops One/ });
    await userEvent.click(button);
    await waitFor(() => expect(getCredential()).toBe('ops.one'));
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
    expect(window.localStorage.getItem('pb.credential')).toBeNull();
  });

  it('lists the users in one list, grouped by role, each named with its role', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          users: [
            { externalId: 'viewer.one', displayName: 'Vera Viewer', roles: ['viewer'] },
            { externalId: 'deal.one', displayName: 'Dana Deal', roles: ['deal_team'] },
            { externalId: 'deal.two', displayName: 'Dev Deal', roles: ['deal_team'] },
            { externalId: 'ops.one', displayName: 'Ops One', roles: ['operations'] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SignInPage />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    const list = await screen.findByTestId('mock-user-list');
    const groups = within(list).getAllByRole('group');
    expect(groups.map((g) => g.firstChild?.textContent)).toEqual([
      'Viewer',
      'Deal team',
      'Operations',
    ]);
    // Each row is named by what it shows: the user and the role in words.
    const team = within(list).getByRole('group', { name: 'Deal team' });
    const rows = within(team).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName('Dana Deal, deal team');
    expect(rows[1]).toHaveAccessibleName('Dev Deal, deal team');
    expect(within(list).getByRole('button', { name: 'Ops One, operations' })).toBeVisible();
  });

  it('says plainly when the sign-in service does not answer', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
    );
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SignInPage />
      </QueryClientProvider>,
    );
    const error = await screen.findByTestId('error-state');
    expect(error).toHaveTextContent('Sign-in unavailable');
    expect(error).toHaveTextContent(
      'The sign-in service did not answer. Reload the page to try again.',
    );
    expect(screen.queryByTestId('mock-user-list')).toBeNull();
  });
});
