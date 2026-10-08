import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setCredential, clearCredential } from '../../app/session.js';
import { AssistantSwitch } from './AssistantSwitch.js';
import { mockApi, mockUsersFixture, principalFixture, withQueries } from './test-support.js';

const env = vi.hoisted(() => ({ previewMode: true }));
vi.mock('../../app/env.js', () => env);

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** Every request the switch sent to the ai.assistant flag. */
const patches = (): (RequestInit | undefined)[] =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([url]) => urlOf(url) === '/api/v1/flags/ai.assistant')
    .map(([, init]) => init);

const flag = {
  key: 'ai.assistant',
  enabled: true,
  description: 'Kill switch for Ask Portfolio Beach',
};

describe('assistant switch (preview only)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    clearCredential();
    env.previewMode = true;
  });

  it('lets a platform admin turn the assistant on through the simulated flag change', async () => {
    setCredential('admin.one');
    mockApi({
      '/api/v1/auth/me': {
        body: principalFixture({ externalId: 'admin.one', roles: ['platform_admin'] }),
      },
      '/api/v1/auth/mock-users': { body: mockUsersFixture() },
      '/api/v1/flags/ai.assistant': { body: flag },
    });
    render(withQueries(<AssistantSwitch />));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Turn the assistant on for this session' }),
    );
    const flagCall = async (): Promise<RequestInit | undefined> => {
      await waitFor(() => expect(patches().length).toBe(1));
      return patches()[0];
    };
    const init = await flagCall();
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')).toEqual({
      enabled: true,
      reason: 'Preview demonstration of the mock assistant',
    });
    expect(screen.getByTitle(/Simulated in this preview/)).toBeInTheDocument();
  });

  it('tells other users which mock user can turn it on', async () => {
    setCredential('ops.one');
    mockApi({
      '/api/v1/auth/me': { body: principalFixture() },
      '/api/v1/auth/mock-users': { body: mockUsersFixture() },
    });
    render(withQueries(<AssistantSwitch />));
    await waitFor(() =>
      expect(screen.getByTestId('assistant-switch-hint')).toHaveTextContent(
        /switch to Admin One \(platform admin\)/,
      ),
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing outside the preview', async () => {
    env.previewMode = false;
    setCredential('admin.one');
    mockApi({
      '/api/v1/auth/me': { body: principalFixture({ roles: ['platform_admin'] }) },
    });
    const { container } = render(withQueries(<AssistantSwitch />));
    await waitFor(() => expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
