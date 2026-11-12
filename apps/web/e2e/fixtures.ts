import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  documentIndexResult,
  expectedDocumentGenerateResult,
  extractionBatch,
  extractionRunDetail,
  extractionRunPage,
  featureFlag,
  featureFlagList,
} from '@pb/contracts';
import type {
  DocumentIndexResult,
  ExpectedDocumentGenerateResult,
  ExtractionBatch,
  ExtractionBatchBody,
  ExtractionRun,
  ExtractionRunDetail,
} from '@pb/contracts';
import { generateDataset } from '@pb/synthetic';
import type { z } from 'zod';

export interface E2eDataset {
  asOf: string;
  users: { externalId: string; displayName: string; roles: string[] }[];
  investments: {
    id: string;
    investmentNumber: string;
    portfolioCompanyId: string;
    isActive: boolean;
  }[];
  portfolioCompanies: { id: string; name: string }[];
  scenarios: Record<string, string[]>;
}

/** The same deterministic dataset scripts/e2e-api.mjs seeds (small profile, seed 42). */
export function loadDataset(): E2eDataset {
  return generateDataset({ profile: 'small', seed: 42 });
}

export function walledDeal(d: E2eDataset): { id: string; companyName: string } {
  const id = d.scenarios.walled_deal?.[0];
  if (id === undefined) throw new Error('dataset has no walled deal');
  const inv = d.investments.find((i) => i.id === id);
  const company = d.portfolioCompanies.find((c) => c.id === inv?.portfolioCompanyId);
  return { id, companyName: company?.name ?? '' };
}

/** Signs in through the prototype picker. */
export async function signInAs(page: Page, externalId: string, d: E2eDataset): Promise<void> {
  const user = d.users.find((u) => u.externalId === externalId);
  if (!user) throw new Error(`no user ${externalId}`);
  await page.goto('/sign-in');
  await page.getByRole('button', { name: new RegExp(user.displayName) }).click();
  await page.getByTestId('current-user').waitFor();
}

/** Switches the acting user through the shell's role switcher (the prototype's sign-in). */
export async function switchTo(page: Page, externalId: string, d: E2eDataset): Promise<void> {
  const user = d.users.find((u) => u.externalId === externalId);
  if (!user) throw new Error(`no user ${externalId}`);
  await page.getByTestId('role-switcher').click();
  await page.getByRole('option', { name: new RegExp(user.displayName) }).click();
  await expect(page.getByTestId('current-user')).toHaveText(user.displayName);
}

/* ---- Document hub and extraction, through the API (shared by journey 2, the monitoring spec and the accessibility scan) ---- */

/** The latest quarter end on or before the dataset's as-of date: the quarter the synthetic reports cover. */
export function latestQuarter(d: E2eDataset): string {
  return latestQuarterEndOnOrBefore(d.asOf);
}

/** The mock credential the e2e API accepts: the user's external id as a bearer token (as the API harness does). */
function bearer(externalId: string): Record<string, string> {
  return { authorization: `Bearer ${externalId}`, accept: 'application/json' };
}

/**
 * Calls the API through the page's own request context (the Vite dev server proxies /api to the
 * e2e API) and parses the answer with its contract, so a shape drift fails here, not in a page.
 */
export async function apiCall<T>(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  who: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const res = await page.request.fetch(path, {
    method,
    headers: bearer(who),
    ...(body === undefined ? {} : { data: body }),
  });
  if (!res.ok())
    throw new Error(`${method} ${path} as ${who}: ${res.status()} ${await res.text()}`);
  return schema.parse(await res.json());
}

/** POST /documents/index as operations: the store's inbox into the hub (idempotent: a second call answers unchanged). */
export function indexDocuments(page: Page, who = 'ops.one'): Promise<DocumentIndexResult> {
  return apiCall(page, 'POST', '/api/v1/documents/index', who, documentIndexResult);
}

/** POST /expected-documents/generate as operations for a quarter end (idempotent: existing rows are counted). */
export function generateExpectedDocuments(
  page: Page,
  periodEnd: string,
  who = 'ops.one',
): Promise<ExpectedDocumentGenerateResult> {
  return apiCall(
    page,
    'POST',
    '/api/v1/expected-documents/generate',
    who,
    expectedDocumentGenerateResult,
    { periodEnd },
  );
}

/**
 * The extraction kill switch is off by default; scripts/e2e-api.mjs turns it on at start-up, and
 * a journey that needs it checks and, when off, turns it on the same way: through the flags
 * endpoint as a platform admin, audited.
 */
export async function ensureExtractionOn(page: Page, d: E2eDataset): Promise<void> {
  const admin = d.users.find((u) => u.roles.includes('platform_admin'));
  if (admin === undefined) throw new Error('dataset has no platform admin');
  const flags = await apiCall(page, 'GET', '/api/v1/flags', admin.externalId, featureFlagList);
  if (flags.flags.some((f) => f.key === 'ai.extraction' && f.enabled)) return;
  await apiCall(page, 'PATCH', '/api/v1/flags/ai.extraction', admin.externalId, featureFlag, {
    enabled: true,
    reason: 'enabled by the journey',
  });
}

/** POST /extraction/batches as operations; the API processes every run before it answers. */
export function startExtractionBatch(
  page: Page,
  body: ExtractionBatchBody,
  who = 'ops.one',
): Promise<ExtractionBatch> {
  return apiCall(page, 'POST', '/api/v1/extraction/batches', who, extractionBatch, body);
}

/** GET /extraction/runs newest first (`query` as "&state=Succeeded" or "&batchId=..."), as the caller sees them. */
export async function listRuns(page: Page, query = '', who = 'ops.one'): Promise<ExtractionRun[]> {
  const runs = await apiCall(
    page,
    'GET',
    `/api/v1/extraction/runs?limit=200${query}`,
    who,
    extractionRunPage,
  );
  return runs.items;
}

/** GET /extraction/runs/{id}: the run with its values, narrative and page layouts. */
export function runDetail(page: Page, id: string, who = 'ops.one'): Promise<ExtractionRunDetail> {
  return apiCall(page, 'GET', `/api/v1/extraction/runs/${id}`, who, extractionRunDetail);
}
