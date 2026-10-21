import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  analyticsSummary,
  auditPage,
  capitalNoticeDetail,
  capitalNoticePage,
  clientList,
  commitmentList,
  dataDictionary,
  dataHealth,
  documentDetail,
  documentPage,
  documentPages,
  expectedDocumentPage,
  featureFlagList,
  healthReady,
  intakeExportList,
  intakeFileDetail,
  intakeFilePage,
  investmentDetail,
  investmentPage,
  investmentPerformance,
  mockUserList,
  principal,
  realizationOutlookDetail,
  sponsorDetail,
  sponsorPage,
  taxonomy,
  valuationPage,
  vehicleDetail,
  vehicleList,
  wallList,
  watchlist,
  weeklyReport,
} from '@pb/contracts';
import type { DocumentReviewStatus, ExpectedDocumentStatus } from '@pb/contracts';
import { api } from '../api/client.js';
import { retryUnlessUnavailable } from '../lib/unavailable.js';

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => api('/api/v1/auth/me', principal),
  retry: false,
  staleTime: 60_000,
});
export const mockUsersQuery = queryOptions({
  queryKey: ['mock-users'],
  queryFn: () => api('/api/v1/auth/mock-users', mockUserList),
  staleTime: Infinity,
});
export const vehiclesQuery = queryOptions({
  queryKey: ['vehicles'],
  queryFn: () => api('/api/v1/vehicles', vehicleList),
});
export const flagsQuery = queryOptions({
  queryKey: ['flags'],
  queryFn: () => api('/api/v1/flags', featureFlagList),
});
export const dataHealthQuery = queryOptions({
  queryKey: ['data-health'],
  queryFn: () => api('/api/v1/data-health', dataHealth),
});
export const dataDictionaryQuery = queryOptions({
  queryKey: ['data-dictionary'],
  queryFn: () => api('/api/v1/data-dictionary', dataDictionary),
});

export interface InvestmentFilters {
  dealType?: string | undefined;
  active?: 'true' | 'false' | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export function investmentsQuery(filters: InvestmentFilters) {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? 100));
  if (filters.dealType) params.set('dealType', filters.dealType);
  if (filters.active) params.set('active', filters.active);
  if (filters.cursor) params.set('cursor', filters.cursor);
  return queryOptions({
    queryKey: ['investments', filters],
    queryFn: () => api(`/api/v1/investments?${params.toString()}`, investmentPage),
  });
}

export function investmentQuery(id: string) {
  return queryOptions({
    queryKey: ['investment', id],
    queryFn: () => api(`/api/v1/investments/${encodeURIComponent(id)}`, investmentDetail),
    retry: false,
  });
}

/* Every query below sends a fixed, sorted set of parameters; scripts/preview-plan.mjs records exactly these keys. */

export const LIST_LIMIT = 200;

/**
 * The API writes an audit row for every read of a position's performance, a sponsor and a vehicle
 * (SEC-11.1), and the deal tabs ask for them again on each tab visit. They stay fresh for a minute,
 * so a tab switch within it reads the cache instead of writing another audit row.
 */
const AUDITED_READ_STALE_MS = 60_000;

export function investmentPerformanceQuery(id: string) {
  return queryOptions({
    queryKey: ['investment-performance', id],
    queryFn: () =>
      api(`/api/v1/investments/${encodeURIComponent(id)}/performance`, investmentPerformance),
    retry: false,
    staleTime: AUDITED_READ_STALE_MS,
  });
}

export const analyticsQuery = queryOptions({
  queryKey: ['analytics-summary'],
  queryFn: () => api('/api/v1/analytics/summary', analyticsSummary),
});
export const watchlistQuery = queryOptions({
  queryKey: ['watchlist'],
  queryFn: () => api('/api/v1/monitoring/watchlist', watchlist),
});
export const weeklyReportQuery = queryOptions({
  queryKey: ['weekly-report'],
  queryFn: () => api('/api/v1/reports/weekly', weeklyReport),
});
export const commitmentsQuery = queryOptions({
  queryKey: ['commitments'],
  queryFn: () => api('/api/v1/commitments', commitmentList),
});
export const clientsQuery = queryOptions({
  queryKey: ['clients'],
  queryFn: () => api('/api/v1/clients', clientList),
});
export const sponsorsQuery = queryOptions({
  queryKey: ['sponsors'],
  queryFn: () => api(`/api/v1/sponsors?limit=${LIST_LIMIT}`, sponsorPage),
});
export function sponsorQuery(id: string) {
  return queryOptions({
    queryKey: ['sponsor', id],
    queryFn: () => api(`/api/v1/sponsors/${encodeURIComponent(id)}`, sponsorDetail),
    retry: false,
    staleTime: AUDITED_READ_STALE_MS,
  });
}
export function vehicleQuery(id: string) {
  return queryOptions({
    queryKey: ['vehicle', id],
    queryFn: () => api(`/api/v1/vehicles/${encodeURIComponent(id)}`, vehicleDetail),
    retry: false,
    staleTime: AUDITED_READ_STALE_MS,
  });
}

