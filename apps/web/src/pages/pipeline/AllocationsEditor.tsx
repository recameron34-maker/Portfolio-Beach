import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Input, Option } from '@fluentui/react-components';
import type { AllocationRow, ClosingSummary } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { clientsQuery, vehiclesQuery } from '../../app/queries.js';
import { Badge, Card, EmptyState, NumCell, SectionHeader, TableWrap } from '../../components/ui.js';
import { formatMoneyM, MISSING, plural } from '../../lib/format.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';
import { blockedTitle, resultSuffix } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { usePutAllocations } from './api.js';
import {
  allocatedTotal,
  allocationsBody,
  isCompleteLine,
  linesOf,
  lowerFirst,
  mayUse,
  PIPELINE_ROLES,
  tieOutLabel,
  tieOutTone,
} from './pipeline.js';
import type { AllocationLine } from './pipeline.js';

const INCOMPLETE = 'Every line needs a vehicle and a requested amount (received is optional)';

/** The tie-out against the closing commitment, or what it waits for when no closing exists (M22). */
function TieOutLine({
  closing,
  total,
}: {
  closing: ClosingSummary | null;
  total: string | null;
}): ReactNode {
  if (closing === null) {
    return (
      <span className="pb-meta">
        Allocated {total === null ? MISSING : formatMoneyM(total)}. The tie-out starts once the
        closing record exists (M22).
      </span>
    );
  }
  return (
    <>
      <span className="pb-meta">
        Allocated {total === null ? MISSING : formatMoneyM(total)} against a commitment of{' '}
        {formatMoneyM(closing.commitmentAmount)}.
      </span>
      <Badge tone={tieOutTone(closing.allocationTieOut)}>
        {tieOutLabel(closing.allocationTieOut)}
      </Badge>
    </>
  );
}

