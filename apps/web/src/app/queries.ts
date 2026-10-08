import { queryOptions } from '@tanstack/react-query';
import {
  analyticsSummary,
  auditPage,
  capitalNoticeDetail,
  capitalNoticePage,
  clientList,
  commitmentList,
  dataDictionary,
  dataHealth,
  featureFlagList,
  healthReady,
  investmentDetail,
  investmentPage,
  investmentPerformance,
  mockUserList,
  principal,
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
 * (SEC-11.1). The deal tabs ask for them again on each tab visit, so a minute of freshness keeps a tab
 * switch from writing a new row each time; a change made in the app still refetches them.
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
export const healthReadyQuery = queryOptions({
  queryKey: ['health-ready'],
  queryFn: () => api('/health/ready', healthReady),
  retry: false,
});
