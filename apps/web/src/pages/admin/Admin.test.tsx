import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { auditPage, healthReady, wallList } from '@pb/contracts';
import { AccessPage, AuditPage, HealthPage } from './Admin.js';
import { ROLE_ROWS } from './roles.js';
import {
  auditPageFixture,
  flagsFixture,
  healthReadyFixture,
  mockApi,
  mockUsersFixture,
  principalFixture,
  wallListFixture,
  withQueries,
} from '../assistants/test-support.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => (
    <a href={to}>{children as never}</a>
  ),
}));

const EM_DASH = String.fromCharCode(0x2014);

describe('audit trail page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('parses its fixture with the contract', () => {
    expect(() => auditPage.parse(auditPageFixture())).not.toThrow();
  });

  it('lists events with time, actor, action, entity, truncated id, reason and request id', async () => {
    mockApi({ '/api/v1/audit/events': { body: auditPageFixture() } });
    render(withQueries(<AuditPage />));
    const table = await screen.findByRole('table', { name: 'Audit events' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Jun 30, 2025 12:00:00 UTC');
    expect(rows[1]).toHaveTextContent('Admin One');
    expect(rows[1]).toHaveTextContent('flag.update');
    expect(rows[1]).toHaveTextContent('Enable the assistant for the demo');
    expect(rows[1]).toHaveTextContent('req-0042');
    expect(rows[2]).toHaveTextContent('system');
    const id = within(rows[2]!).getByTitle('10000000-0000-4000-8000-000000000031');
    expect(id).toHaveTextContent('10000000');
    expect(id.textContent).not.toContain('000000000031');
    expect(screen.getByTestId('audit-note')).toHaveTextContent('SEC-11.4');
    expect(screen.getByRole('navigation', { name: 'Admin' })).toHaveTextContent('Audit trail');
  });

  it('shows an empty state when there are no events', async () => {
    mockApi({ '/api/v1/audit/events': { body: auditPageFixture({ items: [] }) } });
    render(withQueries(<AuditPage />));
    expect(await screen.findByTestId('audit-empty')).toHaveTextContent('No events yet');
  });

  it('says who can see the trail on 403', async () => {
    mockApi({ '/api/v1/audit/events': { status: 403, title: 'Forbidden' } });
    render(withQueries(<AuditPage />));
    expect(await screen.findByTestId('audit-unavailable')).toHaveTextContent(
      'The audit trail is available to operations, approvers, auditors and platform admins',
    );
  });
});

describe('access and walls page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('parses its fixture with the contract', () => {
    expect(() => wallList.parse(wallListFixture())).not.toThrow();
  });

  it('renders a card per wall with members, records and the role table', async () => {
    mockApi({
      '/api/v1/walls': { body: wallListFixture() },
      '/api/v1/auth/me': { body: principalFixture() },
      '/api/v1/auth/mock-users': { body: mockUsersFixture() },
    });
    render(withQueries(<AccessPage />));
    const wall = await screen.findByTestId('wall-10000000-0000-4000-8000-000000000081');
    expect(wall).toHaveTextContent('Project Dune');
    expect(wall).toHaveTextContent('Restricted: named members only (SEC-5.3).');
    expect(within(wall).getByText('Deal Three')).toBeVisible();
    expect(within(wall).getByText('Head One')).toBeVisible();
    expect(within(wall).getByText('Dune Logistics')).toBeVisible();
    expect(within(wall).getByText('a record you cannot see')).toBeVisible();

    const table = screen.getByRole('table', { name: 'What each role sees' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(ROLE_ROWS.length + 1);
    for (const r of ROLE_ROWS) {
      expect(table).toHaveTextContent(r.role);
      expect(r.sees.includes(EM_DASH)).toBe(false);
      expect(r.sees.split(/[.!?]\s/).length).toBeLessThanOrEqual(2);
    }
    const ops = rows.find((row) => row.textContent?.includes('operations'))!;
    expect(await within(ops).findByText('Your role')).toBeVisible();
    expect(ops).toHaveTextContent('Prototype users: Ops One, Ops Two');
    expect(screen.getByTestId('role-source')).toHaveTextContent('matrix.test.ts');
  });

  it('says when no wall is visible', async () => {
    mockApi({
      '/api/v1/walls': { body: wallListFixture({ walls: [] }) },
      '/api/v1/auth/me': { body: principalFixture({ mockIdentity: false }) },
    });
    render(withQueries(<AccessPage />));
    expect(await screen.findByTestId('walls-empty')).toHaveTextContent(
      'No walls are visible to you',
    );
    expect(screen.getByRole('table', { name: 'What each role sees' })).toBeVisible();
  });
});

describe('integration health page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('parses its fixture with the contract', () => {
    expect(() => healthReady.parse(healthReadyFixture())).not.toThrow();
  });

  it('shows the checks with words, the version and the adapter kill switches', async () => {
    mockApi({
      '/health/ready': { body: healthReadyFixture() },
      '/api/v1/flags': { body: flagsFixture(false) },
    });
    render(withQueries(<HealthPage />));
    const checks = await screen.findByRole('table', { name: 'Readiness checks' });
    expect(within(checks).getAllByText('OK')).toHaveLength(2);
    expect(within(checks).getByText('Degraded')).toBeVisible();
    expect(checks).toHaveTextContent('adapter disabled by kill switch');
    expect(screen.getByText('version 0.1.0')).toBeVisible();
    expect(screen.getAllByText('Degraded').length).toBeGreaterThanOrEqual(2);

    const switches = await screen.findByRole('table', { name: 'Kill switches' });
    const rows = within(switches).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(switches).not.toHaveTextContent('ai.assistant');
    expect(rows[1]).toHaveTextContent('adapter.mail');
    expect(within(rows[1]!).getByText('Off')).toBeVisible();
    expect(within(rows[2]!).getByText('On')).toBeVisible();
  });

  it('shows an empty state when readiness is unavailable', async () => {
    mockApi({
      '/health/ready': { status: 503, title: 'Service unavailable' },
      '/api/v1/flags': { body: flagsFixture(false) },
    });
    render(withQueries(<HealthPage />));
    expect(await screen.findByTestId('health-unavailable')).toHaveTextContent(
      'Readiness is unavailable',
    );
    expect(await screen.findByRole('table', { name: 'Kill switches' })).toBeVisible();
  });
});