export interface ValuationFilters {
  periodEnd?: string | undefined;
  state?: string | undefined;
  investmentId?: string | undefined;
  vehicleId?: string | undefined;
}
export function valuationsQuery(filters: ValuationFilters = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(LIST_LIMIT));
  if (filters.periodEnd) params.set('periodEnd', filters.periodEnd);
  if (filters.state) params.set('state', filters.state);
  if (filters.investmentId) params.set('investmentId', filters.investmentId);
  if (filters.vehicleId) params.set('vehicleId', filters.vehicleId);
  return queryOptions({
    queryKey: ['valuations', filters],
    queryFn: () => api(`/api/v1/valuations?${params.toString()}`, valuationPage),
    retry: retryUnlessUnavailable,
  });
}

export interface CapitalNoticeFilters {
  state?: string | undefined;
  vehicleId?: string | undefined;
  investmentId?: string | undefined;
  noticeType?: string | undefined;
}
export function capitalNoticesQuery(filters: CapitalNoticeFilters = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(LIST_LIMIT));
  if (filters.state) params.set('state', filters.state);
  if (filters.vehicleId) params.set('vehicleId', filters.vehicleId);
  if (filters.investmentId) params.set('investmentId', filters.investmentId);
  if (filters.noticeType) params.set('noticeType', filters.noticeType);
  return queryOptions({
    queryKey: ['capital-notices', filters],
    queryFn: () => api(`/api/v1/capital-notices?${params.toString()}`, capitalNoticePage),
    retry: retryUnlessUnavailable,
  });
}
export function capitalNoticeQuery(id: string) {
  return queryOptions({
    queryKey: ['capital-notice', id],
    queryFn: () => api(`/api/v1/capital-notices/${encodeURIComponent(id)}`, capitalNoticeDetail),
    retry: retryUnlessUnavailable,
  });
}

export interface AuditFilters {
  entityId?: string | undefined;
}
export function auditQuery(filters: AuditFilters = {}) {
  const params = new URLSearchParams();
  params.set('limit', '100');
  if (filters.entityId) params.set('entityId', filters.entityId);
  return queryOptions({
    queryKey: ['audit', filters],
    queryFn: () => api(`/api/v1/audit/events?${params.toString()}`, auditPage),
    retry: false,
  });
}
export const taxonomyQuery = queryOptions({
  queryKey: ['taxonomy'],
  queryFn: () => api('/api/v1/taxonomy', taxonomy),
  staleTime: Infinity,
});
export const wallsQuery = queryOptions({
  queryKey: ['walls'],
  queryFn: () => api('/api/v1/walls', wallList),
});
/* Intake (docs/04 M2, SEC-9.1): the files staged from the accounting system and their rows. */
export const intakeFilesQuery = queryOptions({
  queryKey: ['intake-files'],
  queryFn: () => api(`/api/v1/intake/files?limit=${LIST_LIMIT}`, intakeFilePage),
  retry: retryUnlessUnavailable,
});
export function intakeFileQuery(id: string) {
  return queryOptions({
    queryKey: ['intake-file', id],
    queryFn: () => api(`/api/v1/intake/files/${encodeURIComponent(id)}`, intakeFileDetail),
    retry: retryUnlessUnavailable,
  });
}
/** Exports waiting in the drop folder the accounting adapter watches; operations only. */
export const intakeExportsQuery = queryOptions({
  queryKey: ['intake-exports'],
  queryFn: () => api('/api/v1/intake/accounting/exports', intakeExportList),
  retry: retryUnlessUnavailable,
});
/* Phase 2 (docs/04 M3, M9): the documents of one position and its realization outlook. */

