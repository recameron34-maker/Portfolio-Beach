import {
  capitalNoticeDetail,
  capitalNoticePage,
  featureFlagList,
  investmentDetail,
  valuationPage,
} from '@pb/contracts';
import type {
  CapitalNoticeDetail,
  CapitalNoticePage,
  InvestmentDetail,
  ValuationPage,
} from '@pb/contracts';
import type { z } from 'zod';
import type { Recordings } from './fixtures.js';
import type { PreviewState, SimNotice, SimValuation } from './state.js';

/**
 * Read overlays: recorded GET bodies with this session's simulated changes laid over them, so lists
 * and the one-pager show what the simulated workflow did. Each overlay is a pure function that
 * returns its input unchanged when nothing applies. Records are added to a list only when the
 * credential's own recorded investment detail answered 200, so a wall still hides what it hid.
 * Figures stay as recorded: nothing here recomputes NAV, MOIC or IRR.
 */

type FeatureFlagList = z.infer<typeof featureFlagList>;

export interface ValuationFilters {
  investmentId?: string;
  periodEnd?: string;
  state?: string;
  vehicleId?: string;
}

/** Every filter the record satisfies; a vehicle filter needs the record's vehicle to be known. */
function matchesAll(sim: SimValuation, filters: ValuationFilters): boolean {
  return (
    (filters.investmentId === undefined || sim.row.investmentId === filters.investmentId) &&
    (filters.periodEnd === undefined || sim.row.periodEnd === filters.periodEnd) &&
    (filters.state === undefined || sim.row.state === filters.state) &&
    (filters.vehicleId === undefined || sim.vehicleId === filters.vehicleId)
  );
}

export function overlayValuationPage(
  page: ValuationPage,
  sims: Iterable<SimValuation>,
  filters: ValuationFilters,
  canSee: (investmentId: string) => boolean,
): ValuationPage {
  const touched = new Map<string, SimValuation>();
  for (const sim of sims) if (sim.changed) touched.set(sim.row.id, sim);
  if (touched.size === 0) return page;
  let changed = false;
  const present = new Set<string>();
  const items: ValuationPage['items'] = [];
  for (const item of page.items) {
    present.add(item.id);
    const sim = touched.get(item.id);
    if (sim === undefined) {
      items.push(item);
      continue;
    }
    changed = true;
    // Only the state can move a listed record out of the filter; the rest never changes.
    if (filters.state === undefined || sim.row.state === filters.state) items.push(sim.row);
  }
  const added: ValuationPage['items'] = [];
  for (const sim of touched.values()) {
    if (present.has(sim.row.id) || !matchesAll(sim, filters) || !canSee(sim.row.investmentId))
      continue;
    added.push(sim.row);
  }
  if (!changed && added.length === 0) return page;
  const periods = [...new Set([...page.periods, ...added.map((r) => r.periodEnd)])].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  return { ...page, items: [...added, ...items], periods };
}

/** The one-pager's version list, keyed by period end and version, in the API's order. */
export function overlayInvestmentDetail(
  detail: InvestmentDetail,
  sims: Iterable<SimValuation>,
): InvestmentDetail {
  const entries = new Map<string, InvestmentDetail['valuations'][number]>();
  for (const v of detail.valuations) entries.set(`${v.periodEnd}#${v.version}`, v);
  let changed = false;
  for (const sim of sims) {
    if (!sim.changed || sim.row.investmentId !== detail.id) continue;
    const { periodEnd, version, state, fairValue, method } = sim.row;
    entries.set(`${periodEnd}#${version}`, { periodEnd, version, state, fairValue, method });
    changed = true;
  }
  if (!changed) return detail;
  const valuations = [...entries.values()].sort((a, b) =>
    a.periodEnd === b.periodEnd ? a.version - b.version : a.periodEnd < b.periodEnd ? -1 : 1,
  );
  return { ...detail, valuations };
}

