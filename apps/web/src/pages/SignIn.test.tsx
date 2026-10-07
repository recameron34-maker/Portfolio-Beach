import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  afterEach(() => vi.restoreAllMocks());

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
});
