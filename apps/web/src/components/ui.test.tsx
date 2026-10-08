import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { KeyValueTable, TableWrap } from './ui.js';

describe('table frame', () => {
  afterEach(cleanup);

  it('is a focusable region named after its table, so keyboard users can scroll it', () => {
    render(
      <TableWrap label="Cash flows">
        <table aria-label="Cash flows">
          <tbody>
            <tr>
              <td>Jun 30, 2025</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>,
    );
    const region = screen.getByRole('region', { name: 'Cash flows' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('pb-table-wrap');
    expect(within(region).getByRole('table', { name: 'Cash flows' })).toBeInTheDocument();
  });

  it('frames the key and value table the same way', () => {
    render(
      <KeyValueTable
        label="Credit terms"
        rows={[
          { label: 'Facility', value: 'Unitranche' },
          { label: 'Seniority', value: 'Senior secured' },
        ]}
      />,
    );
    const region = screen.getByRole('region', { name: 'Credit terms' });
    expect(within(region).getByRole('rowheader', { name: 'Facility' })).toBeInTheDocument();
  });
});
