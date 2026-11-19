import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { AllocationRow, AllocationTieOut, AllocationTotals } from '@pb/contracts';
import { NumCell, StatTile, TableWrap } from '../../components/ui.js';
import { formatMoneyM } from '../../lib/format.js';
import { balanceTiles } from '../../lib/tiles.js';
import { breakdownLabel, groupByVehicle, hiddenLinesNote, tieOutLabel } from './pipeline.js';
import type { VehicleGroup } from './pipeline.js';

/*
 * How the allocation of a deal reads on every page that shows it (docs/04 M5, M22; review finding
 * D1-06 and the owner's decisions of 2026-11-11): the full commitment is the headline, the client
 * breakdown is secondary detail. The lead states the commitment and the received total against
 * it, both the deal's own figures from the API and the same for every reader. The lines follow by
 * vehicle, the vehicle's totals first; the client lines sit under their vehicle, quieter, behind a
 * disclosure that starts closed. A reader who is shown fewer lines than the deal has is told how
 * many are not shown in a quiet line under the table. The opportunity page, the closing page and
 * the deal workspace's Closing tab all render these.
 */

const WITHHELD = 'Not stated: some lines of this deal are not shown to you';

/**
 * The headline of an allocation: the closing commitment and the received total against it, tied
 * or not, once a closing record exists; before that, the requested total across all lines beside
 * the deal's target commitment. Every figure is the deal's, never a sum of the lines one reader is
 * shown. Nothing is rendered for a deal with no line and no closing record.
 */
export function AllocationLead({
  totals,
  commitment,
  tieOut,
  targetCommitment,
}: {
  /** The totals of every line (the opportunity detail's allocationTotals). */
  totals: AllocationTotals;
  /** The closing commitment, or null while no closing record exists. */
  commitment: string | null;
  /** The tie-out of the closing, or null while no closing record exists. */
  tieOut: AllocationTieOut | null;
  targetCommitment: string | null;
}): ReactNode {
  if (commitment !== null && tieOut !== null) {
    return (
      <div ref={balanceTiles} className="pb-tiles" data-testid="allocations-lead">
        <StatTile label="Commitment" value={formatMoneyM(commitment)} hint="Closing commitment" />
        <StatTile
          label="Received"
          value={formatMoneyM(tieOut.allocated)}
          hint={tieOutLabel(tieOut)}
          tone={tieOut.tiedOut ? 'good' : 'bad'}
        />
      </div>
    );
  }
  if (totals.lines === 0) return null;
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="allocations-lead">
      <StatTile
        label="Requested"
        value={formatMoneyM(totals.requested)}
        hint="Across all allocation lines"
      />
      <StatTile
        label="Target"
        value={formatMoneyM(targetCommitment)}
        hint="Target commitment; the tie-out starts once the closing record exists"
      />
    </div>
  );
}

/** The quiet line for a reader who is shown fewer lines than the deal has; nothing when every line is shown. */
export function HiddenLinesNote({ hiddenLines }: { hiddenLines: number }): ReactNode {
  const note = hiddenLinesNote(hiddenLines);
  return note === null ? null : (
    <p className="pb-meta pb-pipe-hidden-lines" data-testid="allocations-hidden-lines">
      {note}
    </p>
  );
}

/** A vehicle total, or the placeholder with its reason when lines of the deal are not shown. */
function TotalCell({ value }: { value: string | null }): ReactNode {
  return value === null ? (
    <td className="num is-missing" title={WITHHELD}>
      {formatMoneyM(null)}
    </td>
  ) : (
    <NumCell>{formatMoneyM(value)}</NumCell>
  );
}

/** One vehicle: its totals as the primary row, its own line, then its client lines behind a disclosure. */
function VehicleRows({ group }: { group: VehicleGroup }): ReactNode {
  const [open, setOpen] = useState(false);
  const base = useId();
  const withheld = group.requested === null;
  const clientIds = group.clientLines.map((_line, i) => `${base}-client-${i}`);
  // The vehicle's own line reads as its own row when it is not the whole of the totals above it.
  const showVehicleLine = group.vehicleLine !== null && (group.clientLines.length > 0 || withheld);
  return (
    <tbody>
      <tr className="pb-pipe-vehicle-row">
        <th scope="row">{group.vehicle.name}</th>
        <TotalCell value={group.requested} />
        {withheld ? <TotalCell value={null} /> : <NumCell>{formatMoneyM(group.received)}</NumCell>}
      </tr>
      {showVehicleLine && group.vehicleLine !== null ? (
        <tr className="pb-pipe-sub-row">
          <td>Vehicle line</td>
          <NumCell>{formatMoneyM(group.vehicleLine.requested)}</NumCell>
          <NumCell>{formatMoneyM(group.vehicleLine.received)}</NumCell>
        </tr>
      ) : null}
      {group.clientLines.length === 0 ? null : (
        <tr className="pb-pipe-sub-row">
          <td colSpan={3}>
            <button
              type="button"
              className="pb-pipe-breakdown"
              aria-expanded={open}
              aria-controls={clientIds.join(' ')}
              aria-label={`${breakdownLabel(group.clientLines.length)}, ${group.vehicle.name}`}
              onClick={() => setOpen((o) => !o)}
            >
              {breakdownLabel(group.clientLines.length)}
            </button>
          </td>
        </tr>
      )}
      {group.clientLines.map((line, i) => (
        <tr key={line.id} id={clientIds[i]} className="pb-pipe-client-row" hidden={!open}>
          <td>{line.client?.name}</td>
          <NumCell>{formatMoneyM(line.requested)}</NumCell>
          <NumCell>{formatMoneyM(line.received)}</NumCell>
        </tr>
      ))}
    </tbody>
  );
}

/**
 * The lines the reader is shown, by vehicle. `hiddenLines` is how many lines of the deal are not
 * shown: while it is above zero no vehicle total is stated (it would leave those lines out), the
 * lines shown keep their own amounts, and the quiet note under the table says how many are missing.
 * A reader shown no line at all gets the note alone.
 */
export function AllocationLinesTable({
  rows,
  hiddenLines,
}: {
  rows: readonly AllocationRow[];
  hiddenLines: number;
}): ReactNode {
  const groups = groupByVehicle(rows, hiddenLines);
  return (
    <>
      {groups.length === 0 ? null : (
        <TableWrap label="Allocations">
          <table className="pb-table pb-pipe-lines" aria-label="Allocations">
            <thead>
              <tr>
                <th>Vehicle</th>
                <th className="num">Requested</th>
                <th className="num">Received</th>
              </tr>
            </thead>
            {groups.map((g) => (
              <VehicleRows key={g.vehicle.id} group={g} />
            ))}
          </table>
        </TableWrap>
      )}
      <HiddenLinesNote hiddenLines={hiddenLines} />
    </>
  );
}
