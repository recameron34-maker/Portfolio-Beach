import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DocumentDetail } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { ID, investmentFixture, investmentPageFixture } from '../../test/fixtures.js';
import {
  POSITION_ID,
  rolePrincipal,
  sentPosts,
  sentRequests,
} from '../../test/fixtures-valuations.js';
import {
  sponsorDetailFixture,
  sponsorPageFixture,
  VS_ID,
} from '../../test/fixtures-vehicles-sponsors.js';
import { renderWithQuery } from '../../test/render.js';
import { DocumentDetailPage } from './DocumentDetail.js';
import {
  classifiedScanFixture,
  CONTENT_HASH,
  DOC_ID,
  docTypeTaxonomyFixture,
  documentDetailFixture,
  documentPagesFixture,
  REPORT_FILE,
  REPORT_TITLE,
  RUN_ID_FIXTURE,
  scanDetailFixture,
} from './fixtures.js';

const route = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: route.id }),
}));

const ME = '/api/v1/auth/me';
const TAXONOMY = '/api/v1/taxonomy';
const INVESTMENTS = '/api/v1/investments';
const SPONSORS = '/api/v1/sponsors';
const detailPath = (id: string): string => `/api/v1/documents/${id}`;
const pagesPath = (id: string): string => `${detailPath(id)}/pages`;
const commandsPath = (id: string): string => `${detailPath(id)}/commands`;
/** Dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  doc: DocumentDetail = documentDetailFixture(),
  overrides: MockRoutes = {},
): MockRoutes {
  route.id = doc.id;
  return {
    [ME]: ok(rolePrincipal(roles)),
    [TAXONOMY]: ok(docTypeTaxonomyFixture()),
    [INVESTMENTS]: ok(
      investmentPageFixture([
        investmentFixture({
          id: POSITION_ID.silverline,
          investmentNumber: 'INV-0004',
          companyName: 'Silverline Staffing Holdings',
        }),
        investmentFixture(),
      ]),
    ),
    [SPONSORS]: ok(sponsorPageFixture()),
    [`${SPONSORS}/${ID.sponsor1}`]: ok(sponsorDetailFixture()),
    [detailPath(doc.id)]: ok(doc),
    [pagesPath(doc.id)]: ok(documentPagesFixture({ documentId: doc.id })),
    ...overrides,
  };
}

/** The detail as the API serves it after a command: the answer to the POST, and to the refetch that follows it. */
function afterCommand(before: DocumentDetail, after: DocumentDetail): MockRoutes {
  return {
    [detailPath(before.id)]: () => ok(sentPosts().length > 0 ? after : before),
    [commandsPath(before.id)]: ok(after),
  };
}

