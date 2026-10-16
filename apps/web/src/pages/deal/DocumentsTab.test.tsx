import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, screen, within } from '@testing-library/react';
import { failing, mockApi, ok, problemFixture } from '../../test/api-mock.js';
import {
  DEAL_DOCUMENT_ID,
  DEAL_PATHS,
  dealDocumentFixture,
  dealDocumentPageFixture,
} from '../../test/fixtures-deal.js';
import { MISSING } from '../../lib/format.js';
import { renderWithQuery } from '../../test/render.js';
import { DocumentsTab } from './DocumentsTab.js';

vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  const base = routerMock();
  const BaseLink = base.Link as (props: { to: string; children?: ReactNode }) => ReactNode;
  return {
    ...base,
    useParams: () => ({ id }),
    // The document and run links address the hub by href (HubLink); the rest resolve a route.
    Link: (props: { to: string; href?: string; className?: string; children?: ReactNode }) =>
      props.href === undefined ? (
        BaseLink(props)
      ) : (
        <a href={props.href} className={props.className}>
          {props.children}
        </a>
      ),
  };
});

const EM_DASH = String.fromCharCode(0x2014);

describe('documents tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists the documents of the position newest first, each linked, with type, period, status and run', async () => {
    mockApi({ [DEAL_PATHS.documents]: ok(dealDocumentPageFixture()) });
    renderWithQuery(<DocumentsTab />);
    const table = await screen.findByRole('table', { name: 'Documents' });
    const card = screen.getByTestId('deal-documents');
    expect(card).toHaveTextContent('2 documents, newest first');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);

    const report = within(rows[0]!).getByRole('link', {
      name: 'Meridian Data Partners quarterly report Q2 2025',
    });
    expect(report).toHaveAttribute('href', `/documents/${DEAL_DOCUMENT_ID.report}`);
    expect(rows[0]).toHaveTextContent(
      '2025-06-30 Kelpwood Fund IV - Quarterly financials - Meridian Data Partners.pdf',
    );
    expect(rows[0]).toHaveTextContent('Quarterly financials');
    expect(rows[0]).toHaveTextContent('Jun 30, 2025');
    expect(rows[0]).toHaveTextContent('Classified');
    expect(rows[0]).toHaveTextContent('Aug 2, 2025');
    const run = within(rows[0]!).getByRole('link', { name: 'Extraction Succeeded' });
    expect(run).toHaveAttribute('href', `/documents/extraction/${DEAL_DOCUMENT_ID.run}`);

    // The scan: no type, no period, waiting on a reviewer, never extracted.
    expect(within(rows[1]!).getByRole('link', { name: 'scan_0042' })).toHaveAttribute(
      'href',
      `/documents/${DEAL_DOCUMENT_ID.scan}`,
    );
    const cells = within(rows[1]!)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells[1]).toBe(MISSING);
    expect(cells[2]).toBe(MISSING);
    expect(rows[1]).toHaveTextContent('Needs review');
    expect(within(rows[1]!).queryByRole('link', { name: /Extraction/ })).toBeNull();
    expect(rows[1]).toHaveTextContent('Jul 20, 2025');

    expect(within(card).getByRole('link', { name: 'Open the document hub' })).toHaveAttribute(
      'href',
      '/documents',
    );
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('says when only the first page is shown', async () => {
    mockApi({
      [DEAL_PATHS.documents]: ok({ ...dealDocumentPageFixture(), nextCursor: 'later|cursor' }),
    });
    renderWithQuery(<DocumentsTab />);
    expect(await screen.findByText(/Showing the first 200 documents/)).toBeInTheDocument();
  });

  it('shows the empty state when no document is linked to the position', async () => {
    mockApi({ [DEAL_PATHS.documents]: ok(dealDocumentPageFixture([])) });
    renderWithQuery(<DocumentsTab />);
    const empty = await screen.findByTestId('deal-documents-empty');
    expect(empty).toHaveTextContent('No documents for this position');
    expect(empty).toHaveTextContent('once operations indexes the document store');
    expect(screen.getByTestId('deal-documents')).toHaveTextContent('0 documents, newest first');
    expect(screen.queryByRole('table', { name: 'Documents' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the document hub' })).toBeInTheDocument();
  });

  it('says it is loading until the list arrives', () => {
    mockApi({ [DEAL_PATHS.documents]: ok(dealDocumentPageFixture()) });
    renderWithQuery(<DocumentsTab />);
    expect(screen.getByText('Loading documents')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('degrades a 403 to the role sentence inside the card', async () => {
    mockApi({ [DEAL_PATHS.documents]: failing(403, DEAL_PATHS.documents) });
    renderWithQuery(<DocumentsTab />);
    expect(await screen.findByTestId('deal-documents-unavailable')).toHaveTextContent(
      'Documents: not visible to your role',
    );
    expect(screen.queryByTestId('deal-documents-empty')).not.toBeInTheDocument();
  });

  it('degrades a 501 to the not-built sentence inside the card', async () => {
    mockApi({ [DEAL_PATHS.documents]: failing(501, DEAL_PATHS.documents) });
    renderWithQuery(<DocumentsTab />);
    expect(await screen.findByTestId('deal-documents-unavailable')).toHaveTextContent(
      'The document hub is not available in this build',
    );
  });

  it('shows any other failure as an error notice, after the one retry a server failure gets', async () => {
    mockApi({
      [DEAL_PATHS.documents]: {
        status: 500,
        body: { ...problemFixture(404, DEAL_PATHS.documents), status: 500, title: 'Server error' },
      },
    });
    renderWithQuery(<DocumentsTab />);
    expect(
      await screen.findByTestId('deal-documents-unavailable', {}, { timeout: 15_000 }),
    ).toHaveTextContent('Documents could not load');
    expect(screen.getByTestId('deal-documents')).toBeInTheDocument();
    expect(screen.queryByTestId('deal-documents-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  }, 20_000);

  it('renders a document the classifier linked without a run and without a type as it stands', async () => {
    mockApi({
      [DEAL_PATHS.documents]: ok(
        dealDocumentPageFixture([
          dealDocumentFixture({ docType: 'doc_type.capital_call', latestRun: null }),
        ]),
      ),
    });
    renderWithQuery(<DocumentsTab />);
    await screen.findByRole('table', { name: 'Documents' });
    const card = screen.getByTestId('deal-documents');
    expect(card).toHaveTextContent('1 document, newest first');
    expect(card).toHaveTextContent('Capital call');
    expect(within(card).queryByRole('link', { name: /Extraction/ })).toBeNull();
  });
});