export function overlayCapitalNoticePage(
  page: CapitalNoticePage,
  sims: Iterable<SimNotice>,
  filters: { state?: string },
): CapitalNoticePage {
  const touched = new Map<string, SimNotice>();
  for (const sim of sims) if (sim.changed) touched.set(sim.row.id, sim);
  if (touched.size === 0) return page;
  let changed = false;
  const replace = (
    rows: CapitalNoticePage['items'],
    keep: (sim: SimNotice) => boolean,
  ): CapitalNoticePage['items'] =>
    rows.flatMap((row) => {
      const sim = touched.get(row.id);
      if (sim === undefined) return [row];
      changed = true;
      return keep(sim) ? [sim.row] : [];
    });
  const items = replace(
    page.items,
    (sim) => filters.state === undefined || sim.row.state === filters.state,
  );
  const attention = replace(page.attention, () => true);
  return changed ? { ...page, items, attention } : page;
}

export function overlayCapitalNoticeDetail(
  detail: CapitalNoticeDetail,
  sim: SimNotice | undefined,
): CapitalNoticeDetail {
  if (sim?.changed !== true) return detail;
  return { ...detail, state: sim.row.state, rowVersion: sim.row.rowVersion };
}

export function overlayFlags(
  list: FeatureFlagList,
  overrides: ReadonlyMap<string, boolean>,
): FeatureFlagList {
  if (!list.flags.some((f) => overrides.has(f.key))) return list;
  return {
    flags: list.flags.map((f) => {
      const enabled = overrides.get(f.key);
      return enabled === undefined ? f : { ...f, enabled };
    }),
  };
}

/** Context the overlays read: the credential's own recordings decide what it may see. */
export interface OverlayContext {
  credential: string;
  recordings: Recordings;
  state: PreviewState;
}

const INVESTMENT = /^\/api\/v1\/investments\/([^/]+)$/;
const NOTICE = /^\/api\/v1\/capital-notices\/([^/]+)$/;

function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
}

/**
 * Applies the overlay for a recorded 200 GET body, if any. Returns the recorded text untouched
 * when no overlay applies, nothing changed, or the body does not match its contract.
 */
export function overlayRecordedBody(url: URL, text: string, ctx: OverlayContext): string {
  const { state } = ctx;
  const path = url.pathname;
  const parse = <T>(schema: z.ZodType<T>): T | undefined => {
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  const write = <T>(before: T | undefined, after: (value: T) => T): string => {
    if (before === undefined) return text;
    const next = after(before);
    return next === before ? text : JSON.stringify(next);
  };
  const canSee = (investmentId: string): boolean =>
    ctx.recordings.status(ctx.credential, `/api/v1/investments/${investmentId}`) === 200;

  if (path === '/api/v1/flags' && state.flags.size > 0)
    return write(parse(featureFlagList), (list) => overlayFlags(list, state.flags));

  if (state.valuations !== null) {
    const sims = state.valuations;
    if (path === '/api/v1/valuations') {
      const filters: ValuationFilters = {};
      for (const name of ['investmentId', 'periodEnd', 'state', 'vehicleId'] as const) {
        const value = param(url, name);
        if (value !== undefined) filters[name] = value;
      }
      return write(parse(valuationPage), (page) =>
        overlayValuationPage(page, sims.values(), filters, canSee),
      );
    }
    if (INVESTMENT.test(path))
      return write(parse(investmentDetail), (detail) =>
        overlayInvestmentDetail(detail, sims.values()),
      );
  }

  if (state.notices !== null) {
    const notices = state.notices;
    if (path === '/api/v1/capital-notices') {
      const noticeState = param(url, 'state');
      return write(parse(capitalNoticePage), (page) =>
        overlayCapitalNoticePage(
          page,
          notices.values(),
          noticeState === undefined ? {} : { state: noticeState },
        ),
      );
    }
    const match = NOTICE.exec(path);
    if (match !== null) {
      const sim = notices.get(decodeURIComponent(match[1] ?? ''));
      return write(parse(capitalNoticeDetail), (detail) => overlayCapitalNoticeDetail(detail, sim));
    }
  }
  return text;
}
