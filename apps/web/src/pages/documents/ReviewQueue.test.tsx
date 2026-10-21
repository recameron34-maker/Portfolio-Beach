import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { rolePrincipal, sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { DOC_ID, documentPageFixture, scanFixture } from './fixtures.js';
import { ReviewQueuePage } from './ReviewQueue.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const QUEUE = '/api/v1/documents/review-queue';
const TIMEOUT = { timeout: 15_000 };

function routes(overrides: MockRoutes = {}): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(['viewer'])),
    [QUEUE]: ok(
      documentPageFixture([
        scanFixture(),
        scanFixture({
          id: DOC_ID.notice,
          title: 'unreadable_0007',
          fileName: 'unreadable_0007.pdf',
          classificationConfidence: null,
          classifierEvidence: { keywords: [], candidates: [] },
          indexedAt: '2025-07-01T09:14:00.000Z',
        }),
      ]),
    ),
    ...overrides,
  };
}

describe('review queue', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists every document waiting for a person, newest first, each linking to its page', async () => {
    mockApi(routes());
    renderWithQuery(<ReviewQueuePage />);
    const table = await screen.findByRole('table', { name: 'Review queue' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Review queue');
    expect(screen.getByRole('navigation', { name: 'Documents' })).toHaveTextContent('Hub');
    expect(screen.getByTestId('review-queue')).toBe(table);
    expect(sentRequests().map(([url]) => url)).toContain(`${QUEUE}?limit=200`);
    expect(screen.getByText('2 documents')).toBeInTheDocument();
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByRole('link', { name: 'scan_0042' })).toHaveAttribute(
      'href',
      `/documents/${DOC_ID.scan}`,
    );
    expect(within(rows[1]!).getByText('Needs review')).toHaveClass('pb-badge-watch');
    expect(within(rows[1]!).getByText('30%')).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('link', { name: 'unreadable_0007' })).toHaveAttribute(
      'href',
      `/documents/${DOC_ID.notice}`,
    );
    expect(screen.queryByTestId('review-queue-truncated')).not.toBeInTheDocument();
  });

  it('says when nothing waits', async () => {
    mockApi(routes({ [QUEUE]: ok(documentPageFixture([])) }));
    renderWithQuery(<ReviewQueuePage />);
    expect(await screen.findByTestId('review-queue-empty')).toHaveTextContent(
      'Nothing waits for review',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says when more wait than one page holds', async () => {
    mockApi(routes({ [QUEUE]: ok(documentPageFixture([scanFixture()], 'next')) }));
    renderWithQuery(<ReviewQueuePage />);
    await screen.findByRole('table', { name: 'Review queue' });
    expect(screen.getByTestId('review-queue-truncated')).toHaveTextContent(
      'Showing the first 200 documents; more wait.',
    );
  });

  it(
    'shows a skeleton while loading and the reason when the queue cannot load',
    TIMEOUT,
    async () => {
      mockApi(routes({ [QUEUE]: failing(403, QUEUE) }));
      renderWithQuery(<ReviewQueuePage />);
      expect(screen.getByText('Loading')).toBeInTheDocument();
      expect(
        await screen.findByText('The review queue: not visible to your role'),
      ).toBeInTheDocument();
      cleanup();
      vi.restoreAllMocks();
      mockApi(routes({ [QUEUE]: { status: 500, body: {} } }));
      renderWithQuery(<ReviewQueuePage />);
      expect(await screen.findByText('Review queue unavailable', {}, TIMEOUT)).toBeInTheDocument();
    },
  );
});
