import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey, UseMutationResult } from '@tanstack/react-query';
import {
  tradeTicketPage,
  tradeTicketRow,
  wireInstructionDetail,
  wireInstructionPage,
} from '@pb/contracts';
import type {
  WireInstructionCommandBody,
  WireInstructionDetail,
  WireInstructionProposeBody,
  WireInstructionState,
} from '@pb/contracts';
import { api } from '../../api/client.js';
import { LIST_LIMIT } from '../../app/queries.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';

/*
 * The capital activity controls (docs/04 M16, SEC-12): the trade tickets and the wire instruction
 * register. Reads are query options with the fixed, sorted parameters scripts/preview-plan.mjs
 * records (limit first, then the filters); writes go through mutations that invalidate every read
 * a new or verified instruction can change. Bank details travel in the propose body only, typed by
 * a person (SEC-12.1); the reads answer the masked form and, for operations and approvers, the
 * audited clear form of one instruction.
 */

/**
 * A ticket open and an instruction open by a clear reader write an audit row (SEC-11.1), so they
 * stay fresh for a minute, as queries.ts holds every audited read.
 */
const AUDITED_READ_STALE_MS = 60_000;

/** Every visible ticket with its release blockers, latest funding date first (GET /trade-tickets). */
export function tradeTicketsQuery() {
  return queryOptions({
    queryKey: ['trade-tickets', {}],
    queryFn: () => api(`/api/v1/trade-tickets?limit=${LIST_LIMIT}`, tradeTicketPage),
    retry: retryUnlessUnavailable,
  });
}

/** One ticket; 404 when its notice is not visible (GET /trade-tickets/{id}, audited). */
export function tradeTicketQuery(id: string) {
  return queryOptions({
    queryKey: ['trade-ticket', id],
    queryFn: () => api(`/api/v1/trade-tickets/${encodeURIComponent(id)}`, tradeTicketRow),
    retry: retryUnlessUnavailable,
    staleTime: AUDITED_READ_STALE_MS,
  });
}

export interface WireInstructionFilters {
  investmentId?: string | undefined;
  sponsorFundId?: string | undefined;
  state?: WireInstructionState | undefined;
}

/** The register, newest proposal first, masked (GET /wire-instructions; 403 outside the register's roles). */
export function wireInstructionsQuery(filters: WireInstructionFilters = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(LIST_LIMIT));
  if (filters.investmentId) params.set('investmentId', filters.investmentId);
  if (filters.sponsorFundId) params.set('sponsorFundId', filters.sponsorFundId);
  if (filters.state) params.set('state', filters.state);
  return queryOptions({
    queryKey: ['wire-instructions', filters],
    queryFn: () => api(`/api/v1/wire-instructions?${params.toString()}`, wireInstructionPage),
    retry: retryUnlessUnavailable,
  });
}

/**
 * One version with the bank details in clear for operations and approvers (each such read is
 * audited, SEC-11.1) and null for every other reader (GET /wire-instructions/{id}).
 */
export function wireInstructionQuery(id: string) {
  return queryOptions({
    queryKey: ['wire-instruction', id],
    queryFn: () =>
      api(`/api/v1/wire-instructions/${encodeURIComponent(id)}`, wireInstructionDetail),
    retry: retryUnlessUnavailable,
    staleTime: AUDITED_READ_STALE_MS,
  });
}

/** POST /api/v1/wire-instructions: a new Proposed version for a counterparty, typed by operations (SEC-12.1). */
export function postProposeWireInstruction(
  body: WireInstructionProposeBody,
): Promise<WireInstructionDetail> {
  return api('/api/v1/wire-instructions', wireInstructionDetail, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** POST /api/v1/wire-instructions/{id}/commands: verify (a confirming callback) or reject (SEC-12.2). */
export function postWireInstructionCommand(
  id: string,
  body: WireInstructionCommandBody,
): Promise<WireInstructionDetail> {
  return api(
    `/api/v1/wire-instructions/${encodeURIComponent(id)}/commands`,
    wireInstructionDetail,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

/**
 * The reads a register write can change: the register and the version; a new version flags every
 * open notice of the counterparty and returns an approved ticket to draft (SEC-12.4), a verified
 * one lifts the hold the ticket panels and the notice alerts show; every write is audited.
 */
const WIRE_KEYS: QueryKey[] = [
  ['wire-instructions'],
  ['wire-instruction'],
  ['capital-notices'],
  ['capital-notice'],
  ['trade-tickets'],
  ['trade-ticket'],
  ['audit'],
];

function invalidate(queryClient: QueryClient, keys: QueryKey[]): void {
  void Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export function useProposeWireInstruction(): UseMutationResult<
  WireInstructionDetail,
  Error,
  WireInstructionProposeBody
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: WireInstructionProposeBody) => postProposeWireInstruction(body),
    onSuccess: (detail) => {
      // The instruction page opens on the answer instead of a second (audited) read.
      queryClient.setQueryData(['wire-instruction', detail.id], detail);
      invalidate(queryClient, WIRE_KEYS);
    },
  });
}

export interface WireCommandVariables {
  id: string;
  body: WireInstructionCommandBody;
}

export function useWireInstructionCommand(): UseMutationResult<
  WireInstructionDetail,
  Error,
  WireCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: WireCommandVariables) => postWireInstructionCommand(id, body),
    onSuccess: (detail) => {
      queryClient.setQueryData(['wire-instruction', detail.id], detail);
      invalidate(queryClient, WIRE_KEYS);
    },
  });
}