/** The documents linked to one position, newest first (SEC-8.5: only what the caller may see). */
export function documentsOfInvestmentQuery(investmentId: string) {
  const params = new URLSearchParams();
  params.set('limit', String(LIST_LIMIT));
  params.set('investmentId', investmentId);
  return queryOptions({
    queryKey: ['documents', { investmentId }],
    queryFn: () => api(`/api/v1/documents?${params.toString()}`, documentPage),
    retry: retryUnlessUnavailable,
  });
}
/** The realization outlook of one position, or the API's default when nobody has set one. */
export function realizationOutlookQuery(investmentId: string) {
  return queryOptions({
    queryKey: ['realization-outlook', investmentId],
    queryFn: () =>
      api(
        `/api/v1/monitoring/outlook/${encodeURIComponent(investmentId)}`,
        realizationOutlookDetail,
      ),
    retry: false,
  });
}
export const healthReadyQuery = queryOptions({
  queryKey: ['health-ready'],
  queryFn: () => api('/health/ready', healthReady),
  retry: false,
});

/* Documents (docs/04 M3, decision 0012): the hub, one document, its pages, the review queue and the expected-document tracker. */

export interface DocumentFilters {
  /** Full-text query over title, file name and text excerpt (plainto_tsquery on the API). */
  q?: string | undefined;
  docType?: string | undefined;
  reviewStatus?: DocumentReviewStatus | undefined;
  investmentId?: string | undefined;
  sponsorFundId?: string | undefined;
  periodEnd?: string | undefined;
}

/**
 * Documents newest first (indexedAt, id), a page at a time on the API's cursor
 * (GET /documents); only what the caller may see (SEC-8.5). An infinite query, so the hub's
 * "Load more" appends the next page; a tab that wants one page reads pages[0].
 */
export function documentsQuery(filters: DocumentFilters = {}) {
  return infiniteQueryOptions({
    queryKey: ['documents', filters],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set('limit', String(LIST_LIMIT));
      if (filters.q) params.set('q', filters.q);
      if (filters.docType) params.set('docType', filters.docType);
      if (filters.reviewStatus) params.set('reviewStatus', filters.reviewStatus);
      if (filters.investmentId) params.set('investmentId', filters.investmentId);
      if (filters.sponsorFundId) params.set('sponsorFundId', filters.sponsorFundId);
      if (filters.periodEnd) params.set('periodEnd', filters.periodEnd);
      if (pageParam !== null) params.set('cursor', pageParam);
      return api(`/api/v1/documents?${params.toString()}`, documentPage);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: retryUnlessUnavailable,
  });
}

/** One document with its links, evidence, duplicates and latest run (GET /documents/{id}; 404 when not visible). */
export function documentQuery(id: string) {
  return queryOptions({
    queryKey: ['document', id],
    queryFn: () => api(`/api/v1/documents/${encodeURIComponent(id)}`, documentDetail),
    retry: retryUnlessUnavailable,
    staleTime: AUDITED_READ_STALE_MS,
  });
}

/** The text of a document page by page, read from the store on demand (GET /documents/{id}/pages, audited). */
export function documentPagesQuery(id: string) {
  return queryOptions({
    queryKey: ['document-pages', id],
    queryFn: () => api(`/api/v1/documents/${encodeURIComponent(id)}/pages`, documentPages),
    retry: retryUnlessUnavailable,
    staleTime: AUDITED_READ_STALE_MS,
  });
}

/** Documents the classifier was not sure about (NeedsReview), newest first (GET /documents/review-queue). */
export const reviewQueueQuery = queryOptions({
  queryKey: ['review-queue'],
  queryFn: () => api(`/api/v1/documents/review-queue?limit=${LIST_LIMIT}`, documentPage),
  retry: retryUnlessUnavailable,
});

export interface ExpectedDocumentFilters {
  periodEnd?: string | undefined;
  status?: ExpectedDocumentStatus | undefined;
  investmentId?: string | undefined;
  sponsorFundId?: string | undefined;
  /** The day the status is judged on; the API's clock when left out. */
  asOf?: string | undefined;
}

/** Expected documents with their derived status and age, newest period first (GET /expected-documents). */
export function expectedDocumentsQuery(filters: ExpectedDocumentFilters = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(LIST_LIMIT));
  if (filters.periodEnd) params.set('periodEnd', filters.periodEnd);
  if (filters.status) params.set('status', filters.status);
  if (filters.investmentId) params.set('investmentId', filters.investmentId);
  if (filters.sponsorFundId) params.set('sponsorFundId', filters.sponsorFundId);
  if (filters.asOf) params.set('asOf', filters.asOf);
  return queryOptions({
    queryKey: ['expected-documents', filters],
    queryFn: () => api(`/api/v1/expected-documents?${params.toString()}`, expectedDocumentPage),
    retry: retryUnlessUnavailable,
  });
}
