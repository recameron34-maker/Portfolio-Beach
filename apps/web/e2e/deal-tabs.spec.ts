import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loadDataset, signInAs, switchTo, walledDeal } from './fixtures.js';
import type { E2eDataset } from './fixtures.js';

/** The missing-value placeholder as config/brand.json sets it (docs/06 section 3), read like the app reads it. */
const MISSING: string = (
  JSON.parse(readFileSync(new URL('../../../config/brand.json', import.meta.url), 'utf8')) as {
    missingValue: string;
  }
).missingValue;

/** A read of the API as the signed-in user (the prototype credential the page holds in session storage). */
async function apiGet<T>(page: Page, path: string): Promise<T> {
  const credential = await page.evaluate(() => window.sessionStorage.getItem('pb.credential'));
  if (credential === null) throw new Error('no signed-in user');
  const res = await page.request.get(path, { headers: { authorization: `Bearer ${credential}` } });
  expect(res.ok(), `${path} answered ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

/** The quarter rows of the performance series as the Source column reads them. */
interface PerformanceRead {
  quarters: { periodEnd: string; source: { documentId: string; page: number | null } | null }[];
}
interface DocumentsRead {
  items: { id: string; title: string }[];
}
interface OutlookRead {
  outlook: string;
  horizonMonths: number;
  note: string | null;
  setBy: string | null;
}

/**
 * $M with one decimal and thousands separators (docs/06 section 3), written independently of
 * src/lib/format.ts so the journey also checks the app's formatter. Rounds half away from zero.
 */
function moneyM(value: string): string {
  const millions = Number(value) / 1_000_000;
  const [whole = '0', frac = '0'] = (Math.round(Math.abs(millions) * 10) / 10)
    .toFixed(1)
    .split('.');
  return `${millions < 0 ? '-' : ''}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}M`;
}

/**
 * Deal workspace tabs over the real endpoints (docs/12 section 3): a wall member opens the walled
 * position, reads its Performance tab and its Sponsor tab, and each shows a figure that matches
 * the seeded synthetic dataset.
 */
interface DealDataset extends E2eDataset {
  investments: (E2eDataset['investments'][number] & { sponsorId: string })[];
  sponsors: { id: string; name: string }[];
  quarterlyPerformance: {
    investmentId: string;
    periodEnd: string;
    isEntrySnapshot: boolean;
    revenueLtm: string | null;
  }[];
}

const d = loadDataset() as DealDataset;
const deal = walledDeal(d);
const investment = d.investments.find((i) => i.id === deal.id);
const sponsor = d.sponsors.find((s) => s.id === investment?.sponsorId);
const latestQuarter = d.quarterlyPerformance
  .filter((q) => q.investmentId === deal.id && !q.isEntrySnapshot)
  .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
// deal.three sits on the wall, so every position with the sponsor is visible to them.
const sponsorPositions = d.investments.filter((i) => i.sponsorId === sponsor?.id).length;

test('a wall member reads the performance and sponsor tabs of a position', async ({ page }) => {
  expect(sponsor, 'the walled position has a sponsor in the dataset').toBeDefined();
  expect(latestQuarter, 'the walled position has quarterly financials').toBeDefined();
  await signInAs(page, 'deal.three', d);
  await page.goto(`/portfolio/${deal.id}`);
  await expect(page.getByTestId('detail-banner')).toContainText(deal.companyName);
  const tabs = page.getByRole('navigation', { name: 'Deal workspace' });

  await tabs.getByRole('link', { name: 'Performance', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio/${deal.id}/performance$`));
  const quarters = page.getByRole('table', { name: 'Quarterly financials' });
  // Newest first: the first body row is the latest quarter, its LTM revenue as the API serves it.
  await expect(quarters.getByRole('row').nth(1)).toContainText(
    moneyM(latestQuarter?.revenueLtm ?? '0'),
  );
  // The banner is shared by every tab.
  await expect(page.getByTestId('detail-banner')).toContainText(deal.companyName);

  await tabs.getByRole('link', { name: 'Sponsor and contacts', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio/${deal.id}/sponsor$`));
  await expect(page.getByRole('link', { name: sponsor?.name ?? '', exact: true })).toHaveAttribute(
    'href',
    `/sponsors/${sponsor?.id ?? ''}`,
  );
  await expect(page.getByRole('group', { name: 'Positions' }).locator('.pb-stat-value')).toHaveText(
    String(sponsorPositions),
  );
});

/**
 * Phase 2 on the deal tabs (docs/04 M3, M9; docs/11 I1): the Source column names the document
 * page each quarter was read from or shows the missing placeholder; the Documents tab lists what
 * the hub has linked to the position, or says nothing is linked yet; the deal team sets the
 * realization outlook through the audited API write and the approver reads it.
 */
test('the Performance tab shows the source of each quarter, or the missing placeholder when the figures have no document', async ({
  page,
}) => {
  await signInAs(page, 'deal.three', d);
  await page.goto(`/portfolio/${deal.id}/performance`);
  await expect(page.getByTestId('detail-banner')).toContainText(deal.companyName);
  const table = page.getByRole('table', { name: 'Quarterly financials' });
  await expect(table).toHaveAttribute('data-testid', 'performance-sources');
  await expect(table.locator('thead th').filter({ hasText: /^Source$/ })).toHaveCount(1);

  // The same read the tab made: the synthetic seed carries no lineage, so every quarter shows the
  // placeholder; a quarter promoted from an extraction run (journey 2) links to its document page.
  const perf = await apiGet<PerformanceRead>(page, `/api/v1/investments/${deal.id}/performance`);
  expect(perf.quarters.length).toBeGreaterThan(0);
  for (const q of perf.quarters) {
    const source = page.getByTestId(`performance-source-${q.periodEnd}`);
    if (q.source === null) {
      await expect(source).toHaveText(MISSING);
      await expect(source.locator('xpath=..')).toHaveClass(/is-missing/);
    } else {
      await expect(source).toHaveAttribute('href', `/documents/${q.source.documentId}`);
      await expect(source).toContainText(
        q.source.page === null ? 'document' : `page ${q.source.page}`,
      );
    }
  }
  await expect(page.getByTestId('deal-quarterly')).toContainText(
    `a quarter with no source document shows ${MISSING}`,
  );
});

test('the Documents tab lists the documents linked to the position, or says none are linked yet', async ({
  page,
}) => {
  await signInAs(page, 'deal.three', d);
  await page.goto(`/portfolio/${deal.id}`);
  await expect(page.getByTestId('detail-banner')).toContainText(deal.companyName);
  await page
    .getByRole('navigation', { name: 'Deal workspace' })
    .getByRole('link', { name: 'Documents', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/portfolio/${deal.id}/documents$`));
  const card = page.getByTestId('deal-documents');
  await expect(card.getByRole('heading', { level: 2 })).toContainText('Documents');

  // The same read the tab made: no document until operations indexes the store (another journey
  // may have done so first), so the tab either says so or lists each document with its link.
  const listed = await apiGet<DocumentsRead>(
    page,
    `/api/v1/documents?limit=200&investmentId=${deal.id}`,
  );
  if (listed.items.length === 0) {
    await expect(card.getByTestId('deal-documents-empty')).toContainText(
      'No documents for this position',
    );
    await expect(card).toContainText('0 documents, newest first');
    await expect(card.getByRole('table')).toHaveCount(0);
  } else {
    const table = card.getByRole('table', { name: 'Documents' });
    await expect(table.getByRole('row')).toHaveCount(listed.items.length + 1);
    for (const doc of listed.items.slice(0, 3)) {
      await expect(table.getByRole('link', { name: doc.title, exact: true })).toHaveAttribute(
        'href',
        `/documents/${doc.id}`,
      );
    }
    await expect(card).toContainText(`${listed.items.length} document`);
  }
  await expect(card.getByRole('link', { name: 'Open the document hub' })).toHaveAttribute(
    'href',
    '/documents',
  );
  // The tab is part of the workspace: the banner stays, and the placeholder page is gone.
  await expect(page.getByTestId('detail-banner')).toContainText(deal.companyName);
  await expect(page.getByText('Documents arrives in Phase 2')).toHaveCount(0);
});

