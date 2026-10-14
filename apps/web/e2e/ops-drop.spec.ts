import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { generateDataset, opsDropWorkbook } from '@pb/synthetic';
import type { OpsDropWorkbook } from '@pb/synthetic';
import { loadDataset, signInAs } from './fixtures.js';

/**
 * The operations workbook drop (docs/04 M2 ops-drop-import, SEC-9.1) over the real API: operations
 * uploads the synthetic "clean" workbook, built in the test from the same dataset the API is seeded
 * with (small profile, seed 42), sees it matched to the quarterly-figures template and staged like
 * an accounting export, approves the rows it may see, then uploads the unknown-template workbook
 * and reads the refusal naming the templates the drop knows. Bytes travel as base64; the API reads
 * the workbook, never the browser.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const clean = opsDropWorkbook(full, { scenario: 'clean' });
const unknown = opsDropWorkbook(full, { scenario: 'unknown-template' });
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function uploadWorkbook(page: Page, file: OpsDropWorkbook): Promise<void> {
  await page.getByLabel('Operations workbook (XLSX)').setInputFiles({
    name: file.fileName,
    mimeType: XLSX_MIME,
    buffer: Buffer.from(file.bytes),
  });
  await page.getByRole('button', { name: 'Stage workbook' }).click();
  await expect(page).toHaveURL(/\/data\/intake\/[0-9a-f-]{36}$/);
}

const hidden = clean.expectations.walled.length;
const hiddenNote = `${hidden} row${hidden === 1 ? ' is' : 's are'} linked to positions you cannot see`;

test('operations stages the clean workbook by its template, approves what it may see, and reads the refusal of an unknown template', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signInAs(page, 'ops.one', d);
  await page.goto('/data/intake');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Intake');
  await expect(page.getByTestId('intake-upload')).toBeVisible();

  await uploadWorkbook(page, clean);
  const banner = page.getByTestId('intake-banner');
  await expect(banner).toContainText(clean.fileName);
  await expect(banner).toContainText('Ops drop');
  await expect(banner).toContainText('Template: quarterly-figures');
  await expect(page.getByTestId('intake-duplicate')).toHaveCount(0);
  await expect(page.getByTestId('intake-file-findings')).toHaveCount(0);
  const tiles = page.getByTestId('intake-tiles');
  await expect(tiles.getByRole('group', { name: 'Rows' })).toContainText(
    String(clean.expectations.rows),
  );
  await expect(tiles.getByRole('group', { name: 'Flagged' })).toContainText('0');
  await expect(tiles.getByRole('group', { name: 'Exceptions' })).toContainText('0');
  // The walled position's row linked all the same but sits past ops.one's wall (SEC-5.3).
  await expect(page.getByText(hiddenNote)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Staged rows' })).toBeVisible();

  // Approval goes through the same intake commands as an accounting export.
  await page.getByRole('button', { name: 'Approve validated rows' }).click();
  await expect(page.getByTestId('intake-action-status')).toContainText('rows promoted');
  await expect(tiles.getByRole('group', { name: 'Promoted' })).toContainText(
    String(clean.expectations.rows - hidden),
  );
  await expect(tiles.getByRole('group', { name: 'Validated' })).toContainText(String(hidden));

  // The list names the source and the template beside the file.
  await page.goto('/data/intake');
  const files = page.getByRole('table', { name: 'Intake files' });
  const staged = files.getByRole('row').filter({ hasText: clean.fileName });
  await expect(staged).toContainText('Ops drop');
  await expect(staged).toContainText('Template: quarterly-figures');

  // A workbook that matches no template is refused and stages nothing; the finding names the
  // templates the drop knows, so a person can see what the workbook should have looked like.
  await uploadWorkbook(page, unknown);
  await expect(page.getByTestId('intake-banner')).toContainText(unknown.fileName);
  await expect(page.getByTestId('intake-banner')).toContainText('Template: none matched');
  const findings = page.getByRole('list', { name: 'File findings' });
  await expect(findings).toContainText('LAYOUT-05');
  await expect(findings).toContainText('No template matches this workbook');
  await expect(findings).toContainText('Expected quarterly-figures');
  await expect(findings).toContainText('sheets: Figures, Notes');
  await expect(page.getByTestId('intake-no-rows')).toContainText('No rows were staged');
  await expect(page.getByTestId('intake-tiles').getByRole('group', { name: 'Rows' })).toContainText(
    '0',
  );
  await expect(page.getByRole('button', { name: 'Approve validated rows' })).toBeDisabled();
});
