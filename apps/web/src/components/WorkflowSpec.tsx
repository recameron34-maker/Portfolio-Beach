import type { ReactNode } from 'react';
import type { Machine } from '@pb/workflows';
import { humanizeState } from '../lib/states.js';
import { stepRows } from '../lib/workflow-spec.js';
import { Card, TableWrap } from './ui.js';

/*
 * A workflow as built and tested in packages/workflows (docs/18): every step, who may take it and
 * the rule that can stop it. It is the reference a page keeps beside its working screen, so it
 * starts folded under its summary and opens on request; the table names every state.
 */

export function WorkflowSpec({
  machine,
  title,
  summary,
  detail,
}: {
  machine: Machine<string, string>;
  /** Names the table ("Deal stages: steps"). */
  title: string;
  /** The disclosure's words, a plain question of what the table answers. */
  summary: string;
  detail: string;
}): ReactNode {
  const rows = stepRows(machine);
  return (
    <Card testId={`workflow-${machine.name}`}>
      <details className="pb-details pb-workflow-spec">
        <summary>{summary}</summary>
        <p className="pb-meta">
          {detail} Starts at {humanizeState(machine.initial)}; anything not listed is refused.
        </p>
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
                  <td className="pb-col-text">{r.from.join(', ')}</td>
                  <td>{r.step}</td>
                  <td>{r.to}</td>
                  <td>{r.who}</td>
                  <td className="pb-col-text">{r.rule ?? <span className="pb-meta">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </details>
    </Card>
  );
}
