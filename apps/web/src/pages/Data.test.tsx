import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { mockApi, ok } from '../test/api-mock.js';
import { dataHealthFixture, principalFixture } from '../test/fixtures.js';
import { renderWithQuery } from '../test/render.js';
import { DataHealthPage } from './Data.js';

const gaps = {
  ...dataHealthFixture(),
  vehiclesWithOwnershipGap: [{ vehicleName: 'Beach Co-Invest Fund III', ownershipTotal: '0.75' }],
};

const renderAs = (roles: string[], health = gaps) => {
  mockApi({
    '/api/v1/auth/me': ok({ ...principalFixture(), roles }),
    '/api/v1/data-health': ok(health),
  });
  renderWithQuery(<DataHealthPage />);
};

describe('Data Health: client ownership', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a role that sees every client the vehicles whose ownership misses 100%, as a percentage', async () => {
    renderAs(['operations']);
    expect(
      await screen.findByText('Beach Co-Invest Fund III: ownership sums to 75.0%'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('ownership-not-checked')).not.toBeInTheDocument();
  });

  it('never shows a partial sum as a data error to a role entitled to some clients or none', async () => {
    for (const roles of [['viewer'], ['investor_relations'], ['deal_team', 'platform_admin']]) {
      renderAs(roles);
      expect(await screen.findByTestId('ownership-not-checked')).toHaveTextContent(
        'checked against 100% for operations, approvers and auditors',
      );
      expect(screen.queryByText(/ownership sums to/)).not.toBeInTheDocument();
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('says every closed vehicle sums to 100% when a full-view role finds no gap', async () => {
    renderAs(['auditor'], dataHealthFixture());
    expect(
      await screen.findByText("Every closed vehicle's LP ownership sums to 100%."),
    ).toBeInTheDocument();
  });
});
