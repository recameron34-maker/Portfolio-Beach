import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, ok } from '../test/api-mock.js';
import { renderWithQuery } from '../test/render.js';
import { usePreviewGuide } from '../lib/preview-guide.js';
import { PreviewGuide } from './PreviewGuide.js';

const env = vi.hoisted(() => ({ previewMode: true }));
vi.mock('../app/env.js', () => env);
vi.mock('@tanstack/react-router', async () =>
  (await import('../test/router-mock.js')).routerMock(),
);

const EM_DASH = String.fromCharCode(0x2014);

/** Synthetic sign-in users, one or two per role, in the order the API lists them. */
const USERS = {
  users: [
    { externalId: 'viewer.one', displayName: 'Vera Viewer', roles: ['viewer'] },
    { externalId: 'deal.one', displayName: 'Dana Deal', roles: ['deal_team'] },
    { externalId: 'deal.three', displayName: 'Wade Wall', roles: ['deal_team'] },
    { externalId: 'ops.one', displayName: 'Opal Ops', roles: ['operations'] },
    { externalId: 'head.one', displayName: 'Ada Approver', roles: ['approver'] },
    { externalId: 'ir.one', displayName: 'Iris Relations', roles: ['investor_relations'] },
    { externalId: 'admin.one', displayName: 'Abe Admin', roles: ['platform_admin'] },
  ],
};

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** Home's wiring: the guide while open, a button to bring it back once hidden. */
function HomeGuide(): ReactNode {
  const guide = usePreviewGuide();
  return (
    <>
      {guide.hidden ? (
        <button type="button" autoFocus={guide.focus === 'show'} onClick={guide.show}>
          Show the preview guide
        </button>
      ) : null}
      {guide.open ? (
        <PreviewGuide variant="home" onHide={guide.hide} focusHide={guide.focus === 'hide'} />
      ) : null}
    </>
  );
}

