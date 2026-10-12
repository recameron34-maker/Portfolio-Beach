import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, ok } from '../../test/api-mock.js';
import {
  FILE_ID,
  intakeExportListFixture,
  intakeFilePageFixture,
  intakeImportResultFixture,
} from '../../test/fixtures-intake.js';
import { rolePrincipal, sentPosts } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { navigate } from '../../test/router-mock.js';
import { IntakePage } from './Intake.js';

vi.mock('../../app/env.js', () => ({ previewMode: true }));
vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const IMPORT = '/api/v1/intake/accounting';
const SAMPLE =
  'InvestmentNumber,CompanyName,PeriodEnd\nINV-0001,Meridian Data Partners,2025-06-30\n';

/** The sample CSV files are static assets beside the preview, not API routes: fetch answers them as text. */
function serveSamples(available: boolean): void {
  const api = vi.mocked(globalThis.fetch).getMockImplementation();
  if (api === undefined) throw new Error('mockApi first');
  vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('preview/samples/')) return api(input, init);
    return Promise.resolve(
      available
        ? new Response(SAMPLE, { status: 200, headers: { 'content-type': 'text/csv' } })
        : new Response('', { status: 404 }),
    );
  });
}

describe('intake list (preview)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigate.mockReset();
  });

  it('offers the three sample exports and stages one as text', async () => {
    mockApi({
      '/api/v1/auth/me': ok(rolePrincipal(['operations'])),
      '/api/v1/intake/files?limit=200': ok(intakeFilePageFixture()),
      '/api/v1/intake/accounting/exports': ok(intakeExportListFixture([])),
      [IMPORT]: ok(intakeImportResultFixture()),
    });
    serveSamples(true);
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    for (const scenario of ['clean', 'update', 'defects']) {
      expect(screen.getByTestId(`intake-sample-${scenario}`)).toHaveTextContent(
        `Stage the ${scenario} sample`,
      );
    }
    expect(screen.getAllByText('Simulated').length).toBeGreaterThanOrEqual(1);
    await userEvent.click(screen.getByTestId('intake-sample-update'));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(sentPosts()).toEqual([[IMPORT, { fileName: 'accounting-update.csv', csv: SAMPLE }]]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/data/intake/$id',
      params: { id: FILE_ID.update },
      search: {},
    });
  });

  it('says plainly when a sample cannot be loaded', async () => {
    mockApi({
      '/api/v1/auth/me': ok(rolePrincipal(['operations'])),
      '/api/v1/intake/files?limit=200': ok(intakeFilePageFixture()),
      '/api/v1/intake/accounting/exports': ok(intakeExportListFixture([])),
    });
    serveSamples(false);
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    await userEvent.click(screen.getByTestId('intake-sample-defects'));
    expect(await screen.findByText('The defects sample could not be loaded.')).toBeInTheDocument();
    expect(sentPosts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });
});
