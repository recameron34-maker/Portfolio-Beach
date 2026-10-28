import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { WireInstructionRow, WireInstructionState } from '@pb/contracts';
import { Badge, TableWrap } from '../../components/ui.js';
import { formatDate } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';
import { wireTone } from './tones.js';
import { callbackWords, dayOf, kindLabel } from './wires.js';

export function WireStateBadge({ state }: { state: WireInstructionState }): ReactNode {
  return <Badge tone={wireTone(state)}>{humanizeState(state)}</Badge>;
}

/**
 * The versions of the register as one table, masked (SEC-12.2): the whole register on the
 * register page, one counterparty's history on the instruction page (currentId marks the version
 * the page is about). Every row links to its version.
 */
export function WireTable({
  rows,
  label,
  showCounterparty = true,
  currentId,
}: {
  rows: readonly WireInstructionRow[];
  label: string;
  showCounterparty?: boolean;
  currentId?: string | undefined;
}): ReactNode {
  return (
    <TableWrap label={label}>
      <table className="pb-table" aria-label={label}>
        <thead>
          <tr>
            {showCounterparty ? <th>Counterparty</th> : null}
            <th>Version</th>
            <th>State</th>
            <th>Bank details</th>
            <th>Proposed</th>
            <th>Callback</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.id} {...(w.id === currentId ? { 'aria-current': 'true' as const } : {})}>
              {showCounterparty ? (
                <td>
                  <span className="pb-cap-subject">
                    <Link to="/capital-activity/wires/$id" params={{ id: w.id }}>
                      {w.counterparty.name}
                    </Link>
                    <Badge plain tone="neutral">
                      {kindLabel(w.counterparty.kind)}
                    </Badge>
                  </span>
                </td>
              ) : null}
              <td className="pb-nowrap">
                {showCounterparty ? (
                  `Version ${w.version}`
                ) : (
                  <Link to="/capital-activity/wires/$id" params={{ id: w.id }}>
                    Version {w.version}
                  </Link>
                )}
                {w.id === currentId ? <span className="pb-meta"> (this page)</span> : null}
              </td>
              <td>
                <WireStateBadge state={w.state} />
              </td>
              <td className="pb-nowrap pb-wire-masked">{w.bankDetailsMasked}</td>
              <td>
                {w.proposedBy.name}, {formatDate(dayOf(w.proposedAt))}
              </td>
              <td>{callbackWords(w.callback)}</td>
              <td>
                {w.active ? <Badge tone="good">Active</Badge> : <span className="pb-meta">No</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