const banner = (): HTMLElement => screen.getByTestId('document-banner');
const status = (): HTMLElement => screen.getByTestId('document-action-status');
const metadata = (): HTMLElement => screen.getByRole('table', { name: 'Document metadata' });
const value = (label: string): HTMLElement =>
  within(metadata()).getByRole('rowheader', { name: label }).nextElementSibling as HTMLElement;

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('a document', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the banner, the links, the metadata, the duplicates and the latest run', async () => {
    mockApi(routes());
    renderWithQuery(<DocumentDetailPage />);
    await screen.findByTestId('document-banner');
    expect(within(banner()).getByRole('heading', { level: 1 })).toHaveTextContent(REPORT_TITLE);
    expect(banner()).toHaveTextContent(REPORT_FILE);
    expect(banner()).toHaveTextContent('Jun 30, 2025');
    expect(banner()).toHaveTextContent('Received Jul 1, 2025');
    expect(within(banner()).getByRole('link', { name: 'Meridian Data Partners' })).toHaveAttribute(
      'href',
      `/portfolio/${POSITION_ID.meridian}`,
    );
    expect(within(banner()).getByText('INV-0001')).toHaveClass('pb-key');
    expect(within(banner()).getByRole('link', { name: 'Kelpwood Fund IV' })).toHaveAttribute(
      'href',
      `/sponsors/${ID.sponsor1}`,
    );
    expect(within(banner()).getByText('Quarterly financials')).toHaveClass('pb-badge-plain');
    expect(within(banner()).getByText('Classified')).toHaveClass('pb-badge-good');
    expect(screen.getByRole('link', { name: 'All documents' })).toHaveAttribute(
      'href',
      '/documents',
    );
    expect(status()).toBeEmptyDOMElement();

    expect(screen.getByTestId('document-detail')).toContainElement(metadata());
    expect(value('File name')).toHaveTextContent(REPORT_FILE);
    expect(value('Folder')).toHaveTextContent('inbox');
    expect(value('Content hash')).toHaveTextContent('a3f1c9d2e4b5');
    expect(within(value('Content hash')).getByTitle(CONTENT_HASH)).toBeInTheDocument();
    expect(value('Size')).toHaveTextContent('9.8 KB');
    expect(value('Pages')).toHaveTextContent('4');
    expect(value('Received')).toHaveTextContent('Jul 1, 2025');
    expect(value('Indexed')).toHaveTextContent('Jul 1, 2025');
    expect(value('Confidence')).toHaveTextContent('97%');
    expect(value('Evidence keywords')).toHaveTextContent('quarterly report, period end');
    expect(value('Candidates')).toHaveTextContent('-');
    expect(value('Classified by')).toHaveTextContent('the classifier, Jul 1, 2025');
    expect(value('Confidentiality')).toHaveTextContent('confidential');
    expect(within(value('Latest run')).getByRole('link', { name: 'Succeeded' })).toHaveAttribute(
      'href',
      `/documents/extraction/${RUN_ID_FIXTURE}`,
    );

    const duplicates = screen.getByRole('list', { name: 'Duplicates' });
    expect(screen.getByTestId('document-duplicates')).toHaveTextContent('1 copy');
    expect(
      within(duplicates).getByRole('link', { name: `${REPORT_FILE.slice(0, -4)} (1).pdf` }),
    ).toHaveAttribute('href', `/documents/${DOC_ID.copy}`);
    expect(within(duplicates).getByText('Duplicate')).toHaveClass('pb-badge-neutral');

    // A classified document offers no classify form and needs no read-only sentence.
    expect(screen.queryByTestId('document-classify')).not.toBeInTheDocument();
    expect(screen.queryByTestId('document-read-only')).not.toBeInTheDocument();
    expect(sentRequests().map(([url]) => url)).not.toContain(SPONSORS);
  });

  it('shows the pages one at a time, the selected page as lines', TIMEOUT, async () => {
    mockApi(routes());
    renderWithQuery(<DocumentDetailPage />);
    const pages = await screen.findByTestId('document-pages');
    expect(pages).toHaveTextContent('4 pages');
    const text = await within(pages).findByTestId('document-page-text');
    expect(text).toHaveTextContent('Quarterly Report');
    expect(text).toHaveTextContent('Prepared for Beach Co-Invest Fund I, reference INV-0001');
    expect(text).toHaveAttribute('aria-label', 'Text of page 1');
    expect(within(pages).getByText('6 lines')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Page' })).toHaveTextContent('Page 1 of 4');
    await pick('Page', 'Page 2');
    expect(within(pages).getByTestId('document-page-text')).toHaveTextContent('LTM revenue 125.40');
    expect(within(pages).getByTestId('document-page-text')).toHaveAttribute(
      'aria-label',
      'Text of page 2',
    );
    expect(within(pages).getByText('3 lines')).toBeInTheDocument();
  });

  it('says so when the reader refuses the file, without failing the page', async () => {
    const doc = documentDetailFixture();
    mockApi(
      routes(['operations'], doc, {
        [pagesPath(doc.id)]: {
          status: 422,
          body: {
            type: 'https://portfolio-beach.example/problems/unreadable-document',
            title: 'Unprocessable',
            status: 422,
            detail: 'unreadable document (encrypted): the file is encrypted',
            instance: pagesPath(doc.id),
            request_id: 'test',
          },
        },
      }),
    );
    renderWithQuery(<DocumentDetailPage />);
    await screen.findByTestId('document-banner');
    expect(await screen.findByTestId('document-pages-unavailable')).toHaveTextContent(
      "The document's text could not load: unreadable document (encrypted): the file is encrypted",
    );
    expect(metadata()).toBeInTheDocument();
  });

  it(
    'lets operations classify a document waiting for review, and says what it became',
    TIMEOUT,
    async () => {
      const scan = scanDetailFixture();
      mockApi(routes(['operations'], scan, afterCommand(scan, classifiedScanFixture())));
      renderWithQuery(<DocumentDetailPage />);
      await screen.findByTestId('document-banner');
      expect(within(banner()).getByText('Needs review')).toHaveClass('pb-badge-watch');
      expect(within(banner()).getAllByText('-').length).toBeGreaterThan(0);
      expect(value('Candidates')).toHaveTextContent('suggested doc_type.other below the threshold');
      expect(value('Classified by')).toHaveTextContent('-');
      expect(screen.queryByTestId('document-duplicates')).not.toBeInTheDocument();

      const form = screen.getByTestId('document-classify');
      const classify = within(form).getByRole('button', { name: 'Classify' });
      expect(classify).toHaveAttribute('aria-disabled', 'true');
      expect(classify).toHaveAttribute('title', 'Pick a document type.');
      await pick('Document type', 'Quarterly financials');
      expect(classify).not.toHaveAttribute('aria-disabled', 'true');
      await pick('Investment', 'INV-0001 Meridian Data Partners');
      // The fund is picked through its sponsor; until then the fund list waits.
      expect(screen.getByRole('combobox', { name: 'Sponsor fund' })).toBeDisabled();
      await pick('Sponsor', 'Kelpwood Capital Partners');
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Sponsor fund' })).toBeEnabled(),
      );
      await pick('Sponsor fund', 'Kelpwood Fund I');
      await userEvent.type(screen.getByLabelText('Period end'), '2025-06-30');
      await userEvent.type(screen.getByLabelText('Reason'), 'The letterhead names the company');
      await userEvent.click(classify);

      expect(
        await screen.findByText('Classified as Quarterly financials (audited)', {}, TIMEOUT),
      ).toBeInTheDocument();
      expect(status()).toHaveTextContent('Classified as Quarterly financials');
      expect(sentPosts()).toEqual([
        [
          commandsPath(scan.id),
          {
            command: 'classify',
            docType: 'doc_type.quarterly_financials',
            investmentId: POSITION_ID.meridian,
            sponsorFundId: VS_ID.fundOne,
            periodEnd: '2025-06-30',
            reason: 'The letterhead names the company',
          },
        ],
      ]);
      // The document now reads as classified and linked; the form is gone, the status stays.
      await waitFor(() =>
        expect(within(banner()).getByText('Classified')).toHaveClass('pb-badge-good'),
      );
      expect(
        within(banner()).getByRole('link', { name: 'Meridian Data Partners' }),
      ).toHaveAttribute('href', `/portfolio/${POSITION_ID.meridian}`);
      expect(screen.queryByTestId('document-classify')).not.toBeInTheDocument();
      expect(value('Classified by')).toHaveTextContent('Avery Castellanos, Jul 2, 2025');
      expect(status()).toHaveTextContent('Classified as Quarterly financials');
    },
  );

  it('sends the type alone when the links and the reason are left blank', TIMEOUT, async () => {
    const scan = scanDetailFixture();
    mockApi(routes(['deal_team'], scan, afterCommand(scan, classifiedScanFixture())));
    renderWithQuery(<DocumentDetailPage />);
    await screen.findByTestId('document-classify');
    await pick('Document type', 'Other');
    await userEvent.click(screen.getByRole('button', { name: 'Classify' }));
    await screen.findByText('Classified as Quarterly financials (audited)', {}, TIMEOUT);
    expect(sentPosts()).toEqual([
      [commandsPath(scan.id), { command: 'classify', docType: 'doc_type.other' }],
    ]);
  });

  it('says why a classification was refused', TIMEOUT, async () => {
    const scan = scanDetailFixture();
    mockApi(
      routes(['operations'], scan, {
        [commandsPath(scan.id)]: {
          status: 409,
          body: {
            type: 'https://portfolio-beach.example/problems/workflow-transition',
            title: 'Conflict',
            status: 409,
            detail: 'document: classify is not allowed from Classified',
            instance: commandsPath(scan.id),
            request_id: 'test',
          },
        },
      }),
    );
    renderWithQuery(<DocumentDetailPage />);
    await screen.findByTestId('document-classify');
    await pick('Document type', 'Other');
    await userEvent.click(screen.getByRole('button', { name: 'Classify' }));
    expect(
      await screen.findByText(
        'Classify: Not allowed from the current state. Classify is not allowed from Classified',
        {},
        TIMEOUT,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('document-classify')).toBeInTheDocument();
  });

  it('tells a viewer who classifies, with no form', async () => {
    mockApi(routes(['viewer'], scanDetailFixture()));
    renderWithQuery(<DocumentDetailPage />);
    await screen.findByTestId('document-banner');
    expect(screen.queryByTestId('document-classify')).not.toBeInTheDocument();
    expect(screen.getByTestId('document-read-only')).toHaveTextContent(
      'The deal team and operations classify documents; your role reads them.',
    );
    expect(sentRequests().map(([url]) => url)).not.toContain(SPONSORS);
  });

  it('says when the document is not found or not visible', async () => {
    const doc = documentDetailFixture();
    mockApi(routes(['viewer'], doc, { [detailPath(doc.id)]: failing(404, detailPath(doc.id)) }));
    renderWithQuery(<DocumentDetailPage />);
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(await screen.findByText('Document not found or not visible to you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All documents' })).toBeInTheDocument();
  });

  it('shows any other failure as an error', TIMEOUT, async () => {
    const doc = documentDetailFixture();
    mockApi(routes(['viewer'], doc, { [detailPath(doc.id)]: { status: 500, body: {} } }));
    renderWithQuery(<DocumentDetailPage />);
    expect(await screen.findByText('Document unavailable', {}, TIMEOUT)).toBeInTheDocument();
  });
});