describe('preview guide', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    env.previewMode = true;
  });

  it('renders nothing outside the preview', () => {
    env.previewMode = false;
    mockApi({ '/api/v1/auth/mock-users': ok(USERS) });
    const { container } = renderWithQuery(
      <>
        <PreviewGuide variant="sign-in" />
        <HomeGuide />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('names the people in the walkthroughs from the mock user list, with links', async () => {
    mockApi({ '/api/v1/auth/mock-users': ok(USERS) });
    renderWithQuery(<PreviewGuide variant="home" onHide={() => undefined} />);
    const guide = screen.getByTestId('preview-guide');
    expect(
      within(guide).getByRole('heading', { name: 'What to try in this preview' }),
    ).toBeVisible();
    expect(guide).toHaveTextContent('Twelve short walkthroughs');
    const titles = within(guide)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(titles).toEqual([
      'Walls and entitlements',
      'Valuation approval',
      'Capital controls',
      'Accounting import',
      'Weekly values',
      'Look-through and exceptions',
      'Workbook drop',
      'Documents and classification',
      'Extraction review',
      'Monitoring board',
      'Analytics and the weekly report',
      'Ask Portfolio Beach',
    ]);
    const walls = screen.getByTestId('guide-walls');
    await waitFor(() => expect(walls).toHaveTextContent('Sign in as Vera Viewer (viewer)'));
    expect(walls).toHaveTextContent(
      'Switch to Wade Wall (deal team), a member of the information wall',
    );
    expect(walls).toHaveTextContent('Switch to Iris Relations (investor relations)');
    const valuations = screen.getByTestId('guide-valuations');
    expect(valuations).toHaveTextContent('As Opal Ops (operations), open Valuations');
    expect(valuations).toHaveTextContent(
      'Switch to Dana Deal (deal team) to Deal team approve it, then to Ada Approver (approver) to Lock it.',
    );
    expect(screen.getByTestId('guide-capital')).toHaveTextContent(
      'Switch to Ada Approver (approver) and try again',
    );
    expect(screen.getByTestId('guide-assistant')).toHaveTextContent(
      'As Abe Admin (platform admin), open Assistants',
    );
    const intake = screen.getByTestId('guide-intake');
    expect(intake).toHaveTextContent('As Opal Ops (operations), open Intake under Data');
    expect(intake).toHaveTextContent('Switch to Wade Wall (deal team) and look at the same file');
    expect(intake).toHaveTextContent('Switch to Vera Viewer (viewer) and open Intake');
    const weekly = screen.getByTestId('guide-weekly');
    expect(weekly).toHaveTextContent('As Opal Ops (operations), open Weekly values under Data');
    expect(weekly).toHaveTextContent('weekly-values-defects.csv');
    expect(weekly).toHaveTextContent('Switch to Wade Wall (deal team) and look at the same file');
    const lookthrough = screen.getByTestId('guide-lookthrough');
    expect(lookthrough).toHaveTextContent('As Opal Ops (operations), open Look-through under Data');
    expect(lookthrough).toHaveTextContent('acknowledge it, then resolve it with a reason');
    const opsDrop = screen.getByTestId('guide-ops-drop');
    expect(opsDrop).toHaveTextContent('ops-drop-clean.xlsx');
    expect(opsDrop).toHaveTextContent('ops-drop-unknown-template.xlsx');
    const documents = screen.getByTestId('guide-documents');
    expect(documents).toHaveTextContent('As Opal Ops (operations), open Documents');
    expect(documents).toHaveTextContent('Switch to Wade Wall (deal team) and search the hub');
    const extraction = screen.getByTestId('guide-extraction');
    expect(extraction).toHaveTextContent('As Abe Admin (platform admin), turn ai.extraction on');
    expect(extraction).toHaveTextContent('then as Opal Ops (operations), open Extraction');
    expect(extraction).toHaveTextContent('Approve and promote');
    const monitoring = screen.getByTestId('guide-monitoring');
    expect(monitoring).toHaveTextContent('Open Monitoring under Portfolio');
    expect(monitoring).toHaveTextContent(
      'Switch to Dana Deal (deal team) and set the realization outlook',
    );
    for (const [name, href, count] of [
      ['Clients', '/reporting/clients', 1],
      ['Valuations', '/valuations', 2],
      ['Capital activity', '/capital-activity', 1],
      ['Intake', '/data/intake', 2],
      ['Weekly values', '/data/weekly', 1],
      ['Look-through', '/data/lookthrough', 1],
      ['Exceptions', '/data/exceptions', 1],
      ['Documents', '/documents', 1],
      ['Review queue', '/documents/review', 1],
      ['Expected documents', '/documents/expected', 1],
      ['Flags', '/admin/flags', 1],
      ['Extraction', '/documents/extraction', 1],
      ['Monitoring', '/portfolio/monitoring', 1],
      ['Analytics', '/analytics', 1],
      ['Weekly report', '/reporting', 1],
      ['Assistants', '/assistants', 1],
    ] as const) {
      const links = within(guide).getAllByRole('link', { name });
      expect(links, name).toHaveLength(count);
      for (const link of links) expect(link).toHaveAttribute('href', href);
    }
    expect(within(guide).getAllByRole('link', { name: 'Portfolio' })).toHaveLength(2);
    for (const w of [
      'walls',
      'valuations',
      'capital',
      'intake',
      'weekly',
      'lookthrough',
      'ops-drop',
      'documents',
      'extraction',
      'monitoring',
      'analytics',
      'assistant',
    ]) {
      const steps = within(screen.getByTestId(`guide-${w}`)).getAllByRole('listitem');
      expect(steps.length, w).toBeGreaterThanOrEqual(2);
      expect(steps.length, w).toBeLessThanOrEqual(4);
    }
    expect(guide.textContent).not.toContain(EM_DASH);
  });

  it('keeps the sign-in card compact: each walkthrough folds, with no reset there', async () => {
    mockApi({ '/api/v1/auth/mock-users': ok(USERS) });
    renderWithQuery(<PreviewGuide variant="sign-in" />);
    const guide = screen.getByTestId('preview-guide');
    const summaries = [...guide.querySelectorAll('details > summary')].map((s) => s.textContent);
    expect(summaries).toHaveLength(12);
    expect(summaries[0]).toBe('Walls and entitlements');
    await waitFor(() =>
      expect(screen.getByTestId('guide-walls')).toHaveTextContent('Vera Viewer (viewer)'),
    );
    expect(within(guide).queryByRole('button', { name: 'Reset preview' })).toBeNull();
    expect(within(guide).queryByRole('button', { name: 'Hide guide' })).toBeNull();
  });

  it('folds the walkthroughs on Home at phone width, keeping the reset', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    mockApi({ '/api/v1/auth/mock-users': ok(USERS) });
    renderWithQuery(<PreviewGuide variant="home" onHide={() => undefined} />);
    const guide = screen.getByTestId('preview-guide');
    expect(guide.querySelectorAll('details > summary')).toHaveLength(12);
    expect(guide.querySelector('.pb-guide-list')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('guide-walls')).toHaveTextContent('Vera Viewer (viewer)'),
    );
    expect(within(guide).getByRole('button', { name: 'Reset preview' })).toBeVisible();
  });

  it('resets the simulated changes from Home and says so', async () => {
    mockApi({
      '/api/v1/auth/mock-users': ok(USERS),
      '/api/v1/preview/reset': ok({ reset: true }),
    });
    renderWithQuery(<PreviewGuide variant="home" onHide={() => undefined} />);
    expect(
      screen.getByText(
        'Simulated changes stay in this browser tab and reset when the page reloads.',
      ),
    ).toBeVisible();
    expect(screen.getByTitle(/Simulated in this preview/)).toHaveTextContent('Simulated');
    await userEvent.click(screen.getByRole('button', { name: 'Reset preview' }));
    expect(await screen.findByTestId('guide-reset-result')).toHaveTextContent(
      'Preview reset. Every simulated change in this tab is forgotten.',
    );
    const resets = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([input]) => urlOf(input) === '/api/v1/preview/reset');
    expect(resets.map(([, init]) => init?.method)).toEqual(['POST']);
  });

  it('hides for the rest of the tab and comes back on request', async () => {
    mockApi({ '/api/v1/auth/mock-users': ok(USERS) });
    const first = renderWithQuery(<HomeGuide />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide guide' }));
    expect(screen.queryByTestId('preview-guide')).toBeNull();
    expect(window.sessionStorage.getItem('pb.previewGuide')).toBe('hidden');
    first.unmount();

    // Coming back to Home in the same tab keeps it hidden, without taking focus on arrival.
    renderWithQuery(<HomeGuide />);
    expect(screen.queryByTestId('preview-guide')).toBeNull();
    const show = screen.getByRole('button', { name: 'Show the preview guide' });
    expect(show).not.toHaveFocus();
    await userEvent.click(show);
    expect(screen.getByTestId('preview-guide')).toBeVisible();
    expect(window.sessionStorage.getItem('pb.previewGuide')).toBeNull();
    // Focus follows the toggle, so a keyboard user is never left on a removed button.
    expect(screen.getByRole('button', { name: 'Hide guide' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Hide guide' }));
    expect(screen.getByRole('button', { name: 'Show the preview guide' })).toHaveFocus();
  });

  it('still shows and hides when session storage throws', async () => {
    const blocked = (): never => {
      throw new Error('storage is blocked');
    };
    vi.stubGlobal('sessionStorage', {
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
    });
    mockApi({ '/api/v1/auth/mock-users': ok(USERS) });
    renderWithQuery(<HomeGuide />);
    expect(screen.getByTestId('preview-guide')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Hide guide' }));
    expect(screen.queryByTestId('preview-guide')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show the preview guide' }));
    expect(screen.getByTestId('preview-guide')).toBeVisible();
  });
});
