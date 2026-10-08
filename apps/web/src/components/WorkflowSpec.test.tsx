import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { documentClassificationMachine, dealStageMachine } from '@pb/workflows';
import { WorkflowSpec } from './WorkflowSpec.js';

describe('workflow specification card', () => {
  afterEach(cleanup);

  it('lists the states and one row per distinct step', () => {
    render(<WorkflowSpec machine={dealStageMachine} title="Deal stages" detail="Detail." />);
    const card = screen.getByTestId('workflow-deal_stage');
    expect(within(card).getByRole('list', { name: 'Deal stages: states' }).children).toHaveLength(
      9,
    );
    const table = within(card).getByRole('table', { name: 'Deal stages: steps' });
    // Seven advances, the seven pass steps folded into one row, and the reopen: nine rows.
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 9);
    expect(table).toHaveTextContent('An IC decision record is required.');
    expect(card).toHaveTextContent('Starts at Sourced; anything not listed is refused.');
  });

  it('says None where a step has no rule', () => {
    render(
      <WorkflowSpec
        machine={documentClassificationMachine}
        title="Document classification"
        detail="Detail."
      />,
    );
    const table = screen.getByRole('table', { name: 'Document classification: steps' });
    expect(within(table).getAllByText('None')).toHaveLength(2);
    expect(table).toHaveTextContent('Classifier confidence is below the threshold.');
  });
});
