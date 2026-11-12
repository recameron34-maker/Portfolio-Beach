import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExtractedValue } from '@pb/contracts';
import { EditValueDialog } from './dialogs.js';
import { REVIEWER, RUN_AT, cleanValues } from './test-fixtures.js';

/** Dialog journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

const valueOf = (field: string): ExtractedValue => {
  const found = cleanValues().find((v) => v.field === field);
  if (found === undefined) throw new Error(`no fixture value for ${field}`);
  return found;
};

/** Net debt as the API answers it once a reviewer edited it to thousands (WF-1): the model's value and unit stay, the edit beside them. */
const editedNetDebt = (): ExtractedValue => ({
  ...valueOf('net_debt'),
  decision: 'edited',
  editedValue: '95500',
  editedUnit: 'USD_K',
  decidedBy: REVIEWER,
  decidedAt: RUN_AT,
});

describe('the edit dialog', () => {
  afterEach(cleanup);

  it(
    'opens a row edited before on its edit, in the edit’s own unit, and sends that unit again (WF-1)',
    TIMEOUT,
    async () => {
      const onSubmit = vi.fn();
      render(<EditValueDialog value={editedNetDebt()} onCancel={vi.fn()} onSubmit={onSubmit} />);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading')).toHaveTextContent('Edit Net debt');
      // The model's answer is quoted as the model gave it, not as the edit changed it.
      expect(dialog).toHaveTextContent('The model answered $95.50M on page 2');
      expect(within(dialog).getByRole('textbox', { name: 'Value' })).toHaveValue('95500');
      expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toHaveTextContent('$K');
      await userEvent.type(
        within(dialog).getByRole('textbox', { name: 'Reason' }),
        'Stated in thousands',
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
      expect(onSubmit).toHaveBeenCalledWith({
        command: 'edit',
        field: 'net_debt',
        value: '95500',
        unit: 'USD_K',
        reason: 'Stated in thousands',
      });
    },
  );

  it('opens a row never edited on the model’s value and unit', TIMEOUT, async () => {
    render(<EditValueDialog value={valueOf('net_debt')} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Value' })).toHaveValue('95.50');
    expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toHaveTextContent('$M');
  });

  it('shows no unit for a field that is not money, edited or not', TIMEOUT, async () => {
    const headcount: ExtractedValue = {
      ...valueOf('headcount'),
      decision: 'edited',
      editedValue: '118',
      editedUnit: 'COUNT',
      decidedBy: REVIEWER,
      decidedAt: RUN_AT,
    };
    render(<EditValueDialog value={headcount} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Value' })).toHaveValue('118');
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent('The model answered 120 on page 3');
  });
});
