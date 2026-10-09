import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import { CALC_VERSION, D, moic } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import type {
  ClientList,
  ClientSummary,
  CommitmentList,
  PooledMetrics,
  VehicleDetail,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { configInteger } from '../common/definitions.js';
import { DEFINITIONS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import { loadCommitmentRows } from '../portfolio/commitments.js';
import { loadInvestmentsWithMetrics } from '../portfolio/loaders.js';
import { lockedNavSeries, pooledPositionMetrics, str } from '../portfolio/metrics.js';
import { compareText, sumCalculable } from '../common/order.js';
import { vehicleLpCommitmentTotal } from '../common/subqueries.js';

/** Calculation settings from config/definitions.json (docs/03 section 4); only the keys this service reads. */
interface Definitions {
  priorYearPeriodEndToleranceDays?: number;
  analytics?: { navSeriesQuarters?: number };
  [key: string]: unknown;
}

type Position = Awaited<ReturnType<typeof loadInvestmentsWithMetrics>>[number];
type LpCommitmentRow = NonNullable<VehicleDetail['lpCommitments']>[number];
type ClientVehicleShare = ClientSummary['vehicles'][number];

/**
 * Roles that see every client, mirroring pb.sees_all_clients() in the database (SEC-5.2);
 * platform_admin is deliberately not one of them (SEC-5.4). Everyone else sees client data only
 * through an explicit entitlement.
 */
const ALL_CLIENT_ROLES: ReadonlySet<string> = new Set(['operations', 'approver', 'auditor']);

const seesClientData = (principal: Principal): boolean =>
  principal.clientIds.length > 0 || principal.roles.some((r) => ALL_CLIENT_ROLES.has(r));

/** Strings from a jsonb list column; anything else in it is not a reporting basis. */
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];

/**
 * Pooled gross metrics over a vehicle's visible positions (docs/08 sections 2 and 3). The primary
 * program holds commitments rather than investments, so it pools no position and every figure is
 * not calculable (pooledPositionMetrics decides that for every view).
 */
function pooled(positions: readonly Position[], asOf: string): PooledMetrics {
  return pooledPositionMetrics(
    positions.map((p) => ({ flows: p.flows, valuations: p.valuations, isActive: p.row.isActive })),
    asOf,
  );
}

/**
 * A client's share of a vehicle's pooled figures: position times lp_commitment.ownership_pct,
 * computed at read time and never stored (docs/03 section 4, decision 0004). Null when the
 * percentage is not set yet or the pooled figure is not calculable.
 */
function shareOf(
  metrics: PooledMetrics,
  ownershipPct: string | null,
): Pick<ClientVehicleShare, 'invested' | 'distributions' | 'nav' | 'grossMoic'> {
  if (ownershipPct === null) {
    return { invested: null, distributions: null, nav: null, grossMoic: null };
  }
  const pct = D(ownershipPct);
  const times = (value: string | null): Decimal | null =>
    value === null ? null : D(value).times(pct);
  const invested = times(metrics.invested);
  const distributions = times(metrics.distributions);
  const nav = times(metrics.nav);
  const grossMoic =
    invested === null || distributions === null || nav === null
      ? null
      : moic(distributions, nav, invested);
  return {
    invested: str(invested),
    distributions: str(distributions),
    nav: str(nav),
    grossMoic: str(grossMoic),
  };
}

/** Sums of a client's vehicle shares; the MOIC is only calculable when no vehicle is partly known. */
function clientTotals(vehicles: readonly ClientVehicleShare[]): ClientSummary['totals'] {
  const invested = sumCalculable(vehicles, (v) => v.invested);
  const distributions = sumCalculable(vehicles, (v) => v.distributions);
  const nav = sumCalculable(vehicles, (v) => v.nav);
  const partial = vehicles.some(
    (v) => v.invested !== null && (v.nav === null || v.distributions === null),
  );
  return {
    commitment: str(sumCalculable(vehicles, (v) => v.commitment)),
    invested: str(invested),
    distributions: str(distributions),
    nav: str(nav),
    grossMoic:
      partial || invested === null || distributions === null || nav === null
        ? null
        : str(moic(distributions, nav, invested)),
  };
}

/** LP commitments to a vehicle with the client's name; RLS leaves only entitled clients' rows. */
async function loadLpCommitments(tx: Tx, vehicleId: string): Promise<LpCommitmentRow[]> {
  const l = schema.lpCommitment;
  const rows = await tx
    .select({
      clientId: l.clientId,
      clientName: schema.client.name,
      amount: l.amount,
      closingNumber: l.closingNumber,
      ownershipPct: l.ownershipPct,
      commitmentDate: l.commitmentDate,
    })
    .from(l)
    .innerJoin(schema.client, eq(schema.client.id, l.clientId))
    .where(eq(l.vehicleId, vehicleId));
  return rows.sort(
    (a, b) => a.closingNumber - b.closingNumber || compareText(a.clientName, b.clientName),
  );
}

@Injectable()
export class VehiclesService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  /**
   * One vehicle with its visible positions, pooled metrics, fund commitments and, for callers
   * entitled to client data, its LP commitments. 404 for anything the caller cannot see
   * (docs/17 section 3). Opening client data is an audited sensitive read (SEC-11.1).
   */
  async detail(
    principal: Principal,
    requestId: string,
    id: string,
    asOf: string,
  ): Promise<VehicleDetail> {
    const quarters = configInteger(
      this.definitions.analytics?.navSeriesQuarters,
      'analytics.navSeriesQuarters',
    );
    const toleranceDays = configInteger(
      this.definitions.priorYearPeriodEndToleranceDays,
      'priorYearPeriodEndToleranceDays',
    );
    const entitled = seesClientData(principal);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const vehicle = (
        await tx
          .select({
            id: schema.vehicle.id,
            name: schema.vehicle.name,
            vehicleType: schema.vehicle.vehicleType,
            vintage: schema.vehicle.vintage,
            currency: schema.vehicle.currency,
            closingCount: schema.vehicle.closingCount,
            finalCloseDate: schema.vehicle.finalCloseDate,
            lpCommitmentsTotal: vehicleLpCommitmentTotal,
          })
          .from(schema.vehicle)
          .where(eq(schema.vehicle.id, id))
          .limit(1)
      )[0];
      if (vehicle === undefined) throw new ProblemError(404, 'not-found', 'Vehicle not found');
      const positions = await loadInvestmentsWithMetrics(
        tx,
        asOf,
        eq(schema.investment.vehicleId, id),
      );
      const fundCommitments = await loadCommitmentRows(
        tx,
        asOf,
        eq(schema.commitment.vehicleId, id),
      );
      // Null, never an empty list, for a caller without client data (contract note on vehicleDetail).
      const lpCommitments = entitled ? await loadLpCommitments(tx, id) : null;
      if (lpCommitments !== null) {
        await audit({ action: 'vehicle.read', entity: 'core.vehicle', entityId: id });
      }
      return {
        ...vehicle,
        // Held on the as-of date, like every figure below (the vehicle list counts today).
        activeInvestments: positions.filter((p) => p.row.isActive).length,
        asOf,
        metrics: pooled(positions, asOf),
        positions: positions.map((p) => p.summary),
        fundCommitments,
        lpCommitments,
        navSeries: lockedNavSeries(
          positions.map((p) => p.valuations),
          asOf,
          { quarters, toleranceDays },
        ),
        calcVersion: CALC_VERSION,
      };
    });
  }

  /**
   * Every fund commitment the caller can see (M17): the primary program's pooled commitments for
   * everyone, a separate account's for callers entitled to that client (SEC-5.2). Totals sum the
   * calculable rows; disclosing a client-directed row is an audited sensitive read (SEC-11.1).
   */
  async commitments(
    principal: Principal,
    requestId: string,
    asOf: string,
  ): Promise<CommitmentList> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      const items = await loadCommitmentRows(tx, asOf);
      if (items.some((r) => r.clientName !== null)) {
        await audit({ action: 'commitment.read', entity: 'core.commitment' });
      }
      return {
        asOf,
        items,
        totals: {
          amount: str(sumCalculable(items, (r) => r.amount)),
          called: str(sumCalculable(items, (r) => r.called)),
          distributed: str(sumCalculable(items, (r) => r.distributed)),
          unfunded: str(sumCalculable(items, (r) => r.unfunded)),
        },
        calcVersion: CALC_VERSION,
      };
    });
  }

  /**
   * Client look-through (docs/03 section 4): for every client the caller is entitled to (RLS on
   * core.client and core.lp_commitment, SEC-5.2), each LP commitment with the client's share of
   * the vehicle's pooled figures. A caller without entitlements gets an empty list, not 403.
   * Each vehicle is pooled once per request. The read is audited without values (SEC-11.1).
   */
  async clients(principal: Principal, requestId: string, asOf: string): Promise<ClientList> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      await audit({ action: 'client.read', entity: 'core.client' });
      const clients = (
        await tx
          .select({
            id: schema.client.id,
            name: schema.client.name,
            reportingBases: schema.client.reportingBases,
            reportingCadence: schema.client.reportingCadence,
          })
          .from(schema.client)
      ).sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
      if (clients.length === 0) return { asOf, items: [], calcVersion: CALC_VERSION };

      const l = schema.lpCommitment;
      const lpRows = await tx
        .select({
          clientId: l.clientId,
          vehicleId: l.vehicleId,
          vehicleName: schema.vehicle.name,
          vehicleType: schema.vehicle.vehicleType,
          commitment: l.amount,
          closingNumber: l.closingNumber,
          ownershipPct: l.ownershipPct,
          commitmentDate: l.commitmentDate,
        })
        .from(l)
        .innerJoin(schema.vehicle, eq(schema.vehicle.id, l.vehicleId))
        .where(
          inArray(
            l.clientId,
            clients.map((c) => c.id),
          ),
        );

      const vehicleIds = [...new Set(lpRows.map((r) => r.vehicleId))];
      const positions =
        vehicleIds.length === 0
          ? []
          : await loadInvestmentsWithMetrics(
              tx,
              asOf,
              inArray(schema.investment.vehicleId, vehicleIds),
            );
      const byVehicle = new Map<string, Position[]>();
      for (const p of positions) {
        const set = byVehicle.get(p.row.vehicleId);
        if (set === undefined) byVehicle.set(p.row.vehicleId, [p]);
        else set.push(p);
      }
      const metricsByVehicle = new Map<string, PooledMetrics>(
        vehicleIds.map((v) => [v, pooled(byVehicle.get(v) ?? [], asOf)]),
      );

      const items: ClientSummary[] = clients.map((c) => {
        const vehicles: ClientVehicleShare[] = lpRows
          .filter((r) => r.clientId === c.id)
          .sort((a, b) => compareText(a.vehicleName, b.vehicleName))
          .map(({ clientId: _c, ...r }) => ({
            ...r,
            ...shareOf(metricsByVehicle.get(r.vehicleId) ?? pooled([], asOf), r.ownershipPct),
          }));
        return {
          id: c.id,
          name: c.name,
          reportingBases: stringList(c.reportingBases),
          reportingCadence: c.reportingCadence,
          vehicles,
          totals: clientTotals(vehicles),
        };
      });
      return { asOf, items, calcVersion: CALC_VERSION };
    });
  }
}