function ReadOnlyTable({ rows }: { rows: readonly AllocationRow[] }): ReactNode {
  return (
    <TableWrap label="Allocations">
      <table className="pb-table" aria-label="Allocations">
        <thead>
          <tr>
            <th>Vehicle</th>
            <th>Client</th>
            <th className="num">Requested</th>
            <th className="num">Received</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.vehicle.name}</td>
              <td>{r.client === null ? 'Vehicle line' : r.client.name}</td>
              <NumCell>{formatMoneyM(r.requested)}</NumCell>
              <NumCell>{formatMoneyM(r.received)}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

const EMPTY_LINE: AllocationLine = { vehicleId: '', clientId: '', requested: '', received: '' };

function Editor({
  opportunityId,
  name,
  rows,
  closing,
  roles,
  log,
}: {
  opportunityId: string;
  name: string;
  rows: readonly AllocationRow[];
  closing: ClosingSummary | null;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const vehicles = useQuery({ ...vehiclesQuery, retry: retryUnlessUnavailable });
  const clients = useQuery({ ...clientsQuery, retry: retryUnlessUnavailable });
  const put = usePutAllocations();
  const [lines, setLines] = useState<AllocationLine[]>(() => linesOf(rows));
  const vehicleItems = vehicles.data?.items ?? [];
  const clientItems = clients.data?.items ?? [];
  const complete = lines.every(isCompleteLine);
  const total = allocatedTotal(lines);
  const blocked =
    blockedTitle({
      allowed: mayUse(roles, PIPELINE_ROLES.allocations),
      roles: PIPELINE_ROLES.allocations,
    }) ?? (complete ? null : INCOMPLETE);
  const update = (index: number, patch: Partial<AllocationLine>): void =>
    setLines((ls) => ls.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const remove = (index: number): void => setLines((ls) => ls.filter((_l, i) => i !== index));
  const save = (): void => {
    if (blocked !== null) return;
    put.mutate(
      { id: opportunityId, body: allocationsBody(lines) },
      {
        onSuccess: (updated) =>
          log.record(
            'good',
            `Allocations saved for ${updated.name}: ${plural(updated.allocations.length, 'line')}, ${
              updated.closing === null
                ? 'no closing record to tie out yet'
                : lowerFirst(tieOutLabel(updated.closing.allocationTieOut))
            } ${resultSuffix()}`,
          ),
        onError: (error) =>
          log.record('bad', `Save allocations for ${name}: ${describeActionError(error)}`),
      },
    );
  };
  return (
    <>
      {lines.length === 0 ? (
        <EmptyState
          title="No allocation lines"
          detail="Add a line per vehicle, and per client for a client-directed share."
          testId="allocations-empty"
        />
      ) : (
        <TableWrap label="Allocations">
          <table className="pb-table pb-pipe-allocations" aria-label="Allocations">
            <thead>
              <tr>
                <th>Vehicle</th>
                <th>Client</th>
                <th className="num">Requested</th>
                <th className="num">Received</th>
                <th>Remove</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => {
                const vehicleName = vehicleItems.find((v) => v.id === line.vehicleId)?.name ?? '';
                const clientName = clientItems.find((c) => c.id === line.clientId)?.name ?? '';
                return (
                  <tr key={i} data-testid={`allocation-row-${i}`}>
                    <td>
                      <Dropdown
                        className="pb-pipe-control"
                        aria-label={`Vehicle, line ${i + 1}`}
                        placeholder={
                          vehicles.isError ? 'Vehicles could not load' : 'Choose a vehicle'
                        }
                        value={vehicleName}
                        selectedOptions={line.vehicleId === '' ? [] : [line.vehicleId]}
                        onOptionSelect={(_e, d) => update(i, { vehicleId: d.optionValue ?? '' })}
                      >
                        {vehicleItems.map((v) => (
                          <Option key={v.id} value={v.id} text={v.name}>
                            {v.name}
                          </Option>
                        ))}
                      </Dropdown>
                    </td>
                    <td>
                      <Dropdown
                        className="pb-pipe-control"
                        aria-label={`Client, line ${i + 1}`}
                        placeholder="Vehicle line"
                        value={clientName}
                        selectedOptions={line.clientId === '' ? [] : [line.clientId]}
                        onOptionSelect={(_e, d) => update(i, { clientId: d.optionValue ?? '' })}
                      >
                        <Option value="">Vehicle line (no client)</Option>
                        {clientItems.map((c) => (
                          <Option key={c.id} value={c.id} text={c.name}>
                            {c.name}
                          </Option>
                        ))}
                      </Dropdown>
                    </td>
                    <td className="num">
                      <Input
                        className="pb-pipe-control is-short"
                        aria-label={`Requested, line ${i + 1}`}
                        inputMode="decimal"
                        value={line.requested}
                        onChange={(_e, d) => update(i, { requested: d.value })}
                      />
                    </td>
                    <td className="num">
                      <Input
                        className="pb-pipe-control is-short"
                        aria-label={`Received, line ${i + 1}`}
                        inputMode="decimal"
                        value={line.received}
                        onChange={(_e, d) => update(i, { received: d.value })}
                      />
                    </td>
                    <td>
                      <Button
                        size="small"
                        appearance="subtle"
                        aria-label={`Remove line ${i + 1}`}
                        onClick={() => remove(i)}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      {clients.isError ? (
        <p className="pb-meta pb-deal-note">
          Client lines need a role entitled to client data; vehicle lines are enough to tie out.
        </p>
      ) : null}
      <div className="pb-pipe-allocation-foot">
        <Button
          size="small"
          appearance="secondary"
          onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}
        >
          Add line
        </Button>
        <Button
          size="small"
          appearance="primary"
          disabled={blocked !== null || put.isPending}
          {...(blocked === null ? {} : { title: blocked })}
          onClick={save}
        >
          Save allocations
        </Button>
        <TieOutLine closing={closing} total={total} />
      </div>
    </>
  );
}

/**
 * Requested against received by vehicle and client (docs/04 M5, M22). The whole list is saved at
 * once (PUT replaces it); the tie-out against the closing commitment decides whether the deal can
 * close. Roles the route does not admit see the lines read only.
 */
export function AllocationsEditor({
  opportunityId,
  name,
  rows,
  closing,
  rowVersion,
  roles,
  log,
}: {
  opportunityId: string;
  name: string;
  rows: readonly AllocationRow[];
  closing: ClosingSummary | null;
  rowVersion: number;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const canEdit = mayUse(roles, PIPELINE_ROLES.allocations);
  return (
    <Card testId="allocations-editor">
      <SectionHeader aside={rows.length === 0 ? undefined : plural(rows.length, 'line')}>
        Allocations
      </SectionHeader>
      {canEdit ? (
        // Keyed by the row version: a saved answer re-seeds the lines from the record.
        <Editor
          key={rowVersion}
          opportunityId={opportunityId}
          name={name}
          rows={rows}
          closing={closing}
          roles={roles}
          log={log}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No allocation lines"
          detail="The deal team or operations records the allocation by vehicle and client."
          testId="allocations-empty"
        />
      ) : (
        <>
          <ReadOnlyTable rows={rows} />
          <div className="pb-pipe-allocation-foot">
            <TieOutLine closing={closing} total={allocatedTotal(linesOf(rows))} />
          </div>
        </>
      )}
    </Card>
  );
}
