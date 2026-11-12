import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NavTrendCard } from './NavTrendCard.js';

const EM_DASH = String.fromCharCode(0x2014);

describe('NavTrendCard', () => {
  afterEach(cleanup);

  it('charts the calculable quarters, leaves a gap for the rest and names them under the chart', async () => {
    const { container } = render(
      <NavTrendCard
        points={[
          { periodEnd: '2024-09-30', value: '100000000.00' },
          { periodEnd: '2024-12-31', value: null },
          { periodEnd: '2025-03-31', value: '110000000.00' },
          { periodEnd: '2025-06-30', value: '125000000.00' },
        ]}
        testId="nav"
      />,
    );
    expect(screen.getByRole('group', { name: 'NAV by quarter' })).toBeInTheDocument();
    expect(screen.getByText('Each at its latest Locked mark, last 4 quarters')).toBeInTheDocument();
    expect(screen.getByTestId('nav-gaps')).toHaveTextContent(
      'Not calculable for Q4 2024: a position held then had no Locked mark for that quarter or an earlier one.',
    );
    // Two runs, a lone point at Q3 2024 and a line from Q1 2025: nothing is drawn across Q4 2024.
    expect(container.querySelectorAll('path[fill="none"]')).toHaveLength(1);
    expect(container.querySelectorAll('circle[r="2.5"]')).toHaveLength(1);
    expect(container.textContent).toContain('from $100.0M in Q3 2024 to $125.0M in Q2 2025');
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    const table = screen.getByRole('table', { name: 'NAV by quarter, as a table' });
    expect(table).toHaveTextContent('Q4 2024-');
    expect(container.textContent).not.toContain(EM_DASH);
  });

  it('counts the gaps once there are more than three', () => {
    render(
      <NavTrendCard
        points={[
          { periodEnd: '2024-03-31', value: null },
          { periodEnd: '2024-06-30', value: null },
          { periodEnd: '2024-09-30', value: null },
          { periodEnd: '2024-12-31', value: null },
          { periodEnd: '2025-03-31', value: '110000000.00' },
          { periodEnd: '2025-06-30', value: '125000000.00' },
        ]}
        heading="Trend"
        testId="nav"
      />,
    );
    expect(screen.getByRole('heading', { name: /^Trend/ })).toBeInTheDocument();
    expect(screen.getByTestId('nav-gaps')).toHaveTextContent(/^Not calculable for 4 quarters:/);
  });

  it('says there is no trend yet with fewer than two calculable quarters', () => {
    render(
      <NavTrendCard
        points={[
          { periodEnd: '2025-03-31', value: null },
          { periodEnd: '2025-06-30', value: '125000000.00' },
        ]}
        testId="nav"
        emptyTestId="nav-empty"
      />,
    );
    expect(screen.getByTestId('nav-empty')).toHaveTextContent('No NAV trend yet');
    expect(screen.queryByRole('group', { name: 'NAV by quarter' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-gaps')).not.toBeInTheDocument();
  });
});
