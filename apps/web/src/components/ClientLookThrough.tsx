import { useId } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ClientSummary } from '@pb/contracts';
import { clientsQuery } from '../app/queries.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatPct,
  joinList,
  labelOf,
  MISSING,
  plural,
} from '../lib/format.js';
import { UnavailableState } from './UnavailableState.js';
import {
  Card,
  EmptyState,
  NumCell,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
} from './ui.js';
import { WHO_READS_EVERY_CLIENT } from '../lib/roles.js';
import { balanceTiles } from '../lib/tiles.js';

const ENTITLED = `Client data is visible to ${WHO_READS_EVERY_CLIENT}, and to the investor relations users entitled to each client.`;

/**
 * A figure of a vehicle's row. A share the client has no figure for carries the row's reason on its
 * placeholder, under the pointer and for a screen reader, as the package positions do.
 */
function ShareTd({ text, why }: { text: string; why: string | undefined }): ReactNode {
  if (text !== MISSING || why === undefined) return <NumCell>{text}</NumCell>;
  return (
    <td className="num is-missing" title={why}>
      {text}
      <span className="pb-visually-hidden"> {why}</span>
    </td>
  );
}

function ClientCard({ client }: { client: ClientSummary }): ReactNode {
  const reasonId = useId();
  const t = client.totals;
  // A total is not calculable while a vehicle's share is not (no ownership yet, or no pooled figures).
  const unknown = client.vehicles
    .filter((v) => v.invested === null || v.distributions === null || v.nav === null)
    .map((v) => v.vehicleName);
  // Said once, under the strip; each total it leaves out points to it.
  const why =
    unknown.length === 0 ? undefined : `Totals not calculable: no share for ${joinList(unknown)}.`;
  const reasonFor = (value: string | null): string | undefined =>
    value === null && why !== undefined ? reasonId : undefined;
  const bases = client.reportingBases.map((b) => labelOf(b)).join(', ');
  return (
    <Card testId={`client-${client.id}`}>
      <SectionHeader
        aside={`${labelOf(client.reportingCadence)} reporting${bases === '' ? '' : ` \u00B7 ${bases}`}`}
      >
        {client.name}
      </SectionHeader>
      <div ref={balanceTiles} className="pb-tiles">
        <StatTile label="Commitment" value={formatMoneyM(t.commitment)} />
        <StatTile
          label="Invested share"
          value={formatMoneyM(t.invested)}
          describedBy={reasonFor(t.invested)}
        />
        <StatTile
          label="Distributions share"
          value={formatMoneyM(t.distributions)}
          describedBy={reasonFor(t.distributions)}
        />
        <StatTile label="NAV share" value={formatMoneyM(t.nav)} describedBy={reasonFor(t.nav)} />
        <StatTile
          label="Gross MOIC"
          value={formatMoic(t.grossMoic)}
          describedBy={reasonFor(t.grossMoic)}
        />
      </div>
      {why === undefined ? null : (
        <p className="pb-meta pb-client-reason" id={reasonId}>
          {why}
        </p>
      )}
      <TableWrap label={`${client.name} vehicles`}>
        <table className="pb-table" aria-label={`${client.name} vehicles`}>
          <thead>
            <tr>
              <th>Vehicle</th>
              <th className="num">Commitment</th>
              <th className="num">Closing no.</th>
              <th className="num">Ownership</th>
              <th className="num">Invested share</th>
              <th className="num">Distributions share</th>
              <th className="num">NAV share</th>
              <th className="num">Gross MOIC</th>
            </tr>
          </thead>
          <tbody>
            {client.vehicles.map((v) => {
              const rowWhy = unknown.includes(v.vehicleName)
                ? `Not calculable: no share for ${v.vehicleName}`
                : undefined;
              const shares = [
                formatPct(v.ownershipPct),
                formatMoneyM(v.invested),
                formatMoneyM(v.distributions),
                formatMoneyM(v.nav),
                formatMoic(v.grossMoic),
              ];
              return (
                <tr key={v.vehicleId}>
                  <td className="pb-col-text">
                    {v.vehicleName}
                    <span className="pb-cell-sub">{labelOf(v.vehicleType)}</span>
                  </td>
                  <NumCell>{formatMoneyM(v.commitment)}</NumCell>
                  <NumCell>{String(v.closingNumber)}</NumCell>
                  {shares.map((text, i) => (
                    <ShareTd key={i} text={text} why={rowWhy} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
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
export function ClientLookThrough({
  note,
}: {
  /** A sentence after the last client, such as how a share is worked out. */
  note?: string | undefined;
} = {}): ReactNode {
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
          detail: 'Client views are not available in this version.',
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
        As of {formatDate(asOf)}. {plural(items.length, 'entitled client')}; shares use approved
        figures and cover the positions visible to you.
      </p>
      {items.map((c) => (
        <ClientCard key={c.id} client={c} />
      ))}
      {note === undefined ? null : <p className="pb-meta pb-client-note">{note}</p>}
    </>
  );
}
