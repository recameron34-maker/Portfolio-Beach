import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { documentClassificationMachine, dealStageMachine } from '@pb/workflows';
import { WorkflowSpec } from './WorkflowSpec.js';

describe('workflow specification card', () => {
  afterEach(cleanup);

  it('folds one row per distinct step under its summary, with no row of state chips', () => {
    render(
      <WorkflowSpec
        machine={dealStageMachine}
        title="Deal stages"
        summary="How a deal moves between stages"
        detail="Detail."
      />,
    );
    const card = screen.getByTestId('workflow-deal_stage');
    const details = card.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(details?.querySelector('summary')).toHaveTextContent('How a deal moves between stages');
    // The table names every state; the chips that repeated them are gone.
    expect(within(card).queryByRole('list')).toBeNull();
    const table = within(card).getByRole('table', { name: 'Deal stages: steps', hidden: true });
    // Seven advances, the seven pass steps folded into one row, and the reopen: nine rows.
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(1 + 9);
    expect(table).toHaveTextContent('An IC decision record is required.');
    expect(card).toHaveTextContent('Starts at Sourced; anything not listed is refused.');
    // A note that points at the guide's section for a step is shown without the pointer.
    expect(table).toHaveTextContent(
      'Opens the closing record with the close date and commitment given.',
    );
    expect(table).not.toHaveTextContent('(section');
  });

  it('says None where a step has no rule', () => {
    render(
      <WorkflowSpec
        machine={documentClassificationMachine}
        title="Document classification"
        summary="How a document is classified"
        detail="Detail."
      />,
    );
    const table = screen.getByRole('table', {
      name: 'Document classification: steps',
      hidden: true,
    });
    expect(within(table).getAllByText('None')).toHaveLength(2);
    expect(table).toHaveTextContent('Classifier confidence is below the threshold.');
  });
});
