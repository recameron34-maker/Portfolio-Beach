import type { ReactNode } from 'react';
import type { Machine } from '@pb/workflows';
import { humanizeState } from '../lib/states.js';
import { stepRows } from '../lib/workflow-spec.js';
import { Badge, Card, SectionHeader, TableWrap } from './ui.js';

/*
 * A later module's workflow as already built and tested in packages/workflows (docs/18), shown on
 * its phase page: the states, every step, who may take it and the rule that can stop it. It is the
 * specification the screens will run on, not a working screen.
 */

export function WorkflowSpec({
  machine,
  title,
  detail,
}: {
  machine: Machine<string, string>;
  title: string;
  detail: string;
}): ReactNode {
  const rows = stepRows(machine);
  return (
    <Card testId={`workflow-${machine.name}`}>
      <SectionHeader aside="Built and tested ahead of the screens">{title}</SectionHeader>
      <p className="pb-meta">
        {detail} Starts at {humanizeState(machine.initial)}; anything not listed is refused.
      </p>
      <ul className="pb-chips pb-workflow-states" aria-label={`${title}: states`}>
        {machine.states.map((s) => (
          <li key={s}>
            <Badge
              plain
              tone={
                s === machine.initial ? 'brand' : machine.terminal.includes(s) ? 'good' : 'neutral'
              }
            >
              {humanizeState(s)}
            </Badge>
          </li>
        ))}
      </ul>
      <TableWrap label={`${title}: steps`}>
        <table className="pb-table" aria-label={`${title}: steps`}>
          <thead>
            <tr>
              <th>From</th>
              <th>Step</th>
              <th>To</th>
              <th>Who</th>
              <th>Rule</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.from.join()}|${r.step}|${r.to}`}>
                <td>{r.from.join(', ')}</td>
                <td>{r.step}</td>
                <td>{r.to}</td>
                <td>{r.who}</td>
                <td>{r.rule ?? <span className="pb-meta">None</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}