test('the deal team sets the realization outlook with a reason; the approver reads it', async ({
  page,
}) => {
  const editor = d.users.find((u) => u.externalId === 'deal.three');
  expect(editor, 'deal.three is in the dataset').toBeDefined();
  await signInAs(page, 'deal.three', d);
  await page.goto(`/portfolio/${deal.id}/performance`);
  const card = page.getByTestId('outlook-card');
  const form = card.getByTestId('outlook-form');
  await expect(form).toBeVisible();
  await expect(card.getByTestId('outlook-read-only')).toHaveCount(0);

  await form.getByRole('combobox', { name: 'Outlook' }).click();
  await page.getByRole('option', { name: 'Full' }).click();
  await form.getByLabel('Horizon (months)').fill('24');
  await form.getByLabel('Note').fill('Sponsor has launched a sale process.');
  await form.getByLabel('Reason').fill('Sale process announced at the quarterly call');
  await form.getByRole('button', { name: 'Set outlook' }).click();
  await expect(card.getByTestId('outlook-action-status')).toContainText(
    'Outlook set to Full (audited)',
  );
  const kv = card.getByRole('table', { name: 'Realization outlook' });
  await expect(kv).toContainText('Full');
  await expect(kv).toContainText('Within 24 months');
  await expect(kv).toContainText('Sponsor has launched a sale process.');
  await expect(kv).toContainText(editor?.displayName ?? '');
  // The reason is for one edit only.
  await expect(form.getByLabel('Reason')).toHaveValue('');

  // The API holds what the card shows.
  const stored = await apiGet<OutlookRead>(page, `/api/v1/monitoring/outlook/${deal.id}`);
  expect(stored.outlook).toBe('full');
  expect(stored.horizonMonths).toBe(24);
  expect(stored.note).toBe('Sponsor has launched a sale process.');
  expect(stored.setBy).toBe(editor?.displayName);

  // The approver on the wall reads the outlook the deal team set, with no form to edit it.
  await switchTo(page, 'head.one', d);
  await page.goto(`/portfolio/${deal.id}/performance`);
  const readOnly = page.getByTestId('outlook-card');
  await expect(readOnly.getByTestId('outlook-read-only')).toHaveText(
    'The deal team sets the outlook; your role reads it.',
  );
  await expect(readOnly.getByTestId('outlook-form')).toHaveCount(0);
  await expect(readOnly.getByRole('button', { name: 'Set outlook' })).toHaveCount(0);
  await expect(readOnly.getByRole('table', { name: 'Realization outlook' })).toContainText('Full');
  await expect(readOnly.getByRole('table', { name: 'Realization outlook' })).toContainText(
    'Within 24 months',
  );
});
