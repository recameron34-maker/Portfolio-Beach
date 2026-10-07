import { queryOptions } from '@tanstack/react-query';
import {
  dataDictionary,
  dataHealth,
  featureFlagList,
  investmentDetail,
  investmentPage,
  mockUserList,
  principal,
  vehicleList,
} from '@pb/contracts';
import { api } from '../api/client.js';

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
