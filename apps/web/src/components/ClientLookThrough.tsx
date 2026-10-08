import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ClientSummary } from '@pb/contracts';
import { clientsQuery } from '../app/queries.js';
import { formatDate, formatMoic, formatMoneyM, formatPct, labelOf } from '../lib/format.js';
import { UnavailableState } from './UnavailableState.js';
import { Badge, Card, EmptyState, NumCell, PageSkeleton, SectionHeader, StatTile } from './ui.js';

const ENTITLED =
  'Client data is visible to operations, approvers, auditors and the investor relations users entitled to each client (SEC-5.4).';

function ClientCard({ client }: { client: ClientSummary }): ReactNode {
  const t = client.totals;
  return (
    <Card testId={`client-${client.id}`}>
      <SectionHeader
        aside={
          <>
            <span>{labelOf(client.reportingCadence)} reporting</span>
            {client.reportingBases.map((b) => (
              <Badge key={b} plain tone="brand">
                {labelOf(b)}
              </Badge>
            ))}
          </>
        }
      >
        {client.name}
      </SectionHeader>
      <div className="pb-tiles">
        <StatTile label="Commitment" value={formatMoneyM(t.commitment)} />
        <StatTile label="Invested share" value={formatMoneyM(t.invested)} />
        <StatTile label="Distributions share" value={formatMoneyM(t.distributions)} />
        <StatTile label="NAV share" value={formatMoneyM(t.nav)} />
        <StatTile label="Gross MOIC" value={formatMoic(t.grossMoic)} />
      </div>
      <div className="pb-table-wrap">
        <table className="pb-table" aria-label={`${client.name} vehicles`}>
          <thead>
            <tr>
              <th>Vehicle</th>
              <th>Type</th>
              <th className="num">Commitment</th>
              <th className="num">Closing</th>
              <th className="num">Ownership</th>
              <th className="num">Invested share</th>
              <th className="num">Distributions share</th>
              <th className="num">NAV share</th>
              <th className="num">Gross MOIC</th>
            </tr>
          </thead>
          <tbody>
            {client.vehicles.map((v) => {
              const cells = [
                formatMoneyM(v.commitment),
                String(v.closingNumber),
                formatPct(v.ownershipPct),
                formatMoneyM(v.invested),
                formatMoneyM(v.distributions),
                formatMoneyM(v.nav),
                formatMoic(v.grossMoic),
              ];
              return (
                <tr key={v.vehicleId}>
                  <td>{v.vehicleName}</td>
                  <td>{labelOf(v.vehicleType)}</td>
                  {cells.map((c, i) => (
                    <NumCell key={i}>{c}</NumCell>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {client.vehicles.length === 0 ? (
        <p className="pb-meta">This client has no commitment to a firm vehicle on record.</p>
      ) : null}
    </Card>
  );
}

/**
 * Client look-through: each entitled client's commitments and its share of every vehicle's pooled
 * figures (position times ownership, docs/03 section 4). Rendered by Reporting, Clients and by the
 * Analytics Clients tab; the API returns only the clients the caller is entitled to (SEC-5.2).
 */
export function ClientLookThrough(): ReactNode {
  const q = useQuery({ ...clientsQuery, placeholderData: keepPreviousData });
  if (q.isPending) return <PageSkeleton tiles={5} rows={3} />;
  if (q.isError) {
    return (
      <UnavailableState
        card
        subject="Client look-through"
        error={q.error}
        forbidden={{ title: 'No entitled clients', detail: ENTITLED }}
        notReady={{
          title: 'Client look-through is not available yet',
          detail:
            'The clients endpoint is still being built; this view follows its contract and fills in when it lands.',
        }}
        errorTitle="Client look-through unavailable"
        testId="clients-unavailable"
      />
    );
  }
  const { items, asOf } = q.data;
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState title="No entitled clients" detail={ENTITLED} testId="clients-empty" />
      </Card>
    );
  }
  return (
    <>
      <p className="pb-meta" data-testid="clients-asof">
        As of {formatDate(asOf)}. {items.length} entitled{' '}
        {items.length === 1 ? 'client' : 'clients'}; shares use approved figures only.
      </p>
      {items.map((c) => (
        <ClientCard key={c.id} client={c} />
      ))}
    </>
  );
}
