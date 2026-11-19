import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminFlagsPage } from './AdminFlags.js';
import { flagsFixture, mockApi, principalFixture, withQueries } from './assistants/test-support.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../test/router-mock.js')).routerMock(),
);

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const admin = principalFixture({ externalId: 'admin.one', roles: ['platform_admin'] });

const renderAs = (principal = admin): void => {
  mockApi({
    '/api/v1/auth/me': { body: principal },
    '/api/v1/flags': { body: flagsFixture(false) },
    '/api/v1/flags/ai.extraction': {
      body: {
        key: 'ai.extraction',
        enabled: true,
        description: 'Kill switch for AI extraction calls',
      },
    },
  });
  render(withQueries(<AdminFlagsPage />));
};

describe('feature flags page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('names each flag by its description, marks the kill switches in words and never shows a key', async () => {
    renderAs();
    const table = await screen.findByRole('table', { name: 'Feature flags' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Flag', 'State', 'Change']);
    const names = within(table)
      .getAllByRole('rowheader')
      .map((h) => h.textContent);
    expect(names).toEqual([
      'Kill switch for AI extraction callsKill switch',
      'Kill switch for Ask Portfolio BeachKill switch',
      'Mail and calendar capture adapter',
      'Document hub adapter',
      'Accounting import and export adapter',
    ]);
    // A key is in no cell's text; the switch keeps it in its name for the preview's probe.
    expect(table).not.toHaveTextContent('ai.extraction');
    expect(table).not.toHaveTextContent('adapter.');
    expect(screen.getByRole('switch', { name: 'ai.extraction enabled' })).toBeInTheDocument();
    const mail = within(table).getByRole('rowheader', {
      name: 'Mail and calendar capture adapter',
    });
    expect(within(mail.closest('tr')!).getByText('Off')).toBeVisible();
  });

  it('unlocks the switches only once a reason of three characters is typed, and sends it', async () => {
    renderAs();
    expect(await screen.findByText(/You can change flags/)).toBeVisible();
    const reason = screen.getByLabelText('Reason for the next change');
    expect(reason).toHaveAccessibleDescription(
      'Type a reason to unlock the switches. Every change is audited.',
    );
    const extraction = screen.getByRole('switch', { name: 'ai.extraction enabled' });
    expect(extraction).toBeDisabled();
    await userEvent.type(reason, 'ok');
    expect(extraction).toBeDisabled();
    await userEvent.type(reason, '!');
    expect(extraction).toBeEnabled();
    await userEvent.click(extraction);
    expect(await screen.findByTestId('flag-message')).toHaveTextContent('ai.extraction is now on');
    const patch = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([input]) => urlOf(input) === '/api/v1/flags/ai.extraction');
    expect(patch?.[1]?.method).toBe('PATCH');
    const body = patch?.[1]?.body;
    expect(JSON.parse(typeof body === 'string' ? body : '{}')).toEqual({
      enabled: true,
      reason: 'ok!',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Clear reason' }));
    expect(reason).toHaveValue('');
  });

  it('is read only for every other role, with no reason to type', async () => {
    renderAs(principalFixture());
    expect(await screen.findByText('Read-only for your role.')).toBeVisible();
    expect(screen.queryByLabelText('Reason for the next change')).toBeNull();
    for (const s of screen.getAllByRole('switch')) expect(s).toBeDisabled();
  });

  it('puts the switch second on a phone, so it stays on screen', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    renderAs();
    const table = await screen.findByRole('table', { name: 'Feature flags' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Flag', 'Change', 'State']);
    const first = within(table).getAllByRole('row')[1]!;
    const cells = within(first).getAllByRole('cell');
    expect(within(cells[0]!).getByRole('switch')).toBeInTheDocument();
    expect(cells[1]).toHaveTextContent('Off');
  });
});
