import type { z } from 'zod';
import * as s from './schemas.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  summary: string;
  tags: string[];
  /** Roles that may call the route; empty means any authenticated user. */
  roles: readonly string[];
  auth: boolean;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  response: z.ZodTypeAny;
  responseStatus?: number;
}

export const API_PREFIX = '/api/v1';

/** The single route table the API implements and the OpenAPI document is generated from. */
export const ROUTES: readonly RouteDefinition[] = [
  {
    method: 'GET',
    path: '/health/live',
    summary: 'Liveness',
    tags: ['health'],
    roles: [],
    auth: false,
    response: s.healthLive,
  },
  {
    method: 'GET',
    path: '/health/ready',
    summary: 'Readiness: database and adapters',
    tags: ['health'],
    roles: [],
    auth: false,
    response: s.healthReady,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/auth/me`,
    summary: 'The calling principal',
    tags: ['auth'],
    roles: [],
    auth: true,
    response: s.principal,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/auth/mock-users`,
    summary: 'Mock sign-in choices (prototype only, never in production)',
    tags: ['auth'],
    roles: [],
    auth: false,
    response: s.mockUserList,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/flags`,
    summary: 'Feature flags and kill switches',
    tags: ['ops'],
    roles: [],
    auth: true,
    response: s.featureFlagList,
  },
  {
    method: 'PATCH',
    path: `${API_PREFIX}/flags/{key}`,
    summary: 'Set a flag (audited)',
    tags: ['ops'],
    roles: ['platform_admin'],
    auth: true,
    body: s.featureFlagPatch,
    response: s.featureFlag,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/investments`,
    summary: 'Portfolio grid with calculated metrics',
    tags: ['portfolio'],
    roles: [],
    auth: true,
    query: s.investmentListQuery,
    response: s.investmentPage,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/investments/{id}`,
    summary: 'Investment detail (404 when not visible)',
    tags: ['portfolio'],
    roles: [],
    auth: true,
    response: s.investmentDetail,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/sponsors`,
    summary: 'Sponsors',
    tags: ['portfolio'],
    roles: [],
    auth: true,
    query: s.pageQuery,
    response: s.sponsorPage,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/vehicles`,
    summary: 'Firm vehicles',
    tags: ['portfolio'],
    roles: [],
    auth: true,
    response: s.vehicleList,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/data-health`,
    summary: 'Data Health page (M1)',
    tags: ['data'],
    roles: [],
    auth: true,
    response: s.dataHealth,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/data-dictionary`,
    summary: 'Data Dictionary from config/definitions.json (M1)',
    tags: ['data'],
    roles: [],
    auth: true,
    response: s.dataDictionary,
  },
];
